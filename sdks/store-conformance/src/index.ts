import type { PaymentLifecycleStore } from "@cozycodr/lipila";
import { describe, expect, it } from "vitest";

export interface PaymentStoreConformanceOptions {
  createStore(): Promise<PaymentLifecycleStore> | PaymentLifecycleStore;
  /** Delete only records owned by this conformance run's unique, disposable namespace. */
  clearTestNamespace(): Promise<void>;
}

const intent = {
  referenceId: "conformance-order",
  method: "mobile_money",
  amount: 10,
  currency: "ZMW",
  fingerprint: "fingerprint-a",
} as const;

export function paymentStoreConformance(options: PaymentStoreConformanceOptions): void {
  describe("PaymentLifecycleStore conformance", () => {
    it("declares protocol version 2", async () => {
      await options.clearTestNamespace();
      expect((await options.createStore()).protocolVersion).toBe(2);
    });

    it("reserves one reference atomically", async () => {
      await options.clearTestNamespace();
      const store = await options.createStore();
      const results = await Promise.all(Array.from({ length: 8 }, () => store.prepare(intent)));
      expect(results.filter((result) => result.status === "created")).toHaveLength(1);
      expect(results.filter((result) => result.status === "existing")).toHaveLength(7);
    });

    it("guards releases with the fingerprint", async () => {
      await options.clearTestNamespace();
      const store = await options.createStore();
      await store.prepare(intent);
      await store.release({ ...intent, fingerprint: "wrong" });
      expect(await store.prepare(intent)).toMatchObject({ status: "existing" });
      await store.release(intent);
      expect(await store.prepare(intent)).toEqual({ status: "created" });
    });

    it("deduplicates observations and protects final state", async () => {
      await options.clearTestNamespace();
      const store = await options.createStore();
      await store.prepare(intent);
      const paid = {
        id: "observation-paid",
        source: "webhook",
        payment: { referenceId: intent.referenceId, method: "mobile_money", state: "paid" },
      } as const;
      expect(await store.record(paid)).toMatchObject({ status: "recorded" });
      expect(await store.record(paid)).toMatchObject({ status: "duplicate" });
      expect(
        await store.record({ ...paid, id: "late", payment: { ...paid.payment, state: "pending" } }),
      ).toMatchObject({ status: "stale", payment: { state: "paid" } });
    });

    it("runs completed webhook work once and retries failures", async () => {
      await options.clearTestNamespace();
      const store = await options.createStore();
      let calls = 0;
      await expect(
        store.processWebhook("failed-event", async () => {
          calls += 1;
          throw new Error("failure");
        }),
      ).rejects.toThrow("failure");
      expect(
        await store.processWebhook("failed-event", async () => {
          calls += 1;
          return 42;
        }),
      ).toEqual({ status: "processed", value: 42 });
      expect(
        await store.processWebhook("failed-event", async () => {
          calls += 1;
        }),
      ).toEqual({ status: "duplicate" });
      expect(calls).toBe(2);
    });

    it("reports how each webhook claim was acquired", async () => {
      await options.clearTestNamespace();
      const store = await options.createStore();
      const attempts: string[] = [];
      // A claim on an unheld webhook is always "first", including after a failed
      // attempt released it. The SDK relies on this to distinguish a genuine retry
      // from a concurrent takeover, so every adapter must report it consistently.
      await expect(
        store.processWebhook("claim-event", async (claim) => {
          attempts.push(claim.attempt);
          throw new Error("failure");
        }),
      ).rejects.toThrow("failure");
      await store.processWebhook("claim-event", async (claim) => {
        attempts.push(claim.attempt);
      });
      expect(attempts).toEqual(["first", "first"]);
    });

    it("refuses to release a reservation that is no longer reconciling", async () => {
      await options.clearTestNamespace();
      const store = await options.createStore();
      await store.prepare(intent);
      await store.record({
        id: "release-guard-paid",
        source: "webhook",
        payment: { referenceId: intent.referenceId, method: "mobile_money", state: "paid" },
      });
      // Releasing after the payment settled must not delete it; otherwise the next
      // prepare() reports "created" and the caller can charge the same order twice.
      await store.release(intent);
      expect(await store.prepare(intent)).toMatchObject({ status: "existing" });
    });

    it("refuses an observation for a reference that was never prepared", async () => {
      await options.clearTestNamespace();
      const store = await options.createStore();
      await expect(
        store.record({
          id: "unprepared-observation",
          source: "reconciliation",
          payment: { referenceId: "never-prepared", method: "mobile_money", state: "paid" },
        }),
      ).rejects.toMatchObject({ code: "conflict" });
    });
  });
}
