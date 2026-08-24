# Building a custom lifecycle store

This guide is for developers implementing `PaymentLifecycleStore` against PostgreSQL, MySQL, DynamoDB or another durable database. It is not required when using only direct SDK controls.

## What the application passes

The application constructs an adapter using its own database dependency, then passes the completed adapter object to Lipila:

```ts
const store = new MyPostgresLipilaStore({
  pool,
  namespace: "sandbox:merchant-123",
});

const client = lipila({
  apiKey,
  webhookSecret,
  lifecycle: { store, on: handlers },
});
```

Here `pool` and the merchant/environment namespace are inputs to the developer's adapter constructor. `store` is the resulting `PaymentLifecycleStore` object. Lipila never receives the connection string or password separately.

## Suggested relational schema

Adapt names and JSON types to the chosen database:

```sql
CREATE TABLE lipila_payments (
  id UUID PRIMARY KEY,
  namespace TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  method TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  currency TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT,
  raw_status TEXT,
  transaction_json JSONB,
  provider_reference_id TEXT,
  provider_identifier TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (namespace, reference_id)
);

CREATE UNIQUE INDEX lipila_provider_reference_unique
  ON lipila_payments (namespace, provider_reference_id)
  WHERE provider_reference_id IS NOT NULL;

CREATE UNIQUE INDEX lipila_provider_identifier_unique
  ON lipila_payments (namespace, provider_identifier)
  WHERE provider_identifier IS NOT NULL;

CREATE TABLE lipila_webhooks (
  namespace TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  status TEXT NOT NULL,
  lease_expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 1,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  PRIMARY KEY (namespace, webhook_id)
);

CREATE TABLE lipila_payment_observations (
  namespace TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  source TEXT NOT NULL,
  payment_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (namespace, observation_id)
);
```

Every query must include the configured namespace. This prevents references, provider identities and webhook IDs from colliding when sandbox, production or multiple Lipila merchants share one database.

## TypeScript skeleton

```ts
import type {
  LipilaPaymentTransaction,
  Payment,
  PaymentIntent,
  PaymentLifecycleStore,
  PaymentObservation,
  PreparePaymentResult,
  RecordPaymentResult,
  WebhookProcessingResult,
} from "@cozycodr/lipila";

export class MyPostgresLipilaStore implements PaymentLifecycleStore {
  readonly protocolVersion = 1 as const;

  constructor(
    private readonly options: {
      pool: ApplicationDatabase;
      namespace: string;
    },
  ) {}

  async prepare(intent: PaymentIntent): Promise<PreparePaymentResult> {
    // Atomically INSERT by referenceId, or read the conflicting row.
    throw new Error("implement with a database transaction");
  }

  async release(intent: PaymentIntent): Promise<void> {
    // DELETE only WHERE reference_id = ? AND fingerprint = ?.
    throw new Error("implement with a database transaction");
  }

  async record(observation: PaymentObservation): Promise<RecordPaymentResult> {
    // Deduplicate observation.id and enforce allowed state progression.
    throw new Error("implement with a database transaction");
  }

  async resolve(transaction: LipilaPaymentTransaction): Promise<Payment | null> {
    // Match trusted provider identities uniquely; never pick an arbitrary row.
    throw new Error("implement with a database query");
  }

  async processWebhook<T>(
    webhookId: string,
    work: () => Promise<T>,
  ): Promise<WebhookProcessingResult<T>> {
    // Return in_progress while another live lease exists, duplicate only after completion.
    // Mark complete only after work succeeds.
    throw new Error("implement with a retryable lease");
  }

  async get(referenceId: string): Promise<Payment | null> {
    // Read the normalized local projection.
    throw new Error("implement with a database query");
  }
}
```

This skeleton is intentionally not a production PostgreSQL adapter. Database transaction semantics, lock behavior and JSON mapping must be implemented and tested for the chosen client.

## Required invariants

- `referenceId` is unique within the relevant merchant account and environment.
- A reference cannot be reused with a different fingerprint.
- Observations are idempotent by observation ID.
- Final `paid` or `failed` state cannot regress to `pending`.
- Provider identities resolve to at most one merchant payment.
- Only one live webhook worker owns a webhook lease; contenders return `in_progress` and are not acknowledged.
- Handler failure leaves the webhook retryable.
- Completion is checkpointed only after `work` succeeds.
- API keys, webhook secrets and database credentials are never stored in payment rows or error messages.

The separate preview adapter packages hide this implementation behind constructors such as `postgresPaymentStore({ connectionString, namespace })`. Custom stores can run the reusable `@cozycodr/lipila-store-conformance` suite against a real database deployment.
