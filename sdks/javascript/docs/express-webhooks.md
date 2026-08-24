# Express webhook integration

Lipila signatures cover the exact raw request bytes. Register the webhook route with `express.raw` before any JSON middleware consumes it.

## Direct-control handling

```ts
import express from "express";
import {
  LipilaWebhookVerificationError,
  lipila,
} from "@cozycodr/lipila";

const app = express();
const client = lipila({
  apiKey: process.env.LIPILA_SANDBOX_API_KEY!,
  environment: "sandbox",
  webhookSecret: process.env.LIPILA_SANDBOX_WEBHOOK_SECRET!,
});

app.post(
  "/webhooks/lipila",
  express.raw({ type: "application/json" }),
  async (request, response) => {
    try {
      const event = client.webhooks.verify({
        rawBody: request.body,
        headers: request.headers,
      });

      if (event.shape === "transaction") {
        await applicationPayments.recordLipilaTransaction(event.id, event.transaction);
      }

      response.sendStatus(204);
    } catch (error) {
      if (error instanceof LipilaWebhookVerificationError) {
        response.sendStatus(400);
        return;
      }

      response.sendStatus(503);
    }
  },
);

app.use(express.json());
```

Your `recordLipilaTransaction` operation must deduplicate `event.id` and safely associate the transaction with the caller-created payment reference.

## Lifecycle handling

Lifecycle handling requires a production implementation of `PaymentLifecycleStore`:

```ts
const client = lipila({
  apiKey,
  webhookSecret,
  lifecycle: {
    store,
    on: {
      paid: async ({ payment, idempotencyKey }) => {
        await orders.fulfil(payment.referenceId, { idempotencyKey });
      },
      failed: async ({ payment }) => {
        await orders.markPaymentFailed(payment.referenceId);
      },
    },
  },
});

app.post(
  "/webhooks/lipila",
  express.raw({ type: "application/json" }),
  async (request, response) => {
    try {
      const receipt = await client.webhooks.handle({
        rawBody: request.body,
        headers: request.headers,
      });

      response.sendStatus(receipt.acknowledge ? 204 : 500);
    } catch (error) {
      if (error instanceof LipilaWebhookVerificationError) {
        response.sendStatus(400);
        return;
      }

      // Handler and store failures remain retryable.
      response.sendStatus(503);
    }
  },
);
```

Invalid signatures receive `400`; temporary handler or store failures receive `503` so Lipila can retry. Never log the raw authorization material or webhook secret.
