import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  LipilaLifecycleNotConfiguredError,
  LipilaPaymentHandlerError,
  type LipilaPaymentTransaction,
  lipila,
  type Payment,
  type PaymentIntent,
  type PaymentLifecycleStore,
  type PaymentObservation,
  type PreparePaymentResult,
  type RecordPaymentResult,
  type WebhookClaim,
  type WebhookProcessingResult,
} from "../src/index.js";

const SECRET = Buffer.alloc(32, 7).toString("base64");

function asFetch(
  implementation: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return implementation as typeof fetch;
}

/**
 * Minimal in-test store. It must mirror the real adapters' observable contract —
 * observation deduplication, stale rejection, and returning the stored projection
 * rather than the incoming payload — or tests here pass against behaviour no real
 * adapter has. Full lease/takeover coverage lives in @cozycodr/lipila-store-memory.
 */
class MemoryLifecycleStore implements PaymentLifecycleStore {
  readonly protocolVersion = 2 as const;
  readonly intents = new Map<string, PaymentIntent>();
  readonly payments = new Map<string, Payment>();
  readonly identities = new Map<string, string>();
  readonly completedWebhooks = new Set<string>();
  readonly observations: PaymentObservation[] = [];
  /** Deduplication by observation id, matching every real adapter's record contract. */
  readonly recordedObservations = new Map<string, Payment>();

  async prepare(intent: PaymentIntent): Promise<PreparePaymentResult> {
    const existingIntent = this.intents.get(intent.referenceId);
    if (existingIntent === undefined) {
      this.intents.set(intent.referenceId, intent);
      return { status: "created" };
    }
    return {
      status: "existing",
      fingerprint: existingIntent.fingerprint,
      payment: this.payments.get(intent.referenceId) ?? {
        referenceId: intent.referenceId,
        method: intent.method,
        state: "reconciling",
      },
    };
  }

  async release(intent: PaymentIntent): Promise<void> {
    if (this.intents.get(intent.referenceId)?.fingerprint === intent.fingerprint) {
      this.intents.delete(intent.referenceId);
    }
  }

  async record(observation: PaymentObservation): Promise<RecordPaymentResult> {
    const seen = this.recordedObservations.get(observation.id);
    if (seen !== undefined) return { status: "duplicate", payment: seen };
    const current = this.payments.get(observation.payment.referenceId) ?? null;
    // Real adapters refuse to regress a final state and return the payment they
    // retained, not the incoming one.
    if (current !== null && (current.state === "paid" || current.state === "failed")) {
      this.recordedObservations.set(observation.id, current);
      return { status: "stale", payment: current };
    }
    this.observations.push(observation);
    this.recordedObservations.set(observation.id, observation.payment);
    this.payments.set(observation.payment.referenceId, observation.payment);
    const transaction = observation.payment.transaction;
    for (const identity of [transaction?.referenceId, transaction?.identifier]) {
      if (identity !== undefined) this.identities.set(identity, observation.payment.referenceId);
    }
    return { status: "recorded", payment: observation.payment };
  }

  async resolve(transaction: LipilaPaymentTransaction): Promise<Payment | null> {
    for (const identity of [transaction.referenceId, transaction.identifier]) {
      if (identity === undefined) continue;
      const referenceId = this.identities.get(identity) ?? identity;
      const payment = this.payments.get(referenceId);
      if (payment !== undefined) return payment;
    }
    return null;
  }

  async processWebhook<T>(
    webhookId: string,
    work: (claim: WebhookClaim) => Promise<T>,
  ): Promise<WebhookProcessingResult<T>> {
    if (this.completedWebhooks.has(webhookId)) return { status: "duplicate" };
    // No lease here, so every claim is a first attempt; takeover behaviour is
    // covered against the real adapter in @cozycodr/lipila-store-memory.
    const value = await work({ attempt: "first" });
    this.completedWebhooks.add(webhookId);
    return { status: "processed", value };
  }

  async get(referenceId: string): Promise<Payment | null> {
    return this.payments.get(referenceId) ?? null;
  }
}

