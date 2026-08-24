import { paymentStoreConformance } from "@cozycodr/lipila-store-conformance";
import { describe, expect, it } from "vitest";
import { memoryPaymentStore } from "../src/index.js";

const intent = {
  referenceId: "order-1",
  method: "mobile_money",
  amount: 10,
  currency: "ZMW",
  fingerprint: "one",
} as const;

describe("memoryPaymentStore", () => {
  it("atomically reserves references and rejects fingerprint reuse through its result", async () => {
    const store = memoryPaymentStore({ namespace: "test" });
    expect(await store.prepare(intent)).toEqual({ status: "created" });
    expect(await store.prepare({ ...intent, fingerprint: "two" })).toMatchObject({
      status: "existing",
      fingerprint: "one",
    });
  });

  it("does not regress a final payment", async () => {
    const store = memoryPaymentStore({ namespace: "test" });
    await store.prepare(intent);
    await store.record({
      id: "paid",
      source: "webhook",
      payment: { referenceId: "order-1", method: "mobile_money", state: "paid" },
    });
    const result = await store.record({
      id: "late",
      source: "webhook",
      payment: { referenceId: "order-1", method: "mobile_money", state: "pending" },
    });
    expect(result).toMatchObject({ status: "stale", payment: { state: "paid" } });
  });

  it("leases webhook work and makes failures retryable", async () => {
    let now = 0;
    const store = memoryPaymentStore({ namespace: "test", leaseMs: 10, now: () => now });
    let finish!: () => void;
    const first = store.processWebhook(
      "event",
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    expect(await store.processWebhook("event", async () => {})).toEqual({ status: "in_progress" });
    now = 11;
    expect(await store.processWebhook("event", async () => "taken-over")).toEqual({
      status: "processed",
      value: "taken-over",
    });
    finish();
    expect(await first).toEqual({ status: "in_progress" });
    expect(await store.processWebhook("event", async () => {})).toEqual({ status: "duplicate" });
  });
});

paymentStoreConformance({
  createStore: () => memoryPaymentStore({ namespace: "conformance" }),
  async clearTestNamespace() {},
});
