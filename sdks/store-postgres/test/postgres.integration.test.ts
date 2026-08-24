import { createHmac } from "node:crypto";

import { LipilaPaymentHandlerError, lipila } from "@cozycodr/lipila";
import { paymentStoreConformance } from "@cozycodr/lipila-store-conformance";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { postgresPaymentStore } from "../src/index.js";

const connectionString = process.env.LIPILA_POSTGRES_TEST_URL;
const runId = crypto.randomUUID();
const namespace = `lipila:postgres-test:${runId}`;
const otherNamespace = `${namespace}:other`;
const pool = connectionString === undefined ? undefined : new Pool({ connectionString });

function testConnectionString(): string {
  if (connectionString === undefined) throw new Error("LIPILA_POSTGRES_TEST_URL is required.");
  return connectionString;
}

function testPool(): Pool {
  if (pool === undefined) throw new Error("LIPILA_POSTGRES_TEST_URL is required.");
  return pool;
}

async function clearNamespace(value: string): Promise<void> {
  if (pool === undefined) return;
  await pool.query("DELETE FROM lipila_webhooks WHERE namespace = $1", [value]);
  await pool.query("DELETE FROM lipila_observations WHERE namespace = $1", [value]);
  await pool.query("DELETE FROM lipila_identities WHERE namespace = $1", [value]);
  await pool.query("DELETE FROM lipila_payments WHERE namespace = $1", [value]);
}

describe.skipIf(connectionString === undefined)("postgresPaymentStore integration", () => {
  beforeAll(async () => {
    const store = postgresPaymentStore({
      connectionString: testConnectionString(),
      namespace,
    });
    try {
      await Promise.all([store.migrate(), store.migrate()]);
    } finally {
      await store.close();
    }
  });

  afterAll(async () => {
    await clearNamespace(namespace);
    await clearNamespace(otherNamespace);
    await pool?.end();
  });

  paymentStoreConformance({
    createStore: () => postgresPaymentStore({ namespace, pool: testPool() }),
    clearTestNamespace: () => clearNamespace(namespace),
  });

  it("isolates the same reference between namespaces", async () => {
    await clearNamespace(namespace);
    await clearNamespace(otherNamespace);
    const first = postgresPaymentStore({ namespace, pool: testPool() });
    const second = postgresPaymentStore({ namespace: otherNamespace, pool: testPool() });
    const intent = {
      referenceId: "shared-reference",
      method: "mobile_money",
      amount: 25,
      currency: "ZMW",
      fingerprint: "shared-fingerprint",
    } as const;

    expect(await first.prepare(intent)).toEqual({ status: "created" });
    expect(await second.prepare(intent)).toEqual({ status: "created" });
  });

  // SDK-level lifecycle behaviour, driven through the real client against a real
  // database. The in-memory adapter cannot exercise transactions, FOR UPDATE row
  // locks, or the database-clock lease expiry these paths actually depend on.
  describe("SDK lifecycle against PostgreSQL", () => {
    const SECRET = Buffer.alloc(32, 7).toString("base64");

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

    function testClient(
      on: Record<string, (context: { payment: { referenceId: string } }) => unknown>,
      leaseMs?: number,
    ) {
      const store = postgresPaymentStore({
        namespace,
        pool: testPool(),
        ...(leaseMs === undefined ? {} : { leaseMs }),
      });
      return lipila({
        apiKey: "test",
        webhookSecret: SECRET,
        lifecycle: { store, on },
        fetch: (async () =>
          Response.json({
            status: "Pending",
            referenceId: "pg-ref",
            identifier: "pg-identity",
          })) as typeof fetch,
      });
    }

    it("re-runs a failed webhook handler on redelivery", async () => {
      await clearNamespace(namespace);
      let attempts = 0;
      const client = testClient({
        paid: () => {
          attempts += 1;
          if (attempts === 1) throw new Error("fulfilment unavailable");
        },
      });
      await client.payments.mobileMoney.create({
        referenceId: "pg-ref",
        amount: 10,
        narration: "Integration",
        accountNumber: "260971234567",
      });
      const event = signedWebhook(
        JSON.stringify({ status: "Successful", referenceId: "pg-ref" }),
        "pg-evt-retry",
      );

      await expect(client.webhooks.handle(event)).rejects.toBeInstanceOf(LipilaPaymentHandlerError);
      await expect(client.webhooks.handle(event)).resolves.toMatchObject({
        status: "handled",
        acknowledge: true,
      });
      expect(attempts).toBe(2);
      expect(await client.payments.get("pg-ref")).toMatchObject({ state: "paid" });
    });

    it("does not re-run a handler when another worker's lease is taken over", async () => {
      await clearNamespace(namespace);
      let paidCalls = 0;
      let releaseFirst!: () => void;
      const blocked = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      // A 1ms lease expires while the first handler is still running, so the
      // second delivery genuinely takes the claim over in the database.
      const client = testClient(
        {
          paid: async () => {
            paidCalls += 1;
            if (paidCalls === 1) await blocked;
          },
        },
        1,
      );
      await client.payments.mobileMoney.create({
        referenceId: "pg-ref",
        amount: 10,
        narration: "Integration",
        accountNumber: "260971234567",
      });
      const event = signedWebhook(
        JSON.stringify({ status: "Successful", referenceId: "pg-ref" }),
        "pg-evt-lease",
      );

      const workerA = client.webhooks.handle(event).catch((error: unknown) => error);
      await vi.waitFor(() => expect(paidCalls).toBe(1));
      await client.webhooks.handle(event);
      expect(paidCalls).toBe(1);
      releaseFirst();
      await workerA;
      expect(paidCalls).toBe(1);
    });

    it("acknowledges a completed duplicate without re-running the handler", async () => {
      await clearNamespace(namespace);
      const paid = vi.fn();
      const client = testClient({ paid });
      await client.payments.mobileMoney.create({
        referenceId: "pg-ref",
        amount: 10,
        narration: "Integration",
        accountNumber: "260971234567",
      });
      const event = signedWebhook(
        JSON.stringify({ status: "Successful", referenceId: "pg-ref" }),
        "pg-evt-dupe",
      );

      expect(await client.webhooks.handle(event)).toMatchObject({ status: "handled" });
      expect(await client.webhooks.handle(event)).toMatchObject({
        status: "duplicate",
        acknowledge: true,
      });
      expect(paid).toHaveBeenCalledOnce();
    });
  });

  it("refuses a provider identity already assigned to another payment", async () => {
    await clearNamespace(namespace);
    const store = postgresPaymentStore({ namespace, pool: testPool() });
    const first = {
      referenceId: "merchant-order-1",
      method: "mobile_money",
      amount: 30,
      currency: "ZMW",
      fingerprint: "fingerprint-1",
    } as const;
    const second = { ...first, referenceId: "merchant-order-2", fingerprint: "fingerprint-2" };
    await store.prepare(first);
    await store.prepare(second);
    await store.record({
      id: "identity-observation-1",
      source: "webhook",
      payment: {
        referenceId: first.referenceId,
        method: "mobile_money",
        state: "pending",
        transaction: { identifier: "lipila-transaction-1", status: "Pending", raw: {} },
      },
    });

    await expect(
      store.record({
        id: "identity-observation-2",
        source: "webhook",
        payment: {
          referenceId: second.referenceId,
          method: "mobile_money",
          state: "pending",
          transaction: { identifier: "lipila-transaction-1", status: "Pending", raw: {} },
        },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
