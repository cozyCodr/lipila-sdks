import { createHmac } from "node:crypto";

import { LipilaPaymentHandlerError, lipila } from "@cozycodr/lipila";
import { describe, expect, it, vi } from "vitest";

import { memoryPaymentStore } from "../src/index.js";

// End-to-end coverage that the SDK lifecycle behaves correctly against a REAL
// deduplicating store adapter — not a hand-rolled double. Every real adapter
// deduplicates observations by id, which is exactly the condition that must not
// swallow a retried webhook handler.

const SECRET = Buffer.alloc(32, 7).toString("base64");

function asFetch(
  implementation: (...args: Parameters<typeof fetch>) => Promise<Response>,
): typeof fetch {
  return implementation as typeof fetch;
}

function signedWebhook(body: string, id: string) {
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const signature = createHmac("sha256", Buffer.from(SECRET, "base64"))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return {
    rawBody: body,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    },
  };
}

async function initiate(client: ReturnType<typeof lipila>, referenceId: string): Promise<void> {
  await client.payments.mobileMoney.create({
    referenceId,
    amount: 10,
    narration: "Integration",
    accountNumber: "260971234567",
  });
}

describe("SDK lifecycle against the real memory adapter", () => {
  it("re-runs a failed webhook handler on redelivery instead of swallowing it", async () => {
    const store = memoryPaymentStore({ namespace: "sdk-retry" });
    let attempts = 0;
    const client = lipila({
      apiKey: "test",
      webhookSecret: SECRET,
      lifecycle: {
        store,
        on: {
          paid: () => {
            attempts += 1;
            if (attempts === 1) throw new Error("fulfilment temporarily unavailable");
          },
        },
      },
      fetch: asFetch(async () =>
        Response.json({ status: "Pending", referenceId: "order-retry", identifier: "prov-retry" }),
      ),
    });
    await initiate(client, "order-retry");
    const event = signedWebhook(
      JSON.stringify({ status: "Successful", referenceId: "order-retry" }),
      "evt-retry",
    );

    // First delivery: the handler throws, so the webhook must NOT be acknowledged.
    await expect(client.webhooks.handle(event)).rejects.toBeInstanceOf(LipilaPaymentHandlerError);

    // Redelivery of the same webhook-id (a duplicate observation) must still run the
    // handler, succeed, and acknowledge — the effect is not lost.
    await expect(client.webhooks.handle(event)).resolves.toMatchObject({
      status: "handled",
      acknowledge: true,
    });
    expect(attempts).toBe(2);
    expect(await client.payments.get("order-retry")).toMatchObject({ state: "paid" });
  });

  it("does not re-run a handler concurrently when another worker's lease expires", async () => {
    // Regression guard: inferring "retry" from record()'s duplicate status alone
    // made a slow handler run twice, concurrently, as soon as its lease expired.
    let clock = 1_000;
    const store = memoryPaymentStore({ namespace: "sdk-lease", leaseMs: 50, now: () => clock });
    let paidCalls = 0;
    let releaseFirst!: () => void;
    const firstHandlerBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const client = lipila({
      apiKey: "test",
      webhookSecret: SECRET,
      lifecycle: {
        store,
        on: {
          paid: async () => {
            paidCalls += 1;
            if (paidCalls === 1) await firstHandlerBlocked;
          },
        },
      },
      fetch: asFetch(async () =>
        Response.json({ status: "Pending", referenceId: "order-lease", identifier: "prov-lease" }),
      ),
    });
    await initiate(client, "order-lease");
    const event = signedWebhook(
      JSON.stringify({ status: "Successful", referenceId: "order-lease" }),
      "evt-lease",
    );

    // Worker A claims the webhook and stalls inside the handler.
    const workerA = client.webhooks.handle(event).catch((error: { code?: string }) => error);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(paidCalls).toBe(1);

    // The lease expires and worker B takes it over while A is still running.
    clock += 500;
    await client.webhooks.handle(event);

    // B must not run the handler alongside A.
    expect(paidCalls).toBe(1);
    releaseFirst();
    await workerA;
    expect(paidCalls).toBe(1);
  });

  it("acknowledges a genuinely duplicate delivery without re-firing the handler", async () => {
    const store = memoryPaymentStore({ namespace: "sdk-dupe" });
    const paid = vi.fn();
    const client = lipila({
      apiKey: "test",
      webhookSecret: SECRET,
      lifecycle: { store, on: { paid } },
      fetch: asFetch(async () =>
        Response.json({ status: "Pending", referenceId: "order-dupe", identifier: "prov-dupe" }),
      ),
    });
    await initiate(client, "order-dupe");
    const event = signedWebhook(
      JSON.stringify({ status: "Successful", referenceId: "order-dupe" }),
      "evt-dupe",
    );

    const first = await client.webhooks.handle(event);
    const second = await client.webhooks.handle(event);

    expect(first).toMatchObject({ status: "handled", acknowledge: true });
    expect(second).toMatchObject({ status: "duplicate", acknowledge: true });
    expect(paid).toHaveBeenCalledOnce();
  });
});
