# Lipila SDK contract

This directory is the language-neutral source of truth for observable SDK behavior. TypeScript is the first implementation, not the specification.

Sandbox and production are separate merchant environments. Merchants onboard separately in both dashboards and use only the API key and webhook configuration issued by the matching environment.

## Operations in v0

### Create a mobile-money payment

- Send `POST /api/v1/collections/mobile-money` with `x-api-key`.
- Send required provider fields without renaming them: `referenceId`, `amount`, `narration`, `accountNumber`, and `currency`.
- Support `ZMW` only until another currency is verified.
- Send `callbackUrl`, when present, as an HTTP header.
- Treat `Pending`, `Successful`, and `Failed` as provider data; a `Failed` transaction is not an SDK failure.
- Do not retry automatically after dispatch. A network failure, timeout, HTTP 408/5xx, or malformed 2xx response has an unknown outcome and requires status reconciliation by the submitted `referenceId`.

### Create a hosted card payment

- Send `POST /api/v1/collections/card` with `x-api-key` and the optional `callbackUrl` header.
- Serialize the documented `customerInfo` and `collectionRequest` objects.
- Do not accept PAN, CVV or raw card credentials; Lipila's hosted page owns card entry.
- Treat a non-empty `cardRedirectionUrl` as an opaque customer redirect action, not payment success.
- Preserve the caller's submitted reference separately from all returned identity fields.
- Apply the same no-mutation-retry and unknown-outcome rules as mobile money.
- Treat `accountNumber`, `backUrl` and identity semantics as provisional, and preserve the full provider response so callers can adapt.

### Retrieve collection status

- Send `GET /api/v1/collections/check-status?referenceId=...` with `x-api-key`.
- Make one request by default. Retry only when the caller explicitly opts in on that read request, with a bounded attempt count.
- Treat transport failures, HTTP 408/429/5xx, and malformed 2xx responses as transient.
- Respect `Retry-After` but cap provider-directed waiting.
- Do not retry request/authentication/not-found failures, even when retry is enabled.

### Verify a webhook

- Accept untouched UTF-8 bytes or the exact untouched string.
- Read header names case-insensitively.
- Sign `{webhook-id}.{webhook-timestamp}.{raw-body}` with HMAC-SHA256.
- Accept space-separated `v1,<base64>` signatures and overlapping 32-byte base64 secrets.
- Use constant-time digest comparison and a five-minute timestamp tolerance.
- Verify before parsing JSON.
- Preserve the stable webhook ID for caller-managed deduplication.
- Classify verified flat transactions and `{ type, data }` envelopes while preserving unknown payloads.

### Optional lifecycle behavior

- Use the same `payments` and `webhooks` resources as direct-control callers; lifecycle is activated only by client configuration.
- Reserve the merchant reference in a durable store before mutation dispatch.
- Reject reuse of one reference with different immutable payment details.
- Classify one state per observation: `pending`, `action_required`, `paid`, `failed`, `reconciling` or `unknown`.
- Invoke centrally registered handlers from initiation, verified webhook or explicit reconciliation.
- Require the store adapter to resolve conflicting provider identities conservatively and deduplicate webhook IDs atomically.
- Return an explicit in-progress result when another worker owns a live webhook lease; only completed webhook IDs are duplicates.
- Require lifecycle stores to declare the current store protocol version so incompatible adapters fail during client construction.
- Do not acknowledge a verified webhook that cannot be associated safely with a prepared payment.
- Make handler errors distinct from known provider payment outcomes.
- Never promise exactly-once application effects; provide a stable idempotency key to handlers.
- Create no hidden polling, timers, workers or in-memory lifecycle callbacks.

## Compatibility rules

- Preserve unrecognized transaction status strings.
- Preserve the complete provider object as a raw map.
- Keep the caller's submitted reference distinct from provider-returned identifiers.
- Expose structured error code, operation, outcome certainty, and safe next action.
- Never log, serialize into errors, or return API keys and webhook secrets.

## Evidence

Behavior here is grounded in Lipila's public documentation and conservative, safety-first implementation decisions. Fixtures under [fixtures](fixtures) must be synthetic, redacted sandbox captures, or provider-confirmed examples with their provenance recorded.
