import { createHmac, timingSafeEqual } from "node:crypto";

import { LipilaLifecycleNotConfiguredError, LipilaWebhookVerificationError } from "./errors.js";
import type { PaymentLifecycle } from "./internal/lifecycle.js";
import { isRecord, parseCollection } from "./internal/response.js";
import type {
  LipilaPaymentTransaction,
  VerifiedLipilaWebhook,
  VerifyWebhookInput,
  WebhookHeaders,
  WebhookReceipt,
  WebhooksResource,
} from "./types.js";

const WEBHOOK_TOLERANCE_SECONDS = 300;
const MAX_WEBHOOK_ID_LENGTH = 255;
const MAX_SIGNATURE_HEADER_LENGTH = 4_096;

function headerValue(headers: WebhookHeaders, name: string): string | undefined {
  // Brand-check rather than duck-typing on `.get`: an inherited `get` (e.g. from a
  // polluted Object.prototype) must not be able to satisfy every header lookup.
  if (headers instanceof Headers) {
    const value = headers.get(name);
    return value === null ? undefined : value;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (Array.isArray(value))
      return value.every((entry) => typeof entry === "string") ? value.join(" ") : undefined;
    return typeof value === "string" ? value : undefined;
  }

  return undefined;
}

function rawBodyBytes(rawBody: Uint8Array | string): Buffer {
  if (typeof rawBody === "string") return Buffer.from(rawBody, "utf8");
  if (rawBody instanceof Uint8Array) {
    return Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
  }
  throw new LipilaWebhookVerificationError(
    "invalid_json",
    "rawBody must be an untouched string or Uint8Array.",
  );
}

function decodeSignature(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64");
  return decoded.byteLength === 32 ? decoded : undefined;
}

function classifyPayload(id: string, timestamp: Date, payload: unknown): VerifiedLipilaWebhook {
  if (isRecord(payload)) {
    const frozen = Object.freeze({ ...payload });

    if (typeof payload.type === "string" && Object.hasOwn(payload, "data")) {
      return Object.freeze({
        id,
        timestamp,
        shape: "envelope",
        type: payload.type,
        data: payload.data,
        payload: frozen,
      });
    }

    if (typeof payload.status === "string" && payload.status.trim() !== "") {
      return Object.freeze({
        id,
        timestamp,
        shape: "transaction",
        transaction: parseCollection(payload, "verify_webhook"),
        payload: frozen,
      });
    }
  }

  return Object.freeze({ id, timestamp, shape: "unknown", payload });
}

export class LipilaWebhooks implements WebhooksResource {
  readonly #secrets: readonly Buffer[];
  readonly #lifecycle: PaymentLifecycle | undefined;

  constructor(secrets: readonly Buffer[], lifecycle: PaymentLifecycle | undefined) {
    this.#secrets = secrets;
    this.#lifecycle = lifecycle;
  }

