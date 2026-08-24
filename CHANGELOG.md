# Changelog

All notable changes to the packages in this repository are recorded here. Packages version independently; entries name the package they affect.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Nothing in this repository has been published to npm yet, so everything below is pre-release and no migration path is owed to released consumers.

## Unreleased

### Fixed — payment safety

- **`@cozycodr/lipila`: a failed webhook handler is no longer skipped on redelivery.** Store adapters deduplicate observations by webhook id, and that record commits independently of webhook completion. A handler that threw therefore left the observation recorded, so the redelivery reported a duplicate, the handler never re-ran, and the endpoint acknowledged anyway — silently losing fulfilment. Handlers now re-run when a redelivery arrives under a fresh claim.
- **`@cozycodr/lipila`: a slow webhook handler is no longer executed twice concurrently.** Distinguishing a retry from a lease takeover is not possible from the store's duplicate status alone. `PaymentLifecycleStore.processWebhook` now tells the SDK whether the claim was acquired as `first` or `takeover`, and handlers re-run only on `first`.
- **`@cozycodr/lipila-store-memory`: `release()` now refuses to delete a payment that is no longer `reconciling`,** matching every database adapter. Previously a late release could delete an already-paid payment, after which `prepare()` reported `created` and the same order could be charged again.
- **`@cozycodr/lipila-store-cassandra`: `release()` no longer races a concurrent settlement.** The state check was performed in application code while the delete guarded only the fingerprint. The delete now also guards the row version read alongside the state.
- **`@cozycodr/lipila-store-mongodb`: `prepare()` is now atomic.** MongoDB creates collections implicitly, so without `migrate()` two concurrent upserts could each report `created` and each dispatch a payment. `prepare()` now requires the unique index and resolves duplicates through `E11000`.
- **`@cozycodr/lipila-store-mysql`: `record()` no longer raises false identity conflicts** under REPEATABLE READ, and `prepare()` no longer masks truncation or charset errors behind `INSERT IGNORE`.
- **`@cozycodr/lipila-store-core`: an unrecognized payment state can no longer wedge a payment** so that no further observation applies.

### Fixed — security

- **`@cozycodr/lipila`: the API key can no longer leak into logs.** A key containing a character illegal in an HTTP header made the fetch implementation throw an error embedding the key, which then travelled in the error `cause` chain. Keys are now validated as printable ASCII at construction, and the value never appears in the message.
- **`@cozycodr/lipila`: `callbackUrl` and `backUrl` are normalized before transmission.** `new URL()` silently strips tabs and newlines, so a CRLF-laced URL could validate and still carry control characters into a header. Control characters and embedded credentials are now rejected, and the normalized `href` is sent.
- **`@cozycodr/lipila`: one malformed webhook secret can no longer block verification with a valid one.** Secrets are decoded once at construction and reported as a configuration error.
- **`@cozycodr/lipila`: `webhook-id` may no longer contain a period,** which made the signed `{id}.{timestamp}.{body}` message ambiguous. Webhook id and signature header lengths are now bounded.
- **`@cozycodr/lipila`: a server-supplied `Retry-After` is clamped** to the SDK's own backoff ceiling.
- **`@cozycodr/lipila`: header lookup is brand-checked** rather than duck-typed on `.get`, so an inherited `get` cannot satisfy every header read.
- **`@cozycodr/lipila-store-*`: adapters validate that keys are bounded strings** at their public boundary, closing an operator-injection surface in the MongoDB adapter for callers using it directly.

### Changed — breaking

- **`PaymentLifecycleStore.protocolVersion` is now `2`.** `processWebhook` passes its `work` callback a `WebhookClaim` describing how the claim was acquired. Custom store implementations must update; the SDK rejects a version-1 adapter at construction rather than failing silently.
- **`@cozycodr/lipila-store-memory`: `record()` now rejects an observation for a reference that was never prepared,** with a `conflict` failure, matching every database adapter. Previously this succeeded in memory and threw in production.
- **`@cozycodr/lipila`: `callbackUrl` and `backUrl` must use HTTPS,** except for loopback hosts during local development.
- **`@cozycodr/lipila`: `lipila()` throws a `configuration_error` for a malformed `apiKey` or `webhookSecret`** instead of surfacing the problem on the first request. Secrets are trimmed first, so a trailing newline from a mounted secret file is accepted.
- **`@cozycodr/lipila`: the `"invalid_secret"` webhook failure reason is no longer produced.** Malformed secrets surface as a `configuration_error` from `lipila()`.
- **`@cozycodr/lipila-store-conformance`: `vitest` moved from a dependency to a peer dependency,** so installing the package no longer pulls a second copy of the test runner into the tree.

### Added

- **`@cozycodr/lipila`: `currency` is optional and defaults to `"ZMW"`.** The exported `LipilaCurrency` type keeps the documented `ZMW` and `USD` discoverable while accepting any ISO-4217-shaped code.
- **`@cozycodr/lipila`: a `get_payment` operation label** for errors raised by `payments.get()`.
- **`@cozycodr/lipila-store-conformance`: cases covering claim reporting, the release state guard, and observations for unprepared references,** so every adapter is held to these behaviours.
- **`@cozycodr/lipila-store-postgres`: an integration suite** that runs the shared conformance suite against a live PostgreSQL instance in an isolated namespace, plus SDK-level lifecycle coverage — handler retry after failure, no re-run on lease takeover, and duplicate acknowledgement — exercised through the real client against real transactions and row locks.
- Repository `SECURITY.md`, Dependabot configuration, and a production dependency audit in CI.
- **MIT licence** for the repository and every package.

### Changed — distribution

- **PostgreSQL is the only published database adapter.** `@cozycodr/lipila-store-mongodb`, `@cozycodr/lipila-store-mysql` and `@cozycodr/lipila-store-cassandra` are marked private and are not published. Their code remains in the repository, but no query in them has been executed against a real engine, so their concurrency and migration behaviour is unverified. They stay private until they run the shared conformance suite against their database in CI.

### Fixed — documentation

- The webhook section no longer describes the five-minute window as a "replay window". It bounds freshness; `verify()` does not deduplicate.
- Card `referenceData` is documented as required, matching Lipila's card endpoint. The previous release incorrectly generalized the mobile-money endpoint's optionality to cards.
- Lifecycle documentation records the at-least-once handler guarantee, the lease's role, and the requirement that adapters evaluate expiry using the database clock.
