# Getting started

This guide takes a server-side JavaScript application from account setup to its first Lipila payment. Node.js 22 or newer is required.

## 1. Create separate sandbox and production accounts

Lipila has two independent merchant dashboards:

| Environment | Merchant dashboard | API base URL | Purpose |
| --- | --- | --- | --- |
| Sandbox | [dashboard.lipila.dev](https://dashboard.lipila.dev) | `https://api.lipila.dev` | Development and testing |
| Production | [dashboard.lipila.io](https://dashboard.lipila.io) | `https://blz.lipila.io` | Live payments |

Onboard separately in both dashboards. A sandbox registration does not automatically create the production merchant account, and credentials do not cross environments. Generate and configure each environment's API key and webhook secret in that environment's dashboard.

Lipila's documentation lists both self-onboarding URLs but does not make the separate-account requirement prominent. Confirm production activation and payment-method access with Lipila before launch.

Store the credentials separately:

```env
LIPILA_SANDBOX_API_KEY=your_sandbox_key
LIPILA_SANDBOX_WEBHOOK_SECRET=your_sandbox_webhook_secret

LIPILA_PRODUCTION_API_KEY=your_production_key
LIPILA_PRODUCTION_WEBHOOK_SECRET=your_production_webhook_secret
```

Never commit these values or expose them in browser code.

## 2. Install the package

The package is not released yet. After the first release:

```bash
npm install @cozycodr/lipila
```

## 3. Configure one server-side client

Start in the sandbox:

```ts
import { lipila } from "@cozycodr/lipila";

export const client = lipila({
  apiKey: process.env.LIPILA_SANDBOX_API_KEY!,
  environment: "sandbox",
  webhookSecret: process.env.LIPILA_SANDBOX_WEBHOOK_SECRET,
});
```

For production, select the environment explicitly and use only the production credentials:

```ts
export const client = lipila({
  apiKey: process.env.LIPILA_PRODUCTION_API_KEY!,
  environment: "production",
  webhookSecret: process.env.LIPILA_PRODUCTION_WEBHOOK_SECRET,
});
```

Do not choose the environment by inspecting the key. Make it an explicit deployment setting.

## 4. Create your order and payment-attempt reference

Your application owns its orders. The SDK does not generate an order number. Create the order first, then give each attempt a unique `referenceId`:

```ts
const order = await orders.create({ total: 125.5 });
const paymentAttempt = await paymentAttempts.create({ orderId: order.id });

// Example value: ORD-2026-0184-PAY-01
const referenceId = paymentAttempt.reference;
```

Read [Payment references](payment-references.md) for duplicate and retry behavior.

## 5. Initiate a mobile-money payment

```ts
const result = await client.payments.mobileMoney.create({
  referenceId,
  amount: order.total,
  narration: `Payment for ${order.number}`,
  accountNumber: "260971234567",
  callbackUrl: "https://merchant.example/webhooks/lipila",
});

console.log(result.payment.status);
```

`currency` is optional and defaults to `"ZMW"`. Lipila also documents `"USD"`; pass `currency: "USD"` when you need it. `Pending` means Lipila accepted the attempt and is still processing it. A returned `Successful` or `Failed` value is a payment result. Network and provider errors are SDK exceptions.

## 6. Initiate a hosted card payment

```ts
const result = await client.payments.card.create({
  referenceId,
  amount: order.total,
  narration: `Payment for ${order.number}`,
  accountNumber: order.customerId,
  customer: {
    firstName: "Jane",
    lastName: "Doe",
    phoneNumber: "260971234567",
    email: "jane@example.com",
    city: "Lusaka",
    country: "ZM",
    address: "Plot 10",
    zip: "10101",
  },
  backUrl: "https://merchant.example/checkout/return",
  referenceData: order.id,
  callbackUrl: "https://merchant.example/webhooks/lipila",
});

if (result.action?.type === "redirect") {
  // Send this opaque URL to the browser. It is not proof of payment.
  return result.action.url;
}
```

The SDK never accepts card PAN or CVV. Lipila hosts card entry and approval.

## 7. Receive the final outcome

Payment completion is asynchronous. Either verify and route webhooks yourself or opt into lifecycle handling with a durable store. Start with [Express webhook integration](express-webhooks.md). Lifecycle users should read [Lifecycle storage](lifecycle-storage.md) first.

## 8. Reconcile an uncertain result

Creation is never retried automatically. If the connection ends after dispatch, reconcile using the same caller-created reference:

```ts
const transaction = await client.payments.retrieve(referenceId, {
  retry: { maxAttempts: 3 },
});
```

Only this read is retried. Do not create a new payment blindly after an unknown outcome.
