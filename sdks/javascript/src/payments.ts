import {
  LipilaError,
  LipilaLifecycleNotConfiguredError,
  LipilaUnknownOutcomeError,
} from "./errors.js";
import type { PaymentLifecycle, PreparedPayment } from "./internal/lifecycle.js";
import {
  parseCollection,
  parseJson,
  parseRetryAfter,
  providerErrorDetails,
} from "./internal/response.js";
import { sleep, statusRetryDelay } from "./internal/retry.js";
import {
  type HttpTransport,
  TransportFailure,
  type TransportResponse,
} from "./internal/transport.js";
import {
  type ResolvedConfig,
  requireNonEmptyString,
  resolveStatusMaxAttempts,
  resolveTimeout,
  validateCardInput,
  validateMobileMoneyInput,
} from "./internal/validation.js";
import type {
  CardPaymentsResource,
  CreateCardPaymentInput,
  CreateCardPaymentResult,
  CreateMobileMoneyPaymentInput,
  CreateMobileMoneyPaymentResult,
  CreatePaymentResult,
  LipilaCurrency,
  LipilaOperation,
  LipilaPaymentTransaction,
  MobileMoneyPaymentsResource,
  Payment,
  PaymentMethod,
  PaymentsResource,
  RequestOptions,
  RetrievePaymentOptions,
} from "./types.js";

type MutationOperation = "create_mobile_money_payment" | "create_card_payment";

function isAmbiguousMutationStatus(status: number): boolean {
  return status === 408 || status >= 500;
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function httpError(
  operation: LipilaOperation,
  response: TransportResponse,
  outcome: "not_started" | "not_applicable",
): LipilaError {
  const details = providerErrorDetails(response.body);
  const retryAfterMs = parseRetryAfter(response.headers);
  const code =
    response.status === 401
      ? "authentication_error"
      : response.status === 403
        ? "forbidden"
        : response.status === 404
          ? "not_found"
          : response.status === 429
            ? "rate_limited"
            : "provider_error";
  const nextStep =
    operation === "retrieve_payment" && shouldRetryStatus(response.status)
      ? "retry_status"
      : response.status === 400
        ? "fix_request"
        : "do_not_retry";

  return new LipilaError(details.message, {
    code,
    operation,
    outcome,
    nextStep,
    httpStatus: response.status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(details.providerCode === undefined ? {} : { providerCode: details.providerCode }),
  });
}

function requestAborted(operation: LipilaOperation, cause: unknown): LipilaError {
  const mutation =
    operation === "create_mobile_money_payment" || operation === "create_card_payment";
  return new LipilaError("The request was aborted before it could complete.", {
    code: "request_aborted",
    operation,
    outcome: mutation ? "not_started" : "not_applicable",
    nextStep: operation === "retrieve_payment" ? "retry_status" : "do_not_retry",
    cause,
  });
}

function unknownOutcome(
  operation: MutationOperation,
  referenceId: string,
  message: string,
  options: { cause?: unknown; httpStatus?: number },
): LipilaUnknownOutcomeError {
  return new LipilaUnknownOutcomeError(referenceId, message, { operation, ...options });
}

async function waitBeforeReadRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
  try {
    await sleep(milliseconds, signal);
  } catch (cause) {
    throw requestAborted("retrieve_payment", cause);
  }
}

function createResult(referenceId: string, payment: LipilaPaymentTransaction): CreatePaymentResult {
  const redirect = payment.cardRedirectionUrl;
  return Object.freeze({
    submittedReferenceId: referenceId,
    payment,
    ...(typeof redirect === "string" && redirect.trim() !== ""
      ? { action: Object.freeze({ type: "redirect" as const, url: redirect }) }
      : {}),
  });
}

function methodFromTransaction(transaction: LipilaPaymentTransaction): PaymentMethod {
  const paymentType = transaction.paymentType?.toLowerCase();
  if (paymentType === "card") return "card";
  if (
    paymentType?.includes("money") === true ||
    paymentType?.includes("kwacha") === true ||
    paymentType?.includes("mobile") === true
  ) {
    return "mobile_money";
  }
  return "unknown";
}

const DEFAULT_CURRENCY = "ZMW" as const;

interface CreateRequest {
  operation: MutationOperation;
  method: Exclude<PaymentMethod, "unknown">;
  referenceId: string;
  amount: number;
  currency: LipilaCurrency;
  endpoint: string;
  body: string;
  callbackUrl?: string;
  options?: RequestOptions;
}

class PaymentCreator {
  readonly #config: ResolvedConfig;
  readonly #transport: HttpTransport;
  readonly #lifecycle: PaymentLifecycle | undefined;

  constructor(
    config: ResolvedConfig,
    transport: HttpTransport,
    lifecycle: PaymentLifecycle | undefined,
  ) {
    this.#config = config;
    this.#transport = transport;
    this.#lifecycle = lifecycle;
  }