function webhook(body: string, id = "evt_lifecycle_1") {
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

describe("optional payment lifecycle", () => {
  it("persists before dispatch and invokes the immediate pending handler", async () => {
    const order: string[] = [];
    const store = new MemoryLifecycleStore();
    const prepare = store.prepare.bind(store);
    store.prepare = async (intent) => {
      order.push("prepare");
      return prepare(intent);
    };
    const pending = vi.fn(async () => {
      order.push("handler");
    });
    const client = lipila({
      apiKey: "test",
      lifecycle: { store, on: { pending } },
      fetch: asFetch(async () => {
        order.push("dispatch");
        return Response.json({
          status: "Pending",
          referenceId: "order-life-1",
          identifier: "provider-life-1",
        });
      }),
    });

    await client.payments.mobileMoney.create({
      referenceId: "order-life-1",
      amount: 10,
      narration: "Lifecycle",
      accountNumber: "260971234567",
      currency: "ZMW",
    });

    expect(order).toEqual(["prepare", "dispatch", "handler"]);
    expect(pending).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "initiation",
        payment: expect.objectContaining({ state: "pending" }),
      }),
    );
  });

  it("classifies a card redirect once as action required", async () => {
    const store = new MemoryLifecycleStore();
    const actionRequired = vi.fn();
    const pending = vi.fn();
    const client = lipila({
      apiKey: "test",
      lifecycle: { store, on: { actionRequired, pending } },
      fetch: asFetch(async () =>
        Response.json({
          status: "Pending",
          paymentType: "Card",
          referenceId: "card-life-1",
          cardRedirectionUrl: "https://checkout.example/session",
        }),
      ),
    });

    await client.payments.card.create({
      referenceId: "card-life-1",
      amount: 20,
      narration: "Card lifecycle",
      accountNumber: "customer-1",
      currency: "ZMW",
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
      backUrl: "https://merchant.example/return",
      referenceData: "card-life-1",
    });

    expect(actionRequired).toHaveBeenCalledOnce();
    expect(pending).not.toHaveBeenCalled();
    expect(await client.payments.get("card-life-1")).toMatchObject({
      state: "action_required",
      action: { type: "redirect" },
    });
  });

  it("blocks conflicting reference reuse before another provider request", async () => {
    const store = new MemoryLifecycleStore();
    const fetchMock = vi.fn(asFetch(async () => Response.json({ status: "Pending" })));
    const client = lipila({ apiKey: "test", lifecycle: { store }, fetch: fetchMock });
    const base = {
      referenceId: "order-conflict",
      amount: 10,
      narration: "First",
      accountNumber: "260971234567",
      currency: "ZMW" as const,
    };

    await client.payments.mobileMoney.create(base);
    await expect(client.payments.mobileMoney.create({ ...base, amount: 11 })).rejects.toMatchObject(
      { code: "payment_reference_conflict" },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("records ambiguous initiation and invokes reconciliation handling", async () => {
    const store = new MemoryLifecycleStore();
    const reconciling = vi.fn();
    const client = lipila({
      apiKey: "test",
      lifecycle: { store, on: { reconciling } },
      fetch: asFetch(async () => {
        throw new TypeError("disconnected");
      }),
    });

    await expect(
      client.payments.mobileMoney.create({
        referenceId: "order-reconcile",
        amount: 10,
        narration: "Reconcile",
        accountNumber: "260971234567",
        currency: "ZMW",
      }),
    ).rejects.toMatchObject({ code: "unknown_outcome" });
    expect(reconciling).toHaveBeenCalledOnce();
    expect(await client.payments.get("order-reconcile")).toMatchObject({
      state: "reconciling",
    });
  });

  it("releases a prepared intent after a definite provider rejection", async () => {
    const store = new MemoryLifecycleStore();
    const fetchMock = vi.fn(
      asFetch(async () => {
        if (fetchMock.mock.calls.length === 1) {
          return Response.json({ message: "Invalid request" }, { status: 400 });
        }
        return Response.json({ status: "Pending", referenceId: "order-release" });
      }),
    );
    const client = lipila({ apiKey: "test", lifecycle: { store }, fetch: fetchMock });
    const input = {
      referenceId: "order-release",
      amount: 10,
      narration: "Release",
      accountNumber: "260971234567",
      currency: "ZMW" as const,
    };

    await expect(client.payments.mobileMoney.create(input)).rejects.toMatchObject({
      httpStatus: 400,
      outcome: "not_started",
    });
    await expect(client.payments.mobileMoney.create(input)).resolves.toMatchObject({
      payment: { status: "Pending" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("handles a final webhook once through the same registered handlers", async () => {
    const store = new MemoryLifecycleStore();
    const paid = vi.fn();
    const client = lipila({
      apiKey: "test",
      webhookSecret: SECRET,
      lifecycle: { store, on: { paid } },
      fetch: asFetch(async () =>
        Response.json({
          status: "Pending",
          referenceId: "order-webhook",
          identifier: "provider-webhook",
        }),
      ),
    });
    await client.payments.mobileMoney.create({
      referenceId: "order-webhook",
      amount: 10,
      narration: "Webhook",
      accountNumber: "260971234567",
      currency: "ZMW",
    });
    const input = webhook(JSON.stringify({ status: "Successful", referenceId: "order-webhook" }));

    const first = await client.webhooks.handle(input);
    const duplicate = await client.webhooks.handle(input);

    expect(first).toMatchObject({ status: "handled", acknowledge: true });
    expect(duplicate).toMatchObject({ status: "duplicate", acknowledge: true });
    expect(paid).toHaveBeenCalledOnce();
    expect(paid).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "webhook",
        idempotencyKey: "lipila:order-webhook:paid",
      }),
    );
  });

  it("does not acknowledge a webhook while another worker owns its lease", async () => {
    const store = new MemoryLifecycleStore();
    const client = lipila({
      apiKey: "test",
      webhookSecret: SECRET,
      lifecycle: { store },
      fetch: asFetch(async () =>
        Response.json({ status: "Pending", referenceId: "order-live-lease" }),
      ),
    });
    await client.payments.mobileMoney.create({
      referenceId: "order-live-lease",
      amount: 10,
      narration: "Live lease",
      accountNumber: "260971234567",
      currency: "ZMW",
    });
    store.processWebhook = async () => ({ status: "in_progress" });

    await expect(
      client.webhooks.handle(
        webhook(JSON.stringify({ status: "Successful", referenceId: "order-live-lease" })),
      ),
    ).resolves.toMatchObject({ status: "in_progress", acknowledge: false });
  });

  it("leaves a webhook retryable when its business handler fails", async () => {
    const store = new MemoryLifecycleStore();
    let attempts = 0;
    const client = lipila({
      apiKey: "test",
      webhookSecret: SECRET,
      lifecycle: {
        store,
        on: {
          paid: () => {
            attempts += 1;
            if (attempts === 1) throw new Error("temporary failure");
          },
        },
      },
      fetch: asFetch(async () =>
        Response.json({ status: "Pending", referenceId: "order-retry-handler" }),
      ),
    });
    await client.payments.mobileMoney.create({
      referenceId: "order-retry-handler",
      amount: 10,
      narration: "Retry handler",
      accountNumber: "260971234567",
      currency: "ZMW",
    });
    const input = webhook(
      JSON.stringify({ status: "Successful", referenceId: "order-retry-handler" }),
      "evt_retry_handler",
    );

    await expect(client.webhooks.handle(input)).rejects.toBeInstanceOf(LipilaPaymentHandlerError);
    await expect(client.webhooks.handle(input)).resolves.toMatchObject({ status: "handled" });
    expect(attempts).toBe(2);
  });

  it("feeds explicit reconciliation through the same paid handler", async () => {
    const store = new MemoryLifecycleStore();
    const paid = vi.fn();
    let requests = 0;
    const fetchMock = vi.fn(
      asFetch(async () => {
        requests += 1;
        return requests === 1
          ? Response.json({ status: "Pending", referenceId: "order-explicit-reconcile" })
          : Response.json({ status: "Successful", referenceId: "order-explicit-reconcile" });
      }),
    );
    const client = lipila({
      apiKey: "test",
      lifecycle: { store, on: { paid } },
      fetch: fetchMock,
    });
    await client.payments.mobileMoney.create({
      referenceId: "order-explicit-reconcile",
      amount: 10,
      narration: "Explicit reconcile",
      accountNumber: "260971234567",
      currency: "ZMW",
    });

    const payment = await client.payments.reconcile("order-explicit-reconcile");

    expect(payment.state).toBe("paid");
    expect(paid).toHaveBeenCalledWith(expect.objectContaining({ source: "reconciliation" }));
  });

  it("does not acknowledge a verified webhook it cannot associate with a payment", async () => {
    const client = lipila({
      apiKey: "test",
      webhookSecret: SECRET,
      lifecycle: { store: new MemoryLifecycleStore() },
      fetch: asFetch(async () => Response.json({})),
    });

    const receipt = await client.webhooks.handle(
      webhook(JSON.stringify({ status: "Successful", referenceId: "unknown-order" })),
    );

    expect(receipt).toEqual({
      status: "unresolved",
      acknowledge: false,
      eventId: "evt_lifecycle_1",
    });
  });

  it("keeps handler failure distinct from the known payment outcome", async () => {
    const store = new MemoryLifecycleStore();
    const client = lipila({
      apiKey: "test",
      lifecycle: {
        store,
        on: {
          failed: () => {
            throw new Error("database unavailable");
          },
        },
      },
      fetch: asFetch(async () => Response.json({ status: "Failed", message: "Declined" })),
    });

    const promise = client.payments.mobileMoney.create({
      referenceId: "order-handler",
      amount: 10,
      narration: "Handler",
      accountNumber: "260971234567",
      currency: "ZMW",
    });
    await expect(promise).rejects.toBeInstanceOf(LipilaPaymentHandlerError);
    await expect(promise).rejects.toMatchObject({
      payment: expect.objectContaining({ state: "failed" }),
    });
  });

  it("requires lifecycle configuration only for opinionated operations", async () => {
    const client = lipila({ apiKey: "test", fetch: asFetch(async () => Response.json({})) });

    await expect(client.payments.get("order-1")).rejects.toBeInstanceOf(
      LipilaLifecycleNotConfiguredError,
    );
    await expect(client.webhooks.handle(webhook("{}"))).rejects.toBeInstanceOf(
      LipilaLifecycleNotConfiguredError,
    );
  });
});
