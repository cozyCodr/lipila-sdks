# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub's **Report a vulnerability** button under this repository's Security tab. That opens a private advisory visible only to the maintainers.

Do not open a public issue, pull request, or discussion for a security report, and do not include live credentials in it.

Please include:

- affected package and version (for example `@cozycodr/lipila@0.1.0`);
- the operation involved (payment creation, status retrieval, webhook verification, lifecycle store);
- a minimal reproduction, using redacted or synthetic values;
- the impact you believe it has.

Expect an acknowledgement within five working days. Fixes are released on `main` and tagged per package.

## Scope

In scope:

- webhook signature verification, including bypass, replay, and timing issues;
- leakage of an API key or webhook secret into errors, logs, or published artifacts;
- injection or authorization flaws in the lifecycle store adapters;
- payment-safety defects such as an interrupted mutation being retried automatically, a settled payment being overwritten or deleted, or a webhook handler being skipped or duplicated.

Out of scope:

- vulnerabilities in Lipila's own API or dashboards (report those to Lipila);
- issues that require an already-compromised application process;
- missing hardening that has no demonstrated impact.

## Handling credentials

These packages are server-side only. An API key gives direct account access and must never reach browser code. Webhook secrets and API keys must not be committed, logged, or included in bug reports.

If you believe a credential has been exposed, rotate it in the relevant Lipila dashboard first, then report.

## Supported versions

Every package is currently `0.x` and pre-release. Only the latest published version of each package receives fixes. The store adapters are in preview; test them against a non-production database first.
