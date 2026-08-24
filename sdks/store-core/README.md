# `@cozycodr/lipila-store-core`

Shared types and helpers for building durable lifecycle store adapters for the [Lipila SDK](https://github.com/cozyCodr/lipila-sdks). You do not install this directly; it is a dependency of the store adapters (for example `@cozycodr/lipila-store-postgres`) and of anyone writing a custom adapter.

It provides the `ManagedPaymentStore` shape, the store protocol version, adapter error types, and the state-machine and validation helpers (`shouldApplyPayment`, `validateNamespace`, `validateIdentifier`, `assertJsonSize`, `parseStoredPayment`, and related utilities) that every adapter shares.

To verify a custom adapter, run it against [`@cozycodr/lipila-store-conformance`](https://www.npmjs.com/package/@cozycodr/lipila-store-conformance).

This is a community project and is not affiliated with Lipila. MIT licensed.
