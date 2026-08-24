# `@cozycodr/lipila-store-conformance`

Reusable checks for custom Lipila lifecycle store adapters.

Run the suite only against a disposable test deployment. Give each run a unique namespace and make the cleanup hook delete only records belonging to that namespace:

```ts
const testNamespace = `lipila:conformance:${crypto.randomUUID()}`;

paymentStoreConformance({
  createStore: () => postgresPaymentStore({ pool: testPool, namespace: testNamespace }),
  clearTestNamespace: () => deleteOnlyConformanceRows(testNamespace),
});
```

`clearTestNamespace` must never drop or truncate a database, schema, table or collection. Never run conformance against production.
