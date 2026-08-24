# Branch guide

This file is the source of truth for repository branches. Update it in the same pull request whenever the branching model changes.

## Long-lived branches

### `main`

The release branch. It contains reviewed, documented, releasable code. Package releases and version tags are created from this branch. Direct feature work does not happen here.

### `develop`

The integration branch for the next release. Completed feature and fix branches merge here first. A release pull request promotes a tested snapshot from `develop` to `main`.

## Short-lived branches

Create short-lived branches from the latest `develop` and merge them back into `develop`:

| Pattern | Purpose | Example |
| --- | --- | --- |
| `feat/<language>-<topic>` | A new SDK capability | `feat/js-mobile-money-collections` |
| `fix/<language>-<topic>` | A defect correction | `fix/js-webhook-signature` |
| `docs/<topic>` | Documentation-only work | `docs/error-catalogue` |
| `test/<language>-<topic>` | Fixtures or conformance coverage | `test/js-timeout-outcomes` |
| `chore/<topic>` | Tooling and maintenance | `chore/ci-release` |
| `codex/<topic>` | Agent-assisted work following the same merge rules | `codex/javascript-foundation` |

Use `js`, `python`, `php`, `go`, or `java` as the language segment. Use `spec` when work changes the language-neutral contract.

## Release and urgent-fix branches

- `release/<version>` starts from `develop`, accepts only release preparation fixes, and merges into both `main` and `develop`.
- `hotfix/<version-or-topic>` starts from `main` for an urgent released defect and merges into both `main` and `develop`.

## Merge rules

1. Rebase or merge the latest target branch before review so CI tests the actual integration result.
2. Use pull requests for `develop` and `main`; keep commits focused and require the root `check` script to pass.
3. Squash ordinary feature branches unless their individual commits carry useful release history.
4. Delete short-lived remote branches after merge.
5. Tag releases on `main` as `<language>-v<semver>`, for example `js-v0.1.0`, because each language package versions independently.
