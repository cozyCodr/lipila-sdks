# `@cozycodr/lipila`

Server-side JavaScript and TypeScript SDK for Lipila mobile-money and hosted card payments.

> This community-maintained package is not affiliated with or endorsed by Lipila. Exercise it against the sandbox before processing production payments.

## Installation

The implementation is currently unreleased. After the first release:

```bash
npm install @cozycodr/lipila
```

Node.js 22 or newer is required. Never expose an API key or webhook secret in browser code.

## Before you start: create both Lipila accounts

Lipila operates separate merchant dashboards for its two environments:

- [Sandbox dashboard](https://dashboard.lipila.dev) for development and testing
- [Production dashboard](https://dashboard.lipila.io) for live payments

You must onboard separately in both dashboards. The accounts, API keys, webhook configuration and webhook secrets are environment-specific; creating a sandbox account does not automatically create the production account. Generate the sandbox key in the sandbox dashboard and the production key in the production dashboard. Never use one environment's key with the other environment.

See [Getting started](docs/getting-started.md) for the complete setup checklist.

## One client

```ts
import { lipila } from "@cozycodr/lipila";

const client = lipila({
  apiKey: process.env.LIPILA_API_KEY!,
  environment: "sandbox", // default; production must be explicit
  webhookSecret: process.env.LIPILA_WEBHOOK_SECRET,
});
```

The same client supports direct provider control and optional lifecycle behavior. There is no second wrapper or workflow client.

`environment: "sandbox"` sends requests to `https://api.lipila.dev`; `environment: "production"` sends them to `https://blz.lipila.io`. Keep separate environment variables for their keys.

## Mobile money

```ts
const result = await client.payments.mobileMoney.create({
  referenceId: "order-1001",
  amount: 125.5,
  narration: "Payment for order 1001",
  accountNumber: "260971234567",
  callbackUrl: "https://merchant.example/webhooks/lipila",
});

console.log(result.submittedReferenceId);
console.log(result.payment.status); // Pending, Successful, Failed, or a future value
```

A returned `Failed` status is a normal payment result, not an SDK exception.

## Hosted card payment

The SDK sends customer and payment information to Lipila, then returns Lipila's hosted checkout URL. It never accepts PAN or CVV.

```ts
const result = await client.payments.card.create({
  referenceId: "order-1002",
  amount: 250,
  narration: "Payment for order 1002",
  accountNumber: "customer-1002",
  currency: "ZMW",
  customer: {
    firstName: "Jane",
    lastName: "Doe",
    phoneNumber: "260971234567",
    email: "jane@example.com",
    city: "Lusaka",
    country: "ZM",
    address: "Plot 10",
    zip: "10101",
  },
  backUrl: "https://merchant.example/checkout/return",
  referenceData: "cart-1002",
  callbackUrl: "https://merchant.example/webhooks/lipila",
});

if (result.action?.type === "redirect") {
  return { redirectUrl: result.action.url };
}
```

`action.type === "redirect"` means customer action is required. It does not mean the payment succeeded. Treat the URL as opaque and use a verified webhook or explicit reconciliation for the durable final outcome.

Card field semantics such as `accountNumber`, request nesting, return behavior and transaction identity can vary. The SDK follows Lipila's documented request shape and always preserves the complete provider response at `result.payment.raw`.

## Retrieve payment status

```ts
const payment = await client.payments.retrieve("order-1001");
```

One request is made by default. Read retry is explicit:

```ts
const payment = await client.payments.retrieve("order-1001", {
  retry: { maxAttempts: 3 },
});
```

When enabled, retry handles transport failures, HTTP 408/429/5xx and malformed successful responses. `maxAttempts` includes the first request and must be from 2 through 6. Creation never accepts a retry option.

## Verify webhooks directly

Pass the untouched request bytes. Do not parse and reserialize the body first.

```ts
const event = client.webhooks.verify({
  rawBody: requestBodyBuffer,
  headers: request.headers,
});

if (event.shape === "transaction") {
  console.log(event.transaction.status);
}
```

Verification checks `webhook-id`, `webhook-timestamp` and `webhook-signature` using HMAC-SHA256, constant-time comparison and a five-minute freshness window. Multiple configured secrets support rotation overlap.

`verify()` does not deduplicate. The freshness window bounds how old an event may be; it does not stop the same signed event being presented more than once inside that window. Persist each `event.id` and ignore ones you have already processed, or use `handle()` with a lifecycle store, which deduplicates for you.

## Opt in to lifecycle handling

Add `lifecycle` to the same client when you want the SDK to coordinate durable state and handlers:

> Lifecycle handling is optional and currently in preview. `store` must be an object implementing the exported `PaymentLifecycleStore` interface. It is **not** a bare connection string, database URL, password, pool or ORM client. Install the adapter package for your database and use its constructor.

```ts
const client = lipila({
  apiKey: process.env.LIPILA_API_KEY!,
  webhookSecret: process.env.LIPILA_WEBHOOK_SECRET!,

  lifecycle: {
    store,
    on: {
      paid: async ({ payment, idempotencyKey }) => {
        await orders.fulfil(payment.referenceId, { idempotencyKey });
      },
      failed: async ({ payment }) => {
        await orders.markPaymentFailed(payment.referenceId);
      },
      reconciling: async ({ payment }) => {
        await reconciliationQueue.add(payment.referenceId);
      },
    },
  },
});
```

The creation calls remain unchanged. With lifecycle enabled, they additionally:

- reserve the merchant reference before provider dispatch;
- reject the same reference with different immutable details;
- record the immediate `pending`, `action_required`, `failed`, `paid` or unknown state;
- record interrupted or ambiguous creation as `reconciling`;
- invoke at most one matching state handler, falling back to `changed` when configured.

Available optional handlers are `pending`, `actionRequired`, `paid`, `failed`, `reconciling`, `unknown` and `changed`.

### Handle the eventual webhook

```ts
app.post("/webhooks/lipila", rawBodyMiddleware, async (request, response) => {
  const receipt = await client.webhooks.handle({
    rawBody: request.body,
    headers: request.headers,
  });

  response.sendStatus(receipt.acknowledge ? 204 : 500);
});
```

`handle` verifies first, asks the store to associate provider identity with the merchant payment, processes each webhook ID once, records the observation and invokes the same handler registry. An unresolved webhook or one with a live lease owned by another worker returns `acknowledge: false`; only completed duplicates are safe to acknowledge.

### Reconcile explicitly

```ts
const payment = await client.payments.reconcile("order-1001", {
  retry: { maxAttempts: 3 },
});
```

Reconciliation is explicit. It feeds a status read through the same durable state and handler path. The SDK creates no timers, polling workers or in-memory callbacks.

```ts
const localPayment = await client.payments.get("order-1001");
```

`get` reads the lifecycle store and makes no provider request.

## Lifecycle store contract

`PaymentLifecycleStore` is a durability adapter, not a CRUD repository. Its implementation must:

- atomically reserve `referenceId` in `prepare`;
- release only a definitely unstarted request in `release`;
- record observations without allowing final state to regress;
- map provider response identities back to the submitted merchant reference in `resolve`;
- process one webhook ID atomically with a retryable lease in `processWebhook`;
- checkpoint completion only after the supplied work succeeds;
- return the local projection from `get`.

An in-memory implementation is suitable only for tests. Business handlers must enforce the supplied `idempotencyKey`; no SDK can promise exactly-once external side effects across process crashes.

Read [Payment references](docs/payment-references.md) before choosing `referenceId`, then see [Database adapters](docs/storage-adapters.md), [Lifecycle storage](docs/lifecycle-storage.md) and [Building a custom store](docs/custom-store.md) for setup and required database behavior.

## Guides

- [Getting started](docs/getting-started.md)
- [Payment references and multiple attempts](docs/payment-references.md)
- [Lifecycle storage and handlers](docs/lifecycle-storage.md)
- [Database adapter setup](docs/storage-adapters.md)
- [Building a custom store](docs/custom-store.md)
- [Express webhook integration](docs/express-webhooks.md)

## Unknown creation outcomes

```ts
import { LipilaUnknownOutcomeError } from "@cozycodr/lipila";

try {
  await client.payments.mobileMoney.create(input);
} catch (error) {
  if (error instanceof LipilaUnknownOutcomeError) {
    // Never submit the payment again blindly.
    await client.payments.retrieve(error.referenceId);
  }
}
```

A timeout, disconnect, HTTP 408/5xx or unreadable successful response means Lipila may have received the mutation. The SDK dispatches creation exactly once and reports `nextStep: "reconcile_by_reference"`.

## Configuration

```ts
const client = lipila({
  apiKey: "...",          // required
  environment: "sandbox", // sandbox | production; default sandbox
  webhookSecret: "...",  // base64 32-byte secret or an array during rotation
  timeoutMs: 15_000,      // positive integer; default 15 seconds
  lifecycle: { store, on },
  fetch: customFetch,      // advanced adapter; defaults to global fetch
});
```

Every network operation accepts `{ signal, timeoutMs }` as its last argument.

## Response compatibility

Unknown statuses and fields are preserved. `submittedReferenceId` remains separate because Lipila's documentation conflicts about the meanings of response `referenceId` and `identifier`.
