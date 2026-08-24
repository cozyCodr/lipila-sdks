# Lifecycle storage and handlers

Lifecycle handling is an advanced preview. Direct payment creation, status retrieval and webhook verification do not require a store.

## What `store` means

`lifecycle.store` accepts an object implementing the exported `PaymentLifecycleStore` interface:

```ts
import type { PaymentLifecycleStore } from "@cozycodr/lipila";

declare const store: PaymentLifecycleStore;

const client = lipila({
  apiKey,
  webhookSecret,
  lifecycle: { store, on: handlers },
});
```

It does not accept any of these directly:

```ts
// None of these are a PaymentLifecycleStore:
store: process.env.DATABASE_URL
store: "postgresql://user:password@host/database"
store: databasePassword
store: pgPool
store: prisma
```

A database URL, pool or database client belongs inside a database-specific adapter that implements `PaymentLifecycleStore`. A preview PostgreSQL adapter is published, plus an in-memory adapter for tests. They are separate packages so the core SDK never installs unused database drivers. For any other database, see [Building a custom store](custom-store.md).

## Why persistence is required

Creation and completion occur in different HTTP requests and may execute in different application processes:

```text
Application creates payment
        ↓
Store reserves caller's referenceId
        ↓
Lipila returns Pending
        ↓
Application request ends or process restarts
        ↓
Lipila sends a webhook to another process
        ↓
Store maps provider identity to referenceId
        ↓
Store records paid/failed and deduplicates the webhook
        ↓
Configured handler runs
```

An in-memory object cannot provide this guarantee in production.

## Exact method contract

The SDK calls the adapter; application code does not normally call these methods.

### `prepare(intent)`

Called before a payment creation request is dispatched. `intent` contains the caller's `referenceId`, payment method, amount, currency and an SDK-generated request fingerprint.

The adapter atomically creates the reservation or returns the existing fingerprint and payment. A unique database constraint on `referenceId` is required.

### `release(intent)`

Called only when the SDK has definite evidence that provider dispatch did not start the payment, such as a non-ambiguous provider rejection. Delete the reservation only if both `referenceId` and `fingerprint` match.

### `record(observation)`

Stores a normalized payment observation from initiation, webhook handling or reconciliation. It must deduplicate observation IDs and prevent stale or intermediate states from replacing a final state.

### `resolve(transaction)`

Maps provider response identities—such as provider `referenceId` or `identifier`—back to the caller-created payment attempt. Return `null` rather than guessing when identity is ambiguous.

### `processWebhook(webhookId, work)`

Coordinates webhook processing across application processes. Claim the stable webhook ID atomically, run `work`, and mark it complete only after `work` succeeds. A failed or expired claim must be retryable. Do not mark the webhook complete before handlers finish.

Pass `work` a claim describing how it was acquired: `{ attempt: "first" }` when this call created the webhook record, and `{ attempt: "takeover" }` when it reclaimed a lease that had expired under another worker. The SDK uses this to tell a genuine retry from a concurrent takeover, so reporting it incorrectly will either drop or duplicate handler executions. Evaluate lease expiry using the database's clock rather than the application's.

### `record(observation)` and `prepare(intent)` together

`record` must reject an observation whose `referenceId` was never prepared, with a `conflict` failure. Adapters must not invent a reservation, because that would let the projection diverge from what the caller actually initiated.

### `get(referenceId)`

Returns the current local payment projection for the caller-created reference or `null`.

## Handler behavior

Handlers are registered once on the same Lipila client:

```ts
const client = lipila({
  apiKey,
  webhookSecret,
  lifecycle: {
    store,
    on: {
      actionRequired: async ({ payment }) => {
        console.log(payment.action?.url);
      },
      paid: async ({ payment, idempotencyKey }) => {
        await orders.fulfil(payment.referenceId, { idempotencyKey });
      },
      failed: async ({ payment }) => {
        await orders.markPaymentFailed(payment.referenceId);
      },
      reconciling: async ({ payment }) => {
        await reconciliationQueue.add(payment.referenceId);
      },
      unknown: async ({ payment }) => {
        await alerts.reportUnknownLipilaStatus(payment.rawStatus);
      },
    },
  },
});
```

Exactly one state-specific handler runs for each newly recorded observation. `changed` is a fallback when no handler exists for that state. The supplied idempotency key is stable for the payment reference and normalized state; business writes must enforce it uniquely.

### At-least-once webhook handlers

When a webhook handler throws, `handle()` rejects and the webhook is left unacknowledged, so your endpoint should reply with a retryable status (see [Express webhook integration](express-webhooks.md)) and Lipila redelivers. On redelivery the observation has already been recorded, so `record` reports a duplicate — but the SDK still re-runs the handler, because a webhook only completes after its handler succeeds. The result is at-least-once handler delivery: a handler may run more than once across retries, and it never silently fails to run.

The SDK distinguishes that retry from a concurrent takeover. `processWebhook` tells the SDK whether it acquired the claim as `first` (nobody else holds a lease — an existing observation therefore means a previous attempt failed and owes a retry) or as `takeover` (it reclaimed a lease that expired while another worker held it, and that worker may still be running). Handlers are re-run only on a `first` claim, so a handler that outlives its lease is not executed twice concurrently.

A handler that runs longer than the store's lease (`leaseMs`, 30 seconds by default) can still lose ownership of its claim. Set `leaseMs` above your slowest handler, and keep handlers idempotent using the supplied `idempotencyKey`.

The payment projection and the handler have separate lifetimes on purpose. Once Lipila reports a payment `paid`, that fact is durably recorded even if your handler is temporarily failing; it is the handler's external effect (fulfilment, email, ledger write) that retries. That is why the idempotency key exists — your business writes must enforce it uniquely.

The SDK coordinates delivery but cannot guarantee exactly-once external effects across a database commit and unrelated systems. Handlers must remain idempotent.
