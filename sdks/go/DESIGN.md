# Go SDK design

This document records the architectural decisions behind the Go SDK. The behavioral
contract lives in the [`spec/` directory of the SDK
monorepo](https://github.com/cozyCodr/lipila-sdks/tree/main/spec) and is language neutral; this file
covers only how that contract maps onto Go. Read it before changing the public API.

## Goals

1. The same payment-safety guarantees as the JavaScript SDK: mutations are never
   retried automatically, interrupted mutations surface as unknown outcomes that
   are reconciled by `referenceId`, and webhooks are verified against raw bytes in
   constant time before any JSON parsing.
2. An API that reads like Go, not like transliterated TypeScript.
3. A dependency-free core. The module imports only the standard library.

## Decision log

### D1: a thin public package over `internal/` layers

Callers import exactly one package, `lipila`, so usage stays `lipila.New` and
`lipila.Error`. The machinery lives in `internal/` packages grouped by
responsibility, which the Go compiler enforces as private to this module:

| Package | Responsibility |
| --- | --- |
| `lipila` (root) | Public API surface: Config, Client, services, result types |
| `internal/fault` | The error model: codes, outcomes, the three error types |
| `internal/wire` | The Transaction type and tolerant provider-body decoding |
| `internal/validate` | Caller input validation, including URL safety rules |
| `internal/transport` | Request execution, provider error mapping, retry pacing |
| `internal/signature` | Webhook secret decoding and constant-time HMAC checks |

Types that appear in the public API (`Error`, `Transaction`, and their
companions) are defined once in the internal packages and re-exported from the
root through type aliases, so internal packages can share them without an
import cycle and `errors.As` works identically on both spellings. Policy stays
in the root package (outcome classification in `payments.go`, webhook header
and timestamp rules in `webhooks.go`); the internal packages hold mechanism.

Lifecycle store adapters, when they arrive, become separate sub-modules
(`store/postgres`, `store/memory`) so their database dependencies never taint
the core module's dependency graph.

### D2: `New` returns `(*Client, error)`

Configuration problems (empty key, malformed webhook secret) are programmer errors,
but Go libraries do not panic on bad input and do not defer validation to the first
request. `New` validates everything eagerly, exactly like `resolveConfig` in the
JavaScript SDK, and returns a `*Error` with `CodeConfiguration` so a malformed
webhook secret fails at startup rather than on the first live webhook.

### D3: `context.Context` replaces both `signal` and `timeoutMs`

Every request-making method takes a `context.Context` first. Cancellation and
deadlines are the caller's concern, expressed the way Go callers already express
them. `Config.Timeout` (default 15s) is applied per attempt only when the caller's
context carries no deadline of its own; a caller deadline always wins. There is no
per-call timeout option because `context.WithTimeout` is that option.

### D4: one `Error` type plus typed extractions, not an error class tree

JavaScript models outcomes as an error class hierarchy. In Go the idiomatic
equivalent is a single `*Error` carrying structured fields (`Code`, `Operation`,
`Outcome`, `NextStep`, `HTTPStatus`, `ProviderCode`, `RetryAfter`) and dedicated
types only where the caller must branch on extra data:

- `*UnknownOutcomeError` wraps the ambiguous-mutation case and carries the
  submitted `ReferenceID` so reconciliation code can be written directly from
  `errors.As`.
- `*WebhookVerificationError` carries the machine-readable `Reason` so handlers
  can distinguish a stale timestamp from a bad signature.

Both types wrap an underlying `*Error` and support `errors.As`/`errors.Is`.
Error messages never contain the API key, the webhook secret, header values, or
raw request bodies.

### D5: amounts stay `float64`, provider-native

Lipila's API exchanges JSON numbers and the contract forbids the SDK from rounding
or reformatting amounts. `float64` is the honest representation of "the JSON number
we will send". Response amounts are additionally preserved inside `Transaction.Raw`
untouched. A decimal type would imply precision guarantees Lipila has not
documented.

### D6: tolerant response parsing with `Raw` preserved

`Transaction` decodes the fields the contract lists and keeps the entire provider
body as `Raw json.RawMessage`. Only `status` is required to be a non-empty string;
every other field is optional because Lipila's examples are inconsistent about
presence (see the provider contract, section 2.4). Unknown statuses pass through
verbatim and are never collapsed into a failure.

### D7: mutation ambiguity is a type, not a status check

`Create` requests classify exactly like the JavaScript SDK:

| Observation | Result |
| --- | --- |
| Transport error after dispatch may have occurred | `*UnknownOutcomeError` |
| HTTP 408 or any 5xx | `*UnknownOutcomeError` |
| Other non-2xx | `*Error` with `Outcome: OutcomeNotStarted` |
| 2xx with unreadable body | `*UnknownOutcomeError` |
| 2xx with a transaction body | success, even when `status` is `Failed` |

A transaction-shaped business failure on a 2xx resolves normally; thrown errors are
reserved for transport, validation, and authentication problems.

### D8: status reads retry only by explicit opt-in

`Retrieve` performs one GET. `RetrieveOptions.MaxAttempts` (2 through 6) enables
bounded retries with exponential backoff for 408, 429, 5xx, and transport faults,
honoring `Retry-After` when the server sends it. This mirrors the JavaScript
`retry.maxAttempts` contract.

### D9: webhook verification takes `[]byte` and `http.Header`

`Webhooks.Verify(rawBody, header)` accepts the raw body bytes and the standard
`http.Header`, which is what every Go HTTP framework can hand over without
re-serialization. The verifier enforces the full documented scheme: HMAC-SHA256
over `{id}.{timestamp}.{body}` with the base64-decoded 32-byte secret, `v1,`
prefixed signatures, multiple space-delimited signatures, multiple configured
secrets for rotation, a 300 second timestamp tolerance, a rejected `.` inside
`webhook-id`, and bounded header lengths. Comparison uses `hmac.Equal`. JSON is
parsed only after the signature validates.

### D10: injectable `HTTPClient`, no custom transport layer

`Config.HTTPClient` accepts any `*http.Client`. The zero value uses a private
default client (not `http.DefaultClient`, whose global mutability would let an
unrelated package alter SDK behavior). Tests use `httptest.Server`; no transport
interface is invented on top of what `net/http` already provides.

### D11: versioning and publishing

Development happens at `sdks/go` inside the internal monorepo, but the public
home is the dedicated repository `github.com/cozyCodr/lipila-go`: Go installs
modules straight from git paths, so a dedicated repository gives the clean
import path and plain `vX.Y.Z` tags instead of `sdks/go/vX.Y.Z`. The module
path in `go.mod` therefore names the public repository, and the publish flow
snapshots this directory to that repository's root before tagging. The module
requires the oldest Go release the standard library usage allows rather than the
newest available, so downstream users are not forced to upgrade toolchains.

## Non-goals for v0.1.0

- Lifecycle store adapters (protocol version 2). The interface will be added in a
  later minor version together with the postgres adapter, mirroring the
  JavaScript rollout.
- Disbursements, refunds, and any endpoint the spec does not yet cover.
- Automatic phone-number normalization. The provider contract explicitly forbids
  inferring the mobile network client-side, and Lipila rejects non-international
  formats itself with a 400.
