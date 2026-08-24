import { LipilaError } from "../errors.js";
import type { LipilaOperation, LipilaPaymentTransaction } from "../types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJson(body: string, operation: LipilaOperation): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch (cause) {
    const isRead =
      operation === "retrieve_payment" ||
      operation === "reconcile_payment" ||
      operation === "verify_webhook" ||
      operation === "handle_webhook";
    throw new LipilaError("Lipila returned invalid JSON.", {
      code: "invalid_response",
      operation,
      outcome: isRead ? "not_applicable" : "possibly_started",
      nextStep: isRead ? "retry_status" : "reconcile_by_reference",
      cause,
    });
  }
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

export function parseCollection(
  value: unknown,
  operation: LipilaOperation,
): LipilaPaymentTransaction {
  const isRead =
    operation === "retrieve_payment" ||
    operation === "reconcile_payment" ||
    operation === "verify_webhook" ||
    operation === "handle_webhook";
  if (!isRecord(value) || typeof value.status !== "string" || value.status.trim() === "") {
    throw new LipilaError("Lipila returned a transaction without a valid status.", {
      code: "invalid_response",
      operation,
      outcome: isRead ? "not_applicable" : "possibly_started",
      nextStep: isRead ? "retry_status" : "reconcile_by_reference",
    });
  }

  const raw = Object.freeze({ ...value });
  const referenceId = optionalString(value, "referenceId");
  const identifier = optionalString(value, "identifier");
  const externalId = optionalString(value, "externalId");
  const currency = optionalString(value, "currency");
  const accountNumber = optionalString(value, "accountNumber");
  const paymentType = optionalString(value, "paymentType");
  const type = optionalString(value, "type");
  const message = optionalString(value, "message");
  const narration = optionalString(value, "narration");
  const referenceData = optionalString(value, "referenceData");
  const ipAddress = optionalString(value, "ipAddress");
  const createdAt = optionalString(value, "createdAt");

  return Object.freeze({
    status: value.status,
    raw,
    ...(referenceId === undefined ? {} : { referenceId }),
    ...(identifier === undefined ? {} : { identifier }),
    ...(externalId === undefined ? {} : { externalId }),
    ...(currency === undefined ? {} : { currency }),
    ...(typeof value.amount === "number" ? { amount: value.amount } : {}),
    ...(accountNumber === undefined ? {} : { accountNumber }),
    ...(paymentType === undefined ? {} : { paymentType }),
    ...(type === undefined ? {} : { type }),
    ...(message === undefined ? {} : { message }),
    ...(narration === undefined ? {} : { narration }),
    ...(referenceData === undefined ? {} : { referenceData }),
    ...(ipAddress === undefined ? {} : { ipAddress }),
    ...(typeof value.cardRedirectionUrl === "string" || value.cardRedirectionUrl === null
      ? { cardRedirectionUrl: value.cardRedirectionUrl }
      : {}),
    ...(createdAt === undefined ? {} : { createdAt }),
  });
}

export function providerErrorDetails(body: string): { message: string; providerCode?: string } {
  const fallback = "Lipila rejected the request.";
  if (body.trim() === "") return { message: fallback };

  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed)) return { message: fallback };

    const message =
      typeof parsed.message === "string"
        ? parsed.message
        : typeof parsed.error === "string"
          ? parsed.error
          : fallback;
    const providerCode =
      typeof parsed.code === "string"
        ? parsed.code
        : typeof parsed.errorCode === "string"
          ? parsed.errorCode
          : undefined;

    return {
      message: message.slice(0, 500),
      ...(providerCode === undefined ? {} : { providerCode: providerCode.slice(0, 100) }),
    };
  } catch {
    return { message: fallback };
  }
}

export function parseRetryAfter(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (value === null) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, 30_000);
  }

  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - Date.now(), 0), 30_000);
}
