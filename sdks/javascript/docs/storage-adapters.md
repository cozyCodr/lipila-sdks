# Database adapter setup

Lifecycle state is optional. Direct creation, retrieval and webhook verification need only `@cozycodr/lipila`. If you enable lifecycle handlers, install exactly one store adapter and pass the completed store object to `lipila`.

PostgreSQL is the only published database adapter. It is a preview package until its real-engine concurrency, crash and migration release gates pass. Exercise it against Lipila sandbox and a non-production database first.

Adapters for MongoDB, MySQL/MariaDB and Cassandra exist in the repository but are not published, because none of their queries has been exercised against a real engine. Until they run the shared conformance suite against their database, use PostgreSQL or write a [custom store](custom-store.md).

## PostgreSQL

```sh
npm install @cozycodr/lipila @cozycodr/lipila-store-postgres pg
```

```ts
import { lipila } from "@cozycodr/lipila";
import { postgresPaymentStore } from "@cozycodr/lipila-store-postgres";

const store = postgresPaymentStore({
  connectionString: process.env.DATABASE_URL!,
  namespace: "lipila:sandbox:merchant-123",
});
await store.migrate();

const client = lipila({
  apiKey: process.env.LIPILA_SANDBOX_API_KEY!,
  webhookSecret: process.env.LIPILA_SANDBOX_WEBHOOK_SECRET!,
  lifecycle: { store, on: handlers },
});
```

You may pass an existing `pg.Pool` as `pool` instead. Pass one connection option, never both. `close()` closes only an adapter-created pool.

## Not yet published

The MongoDB, MySQL/MariaDB and Cassandra adapters are present in the repository but marked private, so they cannot be installed from npm. They are withheld deliberately: no query in them has ever run against a real database, so their concurrency and migration behaviour is unverified. Follow the repository for their release.

## In-memory tests

```sh
npm install --save-dev @cozycodr/lipila-store-memory
```

```ts
const store = memoryPaymentStore({ namespace: "test" });
```

This adapter loses all state on process exit and cannot coordinate multiple processes. Never use it for production payments.

## Namespace and migrations

Use a different namespace for every Lipila merchant and environment, for example:

- `lipila:sandbox:merchant-123`
- `lipila:production:merchant-123`

Call `migrate()` during a controlled deployment or startup step before accepting payment traffic. Constructors and payment methods never change schema implicitly. Call `close()` during application shutdown; caller-owned clients and pools remain open.
