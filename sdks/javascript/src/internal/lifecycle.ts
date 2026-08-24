import { createHash } from "node:crypto";

import {
  LipilaPaymentHandlerError,
  LipilaPaymentReferenceConflictError,
  LipilaPaymentStoreError,
} from "../errors.js";
import type {
  LipilaCurrency,
  LipilaOperation,
  LipilaPaymentTransaction,
  Payment,
  PaymentHandler,
  PaymentIntent,
  PaymentLifecycleConfig,
  PaymentMethod,
  PaymentObservation,
  PaymentObservationSource,
  WebhookClaim,
} from "../types.js";

export interface PreparedPayment {
  intent: PaymentIntent;
  existing?: Payment;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function classify(
  referenceId: string,
  method: PaymentMethod,
  transaction: LipilaPaymentTransaction,
): Payment {
  const redirect = transaction.cardRedirectionUrl;
  if (method === "card" && typeof redirect === "string" && redirect.trim() !== "") {
    return Object.freeze({
      referenceId,
      method,
      state: "action_required",
      rawStatus: transaction.status,
      transaction,
      action: Object.freeze({ type: "redirect", url: redirect }),
    });
  }

  const state =
    transaction.status === "Pending"
      ? "pending"
      : transaction.status === "Successful"
        ? "paid"
        : transaction.status === "Failed"
          ? "failed"
          : "unknown";
  return Object.freeze({
    referenceId,
    method,
    state,
    rawStatus: transaction.status,
    transaction,
  });
}

function handlerFor(
  config: PaymentLifecycleConfig,
  payment: Payment,
): [string, PaymentHandler] | null {
  const handlers = config.on;
  if (handlers === undefined) return null;
  const specific =
    payment.state === "action_required" ? handlers.actionRequired : handlers[payment.state];
  const handler = specific ?? handlers.changed;
  return handler === undefined
    ? null
    : [specific === undefined ? "changed" : payment.state, handler];
}

export class PaymentLifecycle {
  readonly #config: PaymentLifecycleConfig;

  constructor(config: PaymentLifecycleConfig) {
    this.#config = config;
  }

  async prepare(
    referenceId: string,
    method: Exclude<PaymentMethod, "unknown">,
    amount: number,
    currency: LipilaCurrency,
    serializedIntent: string,
    operation: "create_mobile_money_payment" | "create_card_payment",
  ): Promise<PreparedPayment> {
    const intent = Object.freeze({
      referenceId,
      method,
      amount,
      currency,
      fingerprint: digest(`${method}.${serializedIntent}`),
    });

    try {
      const prepared = await this.#config.store.prepare(intent);
      if (prepared.status === "created") return { intent };
      if (prepared.fingerprint !== intent.fingerprint) {
        throw new LipilaPaymentReferenceConflictError(referenceId, operation);
      }
      return { intent, existing: prepared.payment };
    } catch (cause) {
      if (cause instanceof LipilaPaymentReferenceConflictError) throw cause;
      throw new LipilaPaymentStoreError(operation, cause);
    }
  }

  async release(intent: PaymentIntent, operation: LipilaOperation): Promise<void> {
    try {
      await this.#config.store.release(intent);
    } catch (cause) {
      throw new LipilaPaymentStoreError(operation, cause);
    }
  }

  async observe(
    referenceId: string,
    method: PaymentMethod,
    transaction: LipilaPaymentTransaction,
    source: PaymentObservationSource,
    operation: LipilaOperation,
    webhookId?: string,
    claim?: WebhookClaim,
  ): Promise<Payment> {
    return this.#record(
      classify(referenceId, method, transaction),
      source,
      operation,
      webhookId,
      claim,
    );
  }

  async reconciling(
    referenceId: string,
    method: Exclude<PaymentMethod, "unknown">,
    operation: LipilaOperation,
  ): Promise<Payment> {
    return this.#record(
      Object.freeze({ referenceId, method, state: "reconciling" }),
      "initiation",
      operation,
    );
  }

  async resolve(transaction: LipilaPaymentTransaction): Promise<Payment | null> {
    try {
      return await this.#config.store.resolve(transaction);
    } catch (cause) {
      throw new LipilaPaymentStoreError("handle_webhook", cause);
    }
  }

  processWebhook<T>(webhookId: string, work: (claim: WebhookClaim) => Promise<T>) {
    return this.#config.store.processWebhook(webhookId, work).catch((cause: unknown) => {
      if (cause instanceof LipilaPaymentHandlerError || cause instanceof LipilaPaymentStoreError) {
        throw cause;
      }
      throw new LipilaPaymentStoreError("handle_webhook", cause);
    });
  }

  async get(referenceId: string): Promise<Payment | null> {
    try {
      return await this.#config.store.get(referenceId);
    } catch (cause) {
      throw new LipilaPaymentStoreError("reconcile_payment", cause);
    }
  }

  async #record(
    payment: Payment,
    source: PaymentObservationSource,
    operation: LipilaOperation,
    webhookId?: string,
    claim?: WebhookClaim,
  ): Promise<Payment> {
    const observation: PaymentObservation = Object.freeze({
      id: webhookId ?? digest(`${source}.${payment.referenceId}.${JSON.stringify(payment)}`),
      source,
      payment,
      ...(webhookId === undefined ? {} : { webhookId }),
    });

    let recorded: Payment;
    let shouldRun: boolean;
    try {
      const result = await this.#config.store.record(observation);
      recorded = result.payment;
      // Run the handler when this observation advanced the projection.
      //
      // Also run it when a webhook redelivery re-presents an already-recorded
      // observation, but ONLY under a "first" claim. A first claim means no other
      // worker holds a lease, so an existing observation can only mean a previous
      // attempt recorded it and then failed, releasing its claim — the handler owes
      // a retry. Under a "takeover" claim another worker recorded this observation
      // and may still be running its handler, so re-running here would execute the
      // handler concurrently with it. Never run on "stale": the store deliberately
      // rejected that observation in favour of the payment it already holds.
      shouldRun =
        result.status === "recorded" ||
        (result.status === "duplicate" && source === "webhook" && claim?.attempt === "first");
    } catch (cause) {
      throw new LipilaPaymentStoreError(operation, cause);
    }
    if (!shouldRun) return recorded;

    const selected = handlerFor(this.#config, recorded);
    if (selected === null) return recorded;
    const [name, handler] = selected;
    try {
      await handler({
        source,
        payment: recorded,
        ...(webhookId === undefined ? {} : { webhookId }),
        idempotencyKey: `lipila:${recorded.referenceId}:${recorded.state}`,
      });
    } catch (cause) {
      throw new LipilaPaymentHandlerError(operation, name, recorded, cause);
    }
    return recorded;
  }
}
