# `@cozycodr/lipila-store-postgres`

Preview PostgreSQL adapter for Lipila lifecycle state. Install it with its peer driver:

```sh
npm install @cozycodr/lipila-store-postgres pg
```

```ts
import { postgresPaymentStore } from "@cozycodr/lipila-store-postgres";

const store = postgresPaymentStore({
  connectionString: process.env.DATABASE_URL!,
  namespace: "lipila:sandbox:merchant-123",
});
await store.migrate();
```

Pass either `connectionString` or an existing `pg.Pool`, never both. `close()` closes only a pool created from `connectionString`; caller-owned pools remain open. Migrations are explicit, repeatable, forward-only, and never run during payment handling.

This adapter is in preview. Exercise it against a non-production database before you rely on it.

Webhook leases expire on the database clock, not the application's, so a worker with a skewed clock cannot take over a lease that is still live. The default lease is 30 seconds; set `leaseMs` above your slowest webhook handler.

## Test against PostgreSQL

The suite skips unless `LIPILA_POSTGRES_TEST_URL` is set. It uses a unique namespace per run and deletes only rows in that namespace. It never drops a database, schema, or table.

```sh
LIPILA_POSTGRES_TEST_URL='postgresql://postgres:your-password@127.0.0.1:5432/lipila_test' \
  npm run test:integration -w @cozycodr/lipila-store-postgres
```

It runs the shared conformance suite and lifecycle checks against your database, covering real transactions, row locks, and database-clock lease expiry that the in-memory adapter cannot reproduce.