  verify(input: VerifyWebhookInput): VerifiedLipilaWebhook {
    if (this.#secrets.length === 0) {
      throw new LipilaWebhookVerificationError(
        "missing_secret",
        "Configure webhookSecret before verifying Lipila webhooks.",
      );
    }

    const id = headerValue(input.headers, "webhook-id");
    const timestampHeader = headerValue(input.headers, "webhook-timestamp");
    const signatureHeader = headerValue(input.headers, "webhook-signature");

    if (
      id === undefined ||
      timestampHeader === undefined ||
      signatureHeader === undefined ||
      id.trim() === "" ||
      signatureHeader.trim() === ""
    ) {
      throw new LipilaWebhookVerificationError(
        "missing_header",
        "Lipila webhook headers are incomplete.",
      );
    }

    // Bound the inputs so a hostile caller cannot force unbounded work, and reject
    // an id containing the field separator: `{id}.{timestamp}.{body}` would
    // otherwise be ambiguous, letting one signature cover a different split.
    if (id.length > MAX_WEBHOOK_ID_LENGTH || id.includes(".")) {
      throw new LipilaWebhookVerificationError(
        "missing_header",
        "webhook-id must be a short identifier that does not contain a period.",
      );
    }
    if (signatureHeader.length > MAX_SIGNATURE_HEADER_LENGTH) {
      throw new LipilaWebhookVerificationError(
        "invalid_signature",
        "webhook-signature header is unreasonably large.",
      );
    }

    if (!/^\d+$/u.test(timestampHeader)) {
      throw new LipilaWebhookVerificationError(
        "invalid_timestamp",
        "webhook-timestamp must be Unix time in whole seconds.",
      );
    }
    const timestampSeconds = Number(timestampHeader);
    if (!Number.isSafeInteger(timestampSeconds)) {
      throw new LipilaWebhookVerificationError(
        "invalid_timestamp",
        "webhook-timestamp must be Unix time in whole seconds.",
      );
    }

    const nowSeconds = Math.floor(Date.now() / 1_000);
    if (Math.abs(nowSeconds - timestampSeconds) > WEBHOOK_TOLERANCE_SECONDS) {
      throw new LipilaWebhookVerificationError(
        "timestamp_outside_tolerance",
        "The Lipila webhook timestamp is outside the five-minute tolerance.",
      );
    }

    const body = rawBodyBytes(input.rawBody);
    const prefix = Buffer.from(`${id}.${timestampHeader}.`, "utf8");
    const signatures = signatureHeader.split(/\s+/u).flatMap((entry) => {
      const comma = entry.indexOf(",");
      if (comma === -1 || entry.slice(0, comma) !== "v1") return [];
      const decoded = decodeSignature(entry.slice(comma + 1));
      return decoded === undefined ? [] : [decoded];
    });

    const valid = this.#secrets.some((key) => {
      const expected = createHmac("sha256", key).update(prefix).update(body).digest();
      return signatures.some((signature) => timingSafeEqual(expected, signature));
    });

    if (!valid) {
      throw new LipilaWebhookVerificationError(
        "invalid_signature",
        "The Lipila webhook signature is invalid.",
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8")) as unknown;
    } catch (cause) {
      throw new LipilaWebhookVerificationError(
        "invalid_json",
        "The verified Lipila webhook body is not valid JSON.",
        cause,
      );
    }

    return classifyPayload(id, new Date(timestampSeconds * 1_000), payload);
  }

  async handle(input: VerifyWebhookInput): Promise<WebhookReceipt> {
    if (this.#lifecycle === undefined) {
      throw new LipilaLifecycleNotConfiguredError("handle_webhook");
    }
    const lifecycle = this.#lifecycle;

    const event = this.verify(input);
    let transaction: LipilaPaymentTransaction | undefined;
    if (event.shape === "transaction") {
      transaction = event.transaction;
    } else if (
      event.shape === "envelope" &&
      isRecord(event.data) &&
      typeof event.data.status === "string"
    ) {
      transaction = parseCollection(event.data, "handle_webhook");
    }

    if (transaction === undefined) {
      return Object.freeze({ status: "unresolved", acknowledge: false, eventId: event.id });
    }

    const existing = await lifecycle.resolve(transaction);
    if (existing === null) {
      return Object.freeze({ status: "unresolved", acknowledge: false, eventId: event.id });
    }

    const result = await lifecycle.processWebhook(event.id, async (claim) => {
      await lifecycle.observe(
        existing.referenceId,
        existing.method,
        transaction,
        "webhook",
        "handle_webhook",
        event.id,
        claim,
      );
    });

    if (result.status === "duplicate") {
      return Object.freeze({ status: "duplicate", acknowledge: true, eventId: event.id });
    }
    if (result.status === "in_progress") {
      return Object.freeze({ status: "in_progress", acknowledge: false, eventId: event.id });
    }
    return Object.freeze({ status: "handled", acknowledge: true, eventId: event.id });
  }
}
