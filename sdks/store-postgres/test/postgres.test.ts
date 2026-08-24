import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { postgresPaymentStore } from "../src/index.js";

describe("postgresPaymentStore", () => {
  it("validates namespace synchronously", () => {
    expect(() => postgresPaymentStore({ namespace: "", pool: {} as Pool })).toThrow("namespace");
  });

  it("does not close a caller-owned pool", async () => {
    const end = vi.fn();
    const store = postgresPaymentStore({ namespace: "test", pool: { end } as unknown as Pool });
    expect(store.protocolVersion).toBe(2);
    await store.close();
    expect(end).not.toHaveBeenCalled();
  });
});