  async create(request: CreateRequest): Promise<CreatePaymentResult> {
    const timeoutMs = resolveTimeout(request.options, this.#config.timeoutMs, request.operation);
    if (request.options?.signal?.aborted) {
      throw requestAborted(request.operation, request.options.signal.reason);
    }

    let prepared: PreparedPayment | undefined;
    if (this.#lifecycle !== undefined) {
      prepared = await this.#lifecycle.prepare(
        request.referenceId,
        request.method,
        request.amount,
        request.currency,
        request.body,
        request.operation,
      );
      if (prepared.existing !== undefined) {
        if (prepared.existing.transaction !== undefined) {
          return createResult(request.referenceId, prepared.existing.transaction);
        }
        throw unknownOutcome(
          request.operation,
          request.referenceId,
          "This payment was prepared previously and now requires reconciliation before another action.",
          {},
        );
      }
    }

    let response: TransportResponse;
    try {
      response = await this.#transport.send({
        method: "POST",
        url: new URL(request.endpoint, this.#config.baseUrl),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-api-key": this.#config.apiKey,
          ...(request.callbackUrl === undefined ? {} : { callbackUrl: request.callbackUrl }),
        },
        body: request.body,
        timeoutMs,
        ...(request.options?.signal === undefined ? {} : { signal: request.options.signal }),
      });
    } catch (cause) {
      const error = unknownOutcome(
        request.operation,
        request.referenceId,
        "Lipila may have received the payment request. Reconcile by referenceId before taking another action.",
        { cause },
      );
      if (this.#lifecycle !== undefined) {
        await this.#lifecycle.reconciling(request.referenceId, request.method, request.operation);
      }
      throw error;
    }

    if (isAmbiguousMutationStatus(response.status)) {
      const error = unknownOutcome(
        request.operation,
        request.referenceId,
        "Lipila returned an ambiguous response. Reconcile by referenceId before taking another action.",
        { httpStatus: response.status },
      );
      if (this.#lifecycle !== undefined) {
        await this.#lifecycle.reconciling(request.referenceId, request.method, request.operation);
      }
      throw error;
    }

    if (response.status < 200 || response.status >= 300) {
      const error = httpError(request.operation, response, "not_started");
      if (this.#lifecycle !== undefined && prepared !== undefined) {
        await this.#lifecycle.release(prepared.intent, request.operation);
      }
      throw error;
    }

    let payment: LipilaPaymentTransaction;
    try {
      payment = parseCollection(parseJson(response.body, request.operation), request.operation);
    } catch (cause) {
      const error = unknownOutcome(
        request.operation,
        request.referenceId,
        "Lipila accepted the request but returned an unreadable payment. Reconcile by referenceId.",
        { cause },
      );
      if (this.#lifecycle !== undefined) {
        await this.#lifecycle.reconciling(request.referenceId, request.method, request.operation);
      }
      throw error;
    }

    if (this.#lifecycle !== undefined) {
      await this.#lifecycle.observe(
        request.referenceId,
        request.method,
        payment,
        "initiation",
        request.operation,
      );
    }
    return createResult(request.referenceId, payment);
  }
}

class MobileMoneyPayments implements MobileMoneyPaymentsResource {
  readonly #creator: PaymentCreator;

  constructor(creator: PaymentCreator) {
    this.#creator = creator;
  }

  async create(
    input: CreateMobileMoneyPaymentInput,
    options?: RequestOptions,
  ): Promise<CreateMobileMoneyPaymentResult> {
    const urls = validateMobileMoneyInput(input);
    const currency = input.currency ?? DEFAULT_CURRENCY;
    const body = JSON.stringify({
      referenceId: input.referenceId,
      amount: input.amount,
      narration: input.narration,
      accountNumber: input.accountNumber,
      currency,
      ...(input.email === undefined ? {} : { email: input.email }),
      ...(input.referenceData === undefined ? {} : { referenceData: input.referenceData }),
    });
    return this.#creator.create({
      operation: "create_mobile_money_payment",
      method: "mobile_money",
      referenceId: input.referenceId,
      amount: input.amount,
      currency,
      endpoint: "/api/v1/collections/mobile-money",
      body,
      ...(urls.callbackUrl === undefined ? {} : { callbackUrl: urls.callbackUrl }),
      ...(options === undefined ? {} : { options }),
    });
  }
}

class CardPayments implements CardPaymentsResource {
  readonly #creator: PaymentCreator;

  constructor(creator: PaymentCreator) {
    this.#creator = creator;
  }

