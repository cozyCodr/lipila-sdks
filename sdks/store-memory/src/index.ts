import type {
  LipilaPaymentTransaction,
  Payment,
  PaymentIntent,
  PreparePaymentResult,
  RecordPaymentResult,
  WebhookClaim,
  WebhookProcessingResult,
} from "@cozycodr/lipila";
import {
  assertJsonSize,
  DEFAULT_WEBHOOK_LEASE_MS,
  type ManagedPaymentStore,
  ownershipToken,
  PAYMENT_STORE_PROTOCOL_VERSION,
  PaymentStoreAdapterError,
  providerIdentities,
  required,
  shouldApplyPayment,
  validateIdentifier,
  validateNamespace,
} from "@cozycodr/lipila-store-core";

export interface MemoryPaymentStoreOptions {
  namespace: string;
  leaseMs?: number;
  now?: () => number;
}

interface IntentEntry {
  intent: PaymentIntent;
  payment: Payment;
}
interface WebhookEntry {
  state: "processing" | "completed";
  token: string;
  expiresAt: number;
}

export function memoryPaymentStore(options: MemoryPaymentStoreOptions): ManagedPaymentStore {
  validateNamespace(options.namespace);
  const leaseMs = options.leaseMs ?? DEFAULT_WEBHOOK_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0)
    throw new TypeError("leaseMs must be a positive integer.");
  const now = options.now ?? Date.now;
  const intents = new Map<string, IntentEntry>();
  const observations = new Map<string, Payment>();
  const identities = new Map<string, string>();
  const webhooks = new Map<string, WebhookEntry>();
  let queue = Promise.resolve();

  async function locked<T>(work: () => T | Promise<T>): Promise<T> {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  return {
    protocolVersion: PAYMENT_STORE_PROTOCOL_VERSION,
    async migrate() {},
    async close() {},
    prepare: (intent): Promise<PreparePaymentResult> =>
      locked(() => {
        const existing = intents.get(intent.referenceId);
        if (existing !== undefined)
          return {
            status: "existing",
            fingerprint: existing.intent.fingerprint,
            payment: existing.payment,
          };
        const payment: Payment = {
          referenceId: intent.referenceId,
          method: intent.method,
          state: "reconciling",
        };
        intents.set(intent.referenceId, { intent: structuredClone(intent), payment });
        return { status: "created" };
      }),
    release: (intent) =>
      locked(() => {
        const existing = intents.get(intent.referenceId);
        // Only release a reservation that is still unconfirmed. Without the state
        // guard a late release would delete an already-paid payment, and the next
        // prepare() would report "created" — letting the caller charge again.
        if (
          existing?.intent.fingerprint === intent.fingerprint &&
          existing.payment.state === "reconciling"
        ) {
          intents.delete(intent.referenceId);
        }
      }),
    record: (observation): Promise<RecordPaymentResult> =>
      locked(() => {
        assertJsonSize(observation);
        const duplicate = observations.get(observation.id);
        if (duplicate !== undefined)
          return { status: "duplicate", payment: structuredClone(duplicate) };
        const entry = intents.get(observation.payment.referenceId);
        // Match every database adapter: an observation for a reference that was
        // never prepared is a conflict, not an implicit create. Diverging here
        // made reconcile() succeed in tests and throw in production.
        if (entry === undefined) {
          throw new PaymentStoreAdapterError(
            "conflict",
            "Payment was not prepared before observation.",
          );
        }
        const current = entry.payment;
        for (const identity of providerIdentities(observation.payment)) {
          const owner = identities.get(identity);
          if (owner !== undefined && owner !== observation.payment.referenceId) {
            throw new PaymentStoreAdapterError(
              "conflict",
              "A provider identity belongs to another payment.",
            );
          }
        }
        if (!shouldApplyPayment(current, observation.payment)) {
          const retained = required(current, "Current payment disappeared during projection.");
          observations.set(observation.id, structuredClone(retained));
          return { status: "stale", payment: structuredClone(retained) };
        }
        const payment = structuredClone(observation.payment);
        intents.set(payment.referenceId, { intent: entry.intent, payment });
        observations.set(observation.id, payment);
        for (const identity of providerIdentities(payment))
          identities.set(identity, payment.referenceId);
        return { status: "recorded", payment: structuredClone(payment) };
      }),
    resolve: (transaction: LipilaPaymentTransaction) =>
      locked(() => {
        const references = new Set<string>();
        for (const identity of [transaction.referenceId, transaction.identifier]) {
          if (typeof identity !== "string" || identity === "") continue;
          const mapped = identities.get(identity);
          if (mapped !== undefined) references.add(mapped);
          if (intents.has(identity)) references.add(identity);
        }
        if (references.size !== 1) return null;
        const reference = required([...references][0], "Resolved payment reference is missing.");
        return structuredClone(
          required(intents.get(reference), "Resolved payment is missing.").payment,
        );
      }),
    get: (referenceId) =>
      locked(() => {
        const payment = intents.get(referenceId)?.payment;
        return payment === undefined ? null : structuredClone(payment);
      }),
    async processWebhook<T>(
      webhookId: string,
      work: (claim: WebhookClaim) => Promise<T>,
    ): Promise<WebhookProcessingResult<T>> {
      validateIdentifier(webhookId, "webhookId");
      const token = ownershipToken();
      const claim = await locked(() => {
        const existing = webhooks.get(webhookId);
        if (existing?.state === "completed") return "duplicate" as const;
        if (existing?.state === "processing" && existing.expiresAt > now())
          return "in_progress" as const;
        const attempt = existing === undefined ? "first" : "takeover";
        webhooks.set(webhookId, { state: "processing", token, expiresAt: now() + leaseMs });
        return attempt;
      });
      if (claim !== "first" && claim !== "takeover") return { status: claim };
      try {
        const value = await work({ attempt: claim });
        const completed = await locked(() => {
          const current = webhooks.get(webhookId);
          if (current?.token !== token) return false;
          webhooks.set(webhookId, { state: "completed", token, expiresAt: 0 });
          return true;
        });
        if (!completed) return { status: "in_progress" };
        return { status: "processed", value };
      } catch (cause) {
        await locked(() => {
          if (webhooks.get(webhookId)?.token === token) webhooks.delete(webhookId);
        });
        throw cause;
      }
    },
  };
}

export type { ManagedPaymentStore } from "@cozycodr/lipila-store-core";
