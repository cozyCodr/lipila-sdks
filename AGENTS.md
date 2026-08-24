# Repository guide

Community-maintained, provider-specific SDKs for the Lipila payments platform. This is an independent project and is not made by, affiliated with, or endorsed by Lipila.

## Working here

- Node.js 22 or newer. Install with `npm install`.
- Validate every change with `npm run check` (format, build, type-check, tests). Each changed package must build and pass its tests.
- Keep Lipila's concepts and capabilities visible. Do not add a multi-gateway abstraction; that belongs in a different product.

## Payment safety (non-negotiable)

- Treat an interrupted financial mutation as an unknown outcome that must be reconciled by its original `referenceId`. Never auto-retry a mutation.
- Status reads may be retried, explicitly and bounded, per request.
- Verify webhook signatures against the raw request bytes before parsing JSON. Preserve provider event ids and raw status values for deduplication and support.
- Never log, serialize into errors, or return API keys or webhook secrets.

## Where things live

- `spec/README.md` is the language-neutral description of observable SDK behavior. Update it alongside any behavior change.
- `sdks/javascript` is the reference implementation. Keep `sdks/store-conformance` green for any store adapter.
- `apps/site` is the documentation site (`npm run site:dev`).

## For AI agents

Follow the rules above, run `npm run check` before proposing changes, and prefer small, focused pull requests.