  async create(
    input: CreateCardPaymentInput,
    options?: RequestOptions,
  ): Promise<CreateCardPaymentResult> {
    const urls = validateCardInput(input);
    const currency = input.currency ?? DEFAULT_CURRENCY;
    const body = JSON.stringify({
      customerInfo: input.customer,
      collectionRequest: {
        referenceId: input.referenceId,
        amount: input.amount,
        narration: input.narration,
        accountNumber: input.accountNumber,
        currency,
        backUrl: urls.backUrl,
        referenceData: input.referenceData,
      },
    });
    return this.#creator.create({
      operation: "create_card_payment",
      method: "card",
      referenceId: input.referenceId,
      amount: input.amount,
      currency,
      endpoint: "/api/v1/collections/card",
      body,
      ...(urls.callbackUrl === undefined ? {} : { callbackUrl: urls.callbackUrl }),
      ...(options === undefined ? {} : { options }),
    });
  }
}

export class LipilaPayments implements PaymentsResource {
  readonly mobileMoney: MobileMoneyPaymentsResource;
  readonly card: CardPaymentsResource;
  readonly #config: ResolvedConfig;
  readonly #transport: HttpTransport;
  readonly #lifecycle: PaymentLifecycle | undefined;

  constructor(
    config: ResolvedConfig,
    transport: HttpTransport,
    lifecycle: PaymentLifecycle | undefined,
  ) {
    this.#config = config;
    this.#transport = transport;
    this.#lifecycle = lifecycle;
    const creator = new PaymentCreator(config, transport, lifecycle);
    this.mobileMoney = new MobileMoneyPayments(creator);
    this.card = new CardPayments(creator);
  }

  async retrieve(
    referenceId: string,
    options?: RetrievePaymentOptions,
  ): Promise<LipilaPaymentTransaction> {
    return this.#retrieve(referenceId, options, "retrieve_payment");
  }

  async reconcile(referenceId: string, options?: RetrievePaymentOptions): Promise<Payment> {
    if (this.#lifecycle === undefined) {
      throw new LipilaLifecycleNotConfiguredError("reconcile_payment");
    }
    const transaction = await this.#retrieve(referenceId, options, "reconcile_payment");
    const existing = await this.#lifecycle.get(referenceId);
    return this.#lifecycle.observe(
      referenceId,
      existing?.method ?? methodFromTransaction(transaction),
      transaction,
      "reconciliation",
      "reconcile_payment",
    );
  }

  async get(referenceId: string): Promise<Payment | null> {
    requireNonEmptyString(referenceId, "referenceId", "get_payment");
    if (this.#lifecycle === undefined) {
      throw new LipilaLifecycleNotConfiguredError("get_payment");
    }
    return this.#lifecycle.get(referenceId);
  }

  async #retrieve(
    referenceId: string,
    options: RetrievePaymentOptions | undefined,
    operation: "retrieve_payment" | "reconcile_payment",
  ): Promise<LipilaPaymentTransaction> {
    requireNonEmptyString(referenceId, "referenceId", operation);
    const timeoutMs = resolveTimeout(options, this.#config.timeoutMs, operation);
    const maxAttempts = resolveStatusMaxAttempts(options);
    if (options?.signal?.aborted) throw requestAborted(operation, options.signal.reason);

    const url = new URL("/api/v1/collections/check-status", this.#config.baseUrl);
    url.searchParams.set("referenceId", referenceId);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let response: TransportResponse;
      try {
        response = await this.#transport.send({
          method: "GET",
          url,
          headers: { accept: "application/json", "x-api-key": this.#config.apiKey },
          timeoutMs,
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (cause) {
        if (
          cause instanceof TransportFailure &&
          cause.kind === "aborted" &&
          options?.signal?.aborted
        ) {
          throw requestAborted(operation, cause);
        }
        if (attempt + 1 < maxAttempts) {
          await waitBeforeReadRetry(statusRetryDelay(attempt), options?.signal);
          continue;
        }
        throw new LipilaError("The payment could not be retrieved from Lipila.", {
          code: "transport_error",
          operation,
          outcome: "not_applicable",
          nextStep: "retry_status",
          cause,
        });
      }

      if (response.status >= 200 && response.status < 300) {
        try {
          return parseCollection(parseJson(response.body, operation), operation);
        } catch (cause) {
          if (attempt + 1 < maxAttempts) {
            await waitBeforeReadRetry(statusRetryDelay(attempt), options?.signal);
            continue;
          }
          throw cause;
        }
      }
      if (shouldRetryStatus(response.status) && attempt + 1 < maxAttempts) {
        await waitBeforeReadRetry(
          statusRetryDelay(attempt, parseRetryAfter(response.headers)),
          options?.signal,
        );
        continue;
      }
      throw httpError(operation, response, "not_applicable");
    }

    throw new LipilaError("The payment could not be retrieved from Lipila.", {
      code: "transport_error",
      operation,
      outcome: "not_applicable",
      nextStep: "retry_status",
    });
  }
}
