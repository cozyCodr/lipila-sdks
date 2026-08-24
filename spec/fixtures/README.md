# Provider fixtures

Store redacted, immutable Lipila request, response, error, and webhook samples here. Each fixture must identify its environment, observed date, operation, HTTP status, and expected SDK result.

Remove API keys, signatures, personal data, full phone numbers, IP addresses, and merchant-identifying values before committing. Preserve structural details needed to detect provider contract drift.

Synthetic cryptographic known-answer vectors are the exception to the environment and redaction fields: they must identify their generator, contain obviously non-production key material, and include the expected signature so every language verifier can prove the same result independently.

Fixtures derived from documentation rather than observed provider traffic must say so explicitly in `provenance.kind`. They are contract hypotheses until replaced or confirmed with redacted sandbox observations.
