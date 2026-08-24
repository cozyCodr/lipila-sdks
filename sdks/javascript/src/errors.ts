import type { LipilaOperation, Payment } from "./types.js";

export type LipilaErrorCode =
  | "configuration_error"
  | "validation_error"
  | "request_aborted"
  | "authentication_error"
  | "forbidden"
  | "rate_limited"
  | "not_found"
  | "provider_error"
  | "invalid_response"
  | "transport_error"
  | "unknown_outcome"
  | "webhook_verification_error"
  | "lifecycle_not_configured"
  | "payment_reference_conflict"
  | "payment_store_error"
  | "payment_handler_error";

export type LipilaOutcome = "not_started" | "possibly_started" | "not_applicable";

export type LipilaNextStep =
  | "fix_request"
  | "retry_status"
  | "reconcile_by_reference"
  | "do_not_retry";

interface LipilaErrorOptions {
  code: LipilaErrorCode;
  operation: LipilaOperation;
  outcome: LipilaOutcome;
  nextStep: LipilaNextStep;
  httpStatus?: number;
  retryAfterMs?: number;
  providerCode?: string;
  cause?: unknown;
}

export class LipilaError extends Error {
  readonly code: LipilaErrorCode;
  readonly operation: LipilaOperation;
  readonly outcome: LipilaOutcome;
  readonly nextStep: LipilaNextStep;
  readonly httpStatus: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly providerCode: string | undefined;

  constructor(message: string, options: LipilaErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LipilaError";
    this.code = options.code;
    this.operation = options.operation;
    this.outcome = options.outcome;
    this.nextStep = options.nextStep;
    this.httpStatus = options.httpStatus;
    this.retryAfterMs = options.retryAfterMs;
    this.providerCode = options.providerCode;
  }
}

export class LipilaUnknownOutcomeError extends LipilaError {
  readonly referenceId: string;

  constructor(
    referenceId: string,
    message: string,
    options: {
      operation: "create_mobile_money_payment" | "create_card_payment";
      cause?: unknown;
      httpStatus?: number;
    },
  ) {
    const { operation, ...details } = options;
    super(message, {
      code: "unknown_outcome",
      operation,
      outcome: "possibly_started",
      nextStep: "reconcile_by_reference",
      ...details,
    });
    this.name = "LipilaUnknownOutcomeError";
    this.referenceId = referenceId;
  }
}

export class LipilaLifecycleNotConfiguredError extends LipilaError {
  constructor(operation: "reconcile_payment" | "get_payment" | "handle_webhook") {
    super("Configure lifecycle.store before using this operation.", {
      code: "lifecycle_not_configured",
      operation,
      outcome: "not_applicable",
      nextStep: "fix_request",
    });
    this.name = "LipilaLifecycleNotConfiguredError";
  }
}

export class LipilaPaymentReferenceConflictError extends LipilaError {
  readonly referenceId: string;

  constructor(
    referenceId: string,
    operation: "create_mobile_money_payment" | "create_card_payment",
  ) {
    super("This referenceId is already associated with different payment details.", {
      code: "payment_reference_conflict",
      operation,
      outcome: "not_started",
      nextStep: "fix_request",
    });
    this.name = "LipilaPaymentReferenceConflictError";
    this.referenceId = referenceId;
  }
}

export class LipilaPaymentStoreError extends LipilaError {
  constructor(operation: LipilaOperation, cause: unknown) {
    super("The configured payment lifecycle store could not complete the operation.", {
      code: "payment_store_error",
      operation,
      outcome: "not_applicable",
      nextStep: "do_not_retry",
      cause,
    });
    this.name = "LipilaPaymentStoreError";
  }
}

export class LipilaPaymentHandlerError extends LipilaError {
  readonly payment: Payment;
  readonly handler: string;

  constructor(operation: LipilaOperation, handler: string, payment: Payment, cause: unknown) {
    super(`The ${handler} lifecycle handler failed.`, {
      code: "payment_handler_error",
      operation,
      outcome: "not_applicable",
      nextStep: "do_not_retry",
      cause,
    });
    this.name = "LipilaPaymentHandlerError";
    this.handler = handler;
    this.payment = payment;
  }
}

export type LipilaWebhookFailureReason =
  | "missing_header"
  | "missing_secret"
  | "invalid_secret"
  | "invalid_timestamp"
  | "timestamp_outside_tolerance"
  | "invalid_signature"
  | "invalid_json";

export class LipilaWebhookVerificationError extends LipilaError {
  readonly reason: LipilaWebhookFailureReason;

  constructor(reason: LipilaWebhookFailureReason, message: string, cause?: unknown) {
    super(message, {
      code: "webhook_verification_error",
      operation: "verify_webhook",
      outcome: "not_applicable",
      nextStep: "do_not_retry",
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = "LipilaWebhookVerificationError";
    this.reason = reason;
  }
}
