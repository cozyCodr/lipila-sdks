# Changelog

All notable changes are recorded here. Packages version independently; entries name the package they affect. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.1.0

First public release.

### `@cozycodr/lipila`

- Create mobile-money payments and hosted card payments.
- Retrieve and reconcile payments by your own `referenceId`.
- Verify webhook signatures against the raw request bytes: constant-time comparison, rotation-aware, with a five-minute freshness window.
- Optional lifecycle handling: durable payment state and `paid` / `failed` handlers on the same client.
- Payment-safety defaults: the sandbox is used unless production is selected explicitly, and an interrupted mutation is never retried automatically. You reconcile it by reference instead.
- `currency` is optional and defaults to `"ZMW"`. `"USD"` is also supported.

### Store adapters

- `@cozycodr/lipila-store-postgres`: durable, cross-process lifecycle store (preview).
- `@cozycodr/lipila-store-memory`: in-memory store for tests and local development.
- `@cozycodr/lipila-store-core`: shared types and helpers for building adapters.
- `@cozycodr/lipila-store-conformance`: a shared test suite to validate any custom `PaymentLifecycleStore`.
