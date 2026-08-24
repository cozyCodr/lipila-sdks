import type { Payment, PaymentLifecycleStore, PaymentState } from "@cozycodr/lipila";

export const PAYMENT_STORE_PROTOCOL_VERSION = 2 as const;
export const DEFAULT_WEBHOOK_LEASE_MS = 30_000;
export const MAX_PAYMENT_JSON_BYTES = 256 * 1024;
/** Longest accepted reference, observation id, or provider identity. */
export const MAX_IDENTIFIER_LENGTH = 255;

export interface ManagedPaymentStore extends PaymentLifecycleStore {
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export type PaymentStoreFailure =
  | "unavailable"
  | "conflict"
  | "migration_required"
  | "incompatible_schema"
  | "corrupt_data";

export class PaymentStoreAdapterError extends Error {
  readonly code: PaymentStoreFailure;

  constructor(code: PaymentStoreFailure, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PaymentStoreAdapterError";
    this.code = code;
  }
}

export function validateNamespace(namespace: string): string {
  if (typeof namespace !== "string" || namespace.trim() === "") {
    throw new TypeError("namespace must be a non-empty string.");
  }
  if (Buffer.byteLength(namespace, "utf8") > 255) {
    throw new TypeError("namespace must be at most 255 UTF-8 bytes.");
  }
  return namespace;
}

/**
 * Asserts that a value used as a database key is genuinely a bounded string.
 * TypeScript alone does not guarantee this at an adapter's public boundary, and
 * a non-string reaching a document-database filter becomes a query operator.
 */
export function validateIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw new PaymentStoreAdapterError("corrupt_data", `${name} must be a non-empty string.`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_LENGTH) {
    throw new PaymentStoreAdapterError(
      "corrupt_data",
      `${name} must be at most ${MAX_IDENTIFIER_LENGTH} UTF-8 bytes.`,
    );
  }
  return value;
}

export function assertJsonSize(value: unknown, label = "payment"): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > MAX_PAYMENT_JSON_BYTES) {
    throw new PaymentStoreAdapterError("conflict", `${label} exceeds 256 KiB.`);
  }
  return json;
}

export function parseStoredPayment(value: string | object): Payment {
  try {
    const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Payment).referenceId !== "string" ||
      typeof (parsed as Payment).state !== "string"
    ) {
      throw new Error("missing required payment fields");
    }
    return parsed as Payment;
  } catch (cause) {
    throw new PaymentStoreAdapterError("corrupt_data", "Stored payment data is invalid.", cause);
  }
}

const STATE_RANK: Readonly<Record<PaymentState, number>> = Object.freeze({
  unknown: 0,
  reconciling: 1,
  pending: 2,
  action_required: 3,
  paid: 4,
  failed: 4,
});

export function shouldApplyPayment(current: Payment | null, incoming: Payment): boolean {
  if (current === null) return true;
  if (current.state === "paid" || current.state === "failed") return false;
  const currentRank = STATE_RANK[current.state];
  const incomingRank = STATE_RANK[incoming.state];
  // An unrecognized incoming state must not be applied, and an unrecognized
  // stored state must not wedge the payment so no later observation can land.
  if (incomingRank === undefined) return false;
  if (currentRank === undefined) return true;
  return incomingRank >= currentRank;
}

export function providerIdentities(payment: Payment): readonly string[] {
  const transaction = payment.transaction;
  const values = [transaction?.referenceId, transaction?.identifier];
  return [
    ...new Set(
      values.filter((value): value is string => typeof value === "string" && value !== ""),
    ),
  ];
}

export function ownershipToken(): string {
  return crypto.randomUUID();
}

export function required<T>(value: T | null | undefined, message: string): T {
  if (value === undefined || value === null) {
    throw new PaymentStoreAdapterError("corrupt_data", message);
  }
  return value;
}
