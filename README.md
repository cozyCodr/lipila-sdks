# Lipila SDKs

Developer-friendly, provider-specific SDKs for the Lipila payment platform.

This is a community-maintained project, not an official Lipila package. The first implementation is the server-side JavaScript/TypeScript package [`@cozycodr/lipila`](sdks/javascript/README.md). Future language implementations will follow the same observable behavior while keeping idiomatic interfaces.

Documentation: **https://lipilasdk.oapps.dev**

```bash
npm install @cozycodr/lipila
```

## Supported operations

- Create mobile-money payments
- Create hosted card payments and surface redirect actions
- Retrieve payments by the merchant's `referenceId`
- Verify signed webhooks directly
- Optionally coordinate durable lifecycle handlers through the same client

The JavaScript SDK defaults to Lipila's sandbox. Production must be selected explicitly.

Lipila uses separate [sandbox](https://dashboard.lipila.dev) and [production](https://dashboard.lipila.io) merchant dashboards. Merchants must onboard separately and obtain environment-specific API keys and webhook configuration from each dashboard; a sandbox account or key does not carry into production.

## Repository layout

```text
spec/                 Language-neutral provider contract and fixtures
sdks/javascript/      JavaScript and TypeScript SDK
sdks/store-*/         Optional lifecycle store adapters and shared conformance modules
conformance/          Cross-language conformance guidance
examples/             Integration examples
```

Store adapters are optional and only needed for lifecycle handling:

- `@cozycodr/lipila-store-postgres` for durable, cross-process state (in preview).
- `@cozycodr/lipila-store-memory` for tests and local development.

Using a different database? Implement `PaymentLifecycleStore` and validate it with `@cozycodr/lipila-store-conformance`.

## Design principles

- Model Lipila faithfully instead of hiding it behind a multi-gateway abstraction.
- Keep secret-key clients server-side.
- Never automatically retry a collection creation after it may have reached Lipila.
- Keep status retries explicit and scoped to the individual read request.
- Keep direct controls and optional lifecycle automation on one configured client.
- Preserve provider-native statuses and unknown response fields for forward compatibility.
- Verify webhook signatures against the untouched request body before parsing JSON.
- Share safety behavior and fixtures across language implementations.

## Development

Requires Node.js 22 or newer.

```bash
npm install
npm run check
```

Read [BRANCHES.md](BRANCHES.md) and [AGENTS.md](AGENTS.md) before contributing. The language-neutral behavior every SDK follows is described in [spec/README.md](spec/README.md).

## Licence

[MIT](LICENSE). Free to use, modify and distribute, including commercially.

## Provider documentation

- [Lipila developer overview](https://docs.lipila.dev/docs/gettingstarted/overview.html)
- [Mobile-money collections](https://docs.lipila.dev/docs/collections/momocollections.html)
- [Collection status](https://docs.lipila.dev/docs/collections/collection-status.html)
- [Webhook security](https://docs.lipila.dev/docs/security/webhook-security.html)
- [Callback payloads](https://docs.lipila.dev/docs/billing/webhook.html)
