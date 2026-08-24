# Payment references

## The developer owns `referenceId`

The SDK does not generate an order number or replace the application's identifiers. The caller supplies `referenceId` on every creation request:

```ts
await client.payments.mobileMoney.create({
  referenceId: "ORD-2026-0184-PAY-01",
  // ...
});
```

Use a payment-attempt reference, not necessarily the bare order number. One order may have multiple legitimate attempts:

```text
Order                    ORD-2026-0184
First payment attempt    ORD-2026-0184-PAY-01  failed
Second payment attempt   ORD-2026-0184-PAY-02  paid
```

Your application decides how these values are generated. They may be UUIDs, database-issued values or readable references, provided each payment attempt is unique and stable.

## The four identities

| Identity | Owner | Example | Purpose |
| --- | --- | --- | --- |
| Order number | Merchant application | `ORD-2026-0184` | Identifies the purchase |
| `referenceId` | Merchant application | `ORD-2026-0184-PAY-01` | Identifies one payment attempt and is sent to Lipila |
| Store row ID | Database adapter | UUID or sequence | Internal database implementation detail |
| Provider identity | Lipila | Response `referenceId`, `identifier` or `externalId` | Identifies the transaction within provider data |

The SDK returns `submittedReferenceId` separately because Lipila's public examples are inconsistent about the meaning of response `referenceId` and `identifier`.

## What lifecycle storage checks

When lifecycle handling is enabled, the store reserves the caller's exact `referenceId` before Lipila is contacted. It also saves a fingerprint of immutable request details.

If the same reference is submitted again with the same fingerprint, the SDK treats it as the same payment attempt. If a recorded provider transaction exists, it is returned without another creation request. If its outcome is uncertain, the SDK requires reconciliation.

If the same reference is submitted with different immutable details, the SDK throws `LipilaPaymentReferenceConflictError` before contacting Lipila:

```ts
// First attempt
{ referenceId: "ORD-1-PAY-01", amount: 100, currency: "ZMW" }

// Rejected: the same payment attempt cannot be redefined as K200
{ referenceId: "ORD-1-PAY-01", amount: 200, currency: "ZMW" }
```

Create a new payment-attempt reference for a genuinely new attempt:

```ts
{ referenceId: "ORD-1-PAY-02", amount: 200, currency: "ZMW" }
```

The store may use its own primary key internally, but uniqueness and conflict detection are based on the caller-created `referenceId`.
