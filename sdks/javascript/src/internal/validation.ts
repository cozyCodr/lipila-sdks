import { LipilaError } from "../errors.js";
import type {
  CreateCardPaymentInput,
  CreateMobileMoneyPaymentInput,
  LipilaConfig,
  LipilaOperation,
  PaymentLifecycleConfig,
  RequestOptions,
  RetrievePaymentOptions,
} from "../types.js";

export const DEFAULT_TIMEOUT_MS = 15_000;

function isMutation(operation: LipilaOperation): boolean {
  return operation === "create_mobile_money_payment" || operation === "create_card_payment";
}

function validationError(operation: LipilaOperation, message: string): never {
  throw new LipilaError(message, {
    code: "validation_error",
    operation,
    outcome: isMutation(operation) ? "not_started" : "not_applicable",
    nextStep: "fix_request",
  });
}

export function requireNonEmptyString(
  value: unknown,
  name: string,
  operation: LipilaOperation,
): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    validationError(operation, `${name} must be a non-empty string.`);
  }
}

function validateOptionalString(value: unknown, name: string, operation: LipilaOperation): void {
  if (value !== undefined) requireNonEmptyString(value, name, operation);
}

/**
 * Loopback destinations permitted over plain HTTP for local development.
 * `URL` normalizes IPv6 hosts to bracketed form and lowercases the host, so
 * `[::1]` is the reachable spelling. `0.0.0.0` is deliberately excluded: it is
 * a bind-any address, never a routable callback target.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host === "[::ffff:127.0.0.1]" ||
    /^127\./.test(host)
  );
}

function validateAmountAndCurrency(
  input: { amount: unknown; currency?: unknown },
  operation: LipilaOperation,
): void {
  if (typeof input.amount !== "number" || !Number.isFinite(input.amount) || input.amount <= 0) {
    validationError(operation, "amount must be a finite number greater than zero.");
  }
  // currency is optional and defaults to "ZMW"; validate only the shape when supplied.
  if (
    input.currency !== undefined &&
    (typeof input.currency !== "string" || !/^[A-Z]{3}$/.test(input.currency))
  ) {
    validationError(operation, 'currency must be a 3-letter ISO 4217 code such as "ZMW" or "USD".');
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Validates a caller-supplied URL and returns its normalized form. */
function validateUrl(value: unknown, name: string, operation: LipilaOperation): string {
  requireNonEmptyString(value, name, operation);
  // `new URL()` silently strips tabs and newlines, so a CRLF-laced string would
  // validate here and still carry the raw control characters into an HTTP header.
  // Reject them outright, and return the normalized href rather than the input.
  if (hasControlCharacter(value)) {
    validationError(operation, `${name} must not contain control characters.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    validationError(operation, `${name} must be a valid absolute URL.`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    validationError(operation, `${name} must not embed credentials.`);
  }
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))
  ) {
    validationError(operation, `${name} must use HTTPS (HTTP is allowed only for loopback hosts).`);
  }
  return parsed.href;
}

/** Normalized URL values, safe to place in an HTTP header. */
export interface ValidatedUrls {
  callbackUrl?: string;
  backUrl?: string;
}

export function validateMobileMoneyInput(input: CreateMobileMoneyPaymentInput): ValidatedUrls {
  const operation = "create_mobile_money_payment" as const;
  if (typeof input !== "object" || input === null) {
    validationError(operation, "A mobile-money payment request is required.");
  }
  requireNonEmptyString(input.referenceId, "referenceId", operation);
  requireNonEmptyString(input.narration, "narration", operation);
  requireNonEmptyString(input.accountNumber, "accountNumber", operation);
  validateAmountAndCurrency(input, operation);
  validateOptionalString(input.email, "email", operation);
  validateOptionalString(input.referenceData, "referenceData", operation);
  return input.callbackUrl === undefined
    ? {}
    : { callbackUrl: validateUrl(input.callbackUrl, "callbackUrl", operation) };
}

export function validateCardInput(input: CreateCardPaymentInput): ValidatedUrls {
  const operation = "create_card_payment" as const;
  if (typeof input !== "object" || input === null) {
    validationError(operation, "A card payment request is required.");
  }
  requireNonEmptyString(input.referenceId, "referenceId", operation);
  requireNonEmptyString(input.narration, "narration", operation);
  requireNonEmptyString(input.accountNumber, "accountNumber", operation);
  // Lipila documents referenceData as required for the card endpoint.
  requireNonEmptyString(input.referenceData, "referenceData", operation);
  validateAmountAndCurrency(input, operation);
  const backUrl = validateUrl(input.backUrl, "backUrl", operation);
  const callbackUrl =
    input.callbackUrl === undefined
      ? undefined
      : validateUrl(input.callbackUrl, "callbackUrl", operation);

  if (typeof input.customer !== "object" || input.customer === null) {
    validationError(operation, "customer is required for a card payment.");
  }
  for (const field of [
    "firstName",
    "lastName",
    "phoneNumber",
    "email",
    "city",
    "country",
    "address",
    "zip",
  ] as const) {
    requireNonEmptyString(input.customer[field], `customer.${field}`, operation);
  }
  return { backUrl, ...(callbackUrl === undefined ? {} : { callbackUrl }) };
}

function validateLifecycle(lifecycle: PaymentLifecycleConfig): void {
  if (typeof lifecycle !== "object" || lifecycle === null) {
    validationError("handle_webhook", "lifecycle must be an object.");
  }
  const store = lifecycle.store as unknown;
  if (typeof store !== "object" || store === null) {
    validationError("handle_webhook", "lifecycle.store is required.");
  }
  if ((store as Record<string, unknown>).protocolVersion !== 2) {
    validationError(
      "handle_webhook",
      "lifecycle.store.protocolVersion must be 2. Update or replace the store adapter.",
    );
  }
  for (const method of [
    "prepare",
    "release",
    "record",
    "resolve",
    "processWebhook",
    "get",
  ] as const) {
    if (typeof (store as Record<string, unknown>)[method] !== "function") {
      validationError("handle_webhook", `lifecycle.store.${method} must be a function.`);
    }
  }
  if (lifecycle.on !== undefined) {
    if (typeof lifecycle.on !== "object" || lifecycle.on === null) {
      validationError("handle_webhook", "lifecycle.on must be an object.");
    }
    for (const handler of Object.values(lifecycle.on)) {
      if (handler !== undefined && typeof handler !== "function") {
        validationError("handle_webhook", "Every lifecycle handler must be a function.");
      }
    }
  }
}

export interface ResolvedConfig {
  apiKey: string;
  baseUrl: URL;
  /** Webhook secrets decoded to their raw 32-byte keys once, at construction. */
  webhookSecrets: readonly Buffer[];
  timeoutMs: number;
  fetch: typeof globalThis.fetch;
  lifecycle: PaymentLifecycleConfig | undefined;
}

/**
 * Decodes a base64 (optionally `whsec_`-prefixed) webhook secret to its raw
 * 32-byte key. Validation happens once at construction so a malformed secret
 * fails fast as a configuration error instead of surfacing on the first live
 * webhook — and so one bad secret never blocks verification with a valid one.
 */
function decodeWebhookSecret(secret: string): Buffer {
  const configError = (): never => {
    throw new LipilaError(
      "webhookSecret must be a base64-encoded 32-byte key (optionally prefixed with whsec_).",
      {
        code: "configuration_error",
        operation: "verify_webhook",
        outcome: "not_applicable",
        nextStep: "fix_request",
      },
    );
  };

  // Secrets are commonly read from mounted files or `cat`, which leave a trailing
  // newline. Trim before validating so that is not a deploy-time failure.
  const trimmed = typeof secret === "string" ? secret.trim() : secret;
  const value = trimmed.startsWith("whsec_") ? trimmed.slice("whsec_".length) : trimmed;
  if (value.trim() === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) configError();

  const key = Buffer.from(value, "base64");
  const canonical = key.toString("base64").replace(/=+$/u, "");
  if (key.byteLength !== 32 || canonical !== value.replace(/=+$/u, "")) configError();
  return key;
}

export function resolveConfig(config: LipilaConfig): ResolvedConfig {
  if (typeof config !== "object" || config === null) {
    throw new LipilaError("Lipila configuration is required.", {
      code: "configuration_error",
      operation: "create_mobile_money_payment",
      outcome: "not_started",
      nextStep: "fix_request",
    });
  }
  if (typeof config.apiKey !== "string" || config.apiKey.trim() === "") {
    throw new LipilaError("apiKey must be a non-empty string.", {
      code: "configuration_error",
      operation: "create_mobile_money_payment",
      outcome: "not_started",
      nextStep: "fix_request",
    });
  }
  // A key carrying a character that is illegal in an HTTP header makes the fetch
  // implementation throw a TypeError that embeds the header VALUE, which would
  // then travel in the error `cause` chain into application logs. Reject it here,
  // and never include the value in the message.
  const apiKey = config.apiKey.trim();
  if (!/^[!-~]+$/u.test(apiKey)) {
    throw new LipilaError(
      "apiKey must contain only printable ASCII characters. Check for whitespace or newlines around the value.",
      {
        code: "configuration_error",
        operation: "create_mobile_money_payment",
        outcome: "not_started",
        nextStep: "fix_request",
      },
    );
  }

  const environment = config.environment ?? "sandbox";
  if (environment !== "sandbox" && environment !== "production") {
    throw new LipilaError('environment must be "sandbox" or "production".', {
      code: "configuration_error",
      operation: "create_mobile_money_payment",
      outcome: "not_started",
      nextStep: "fix_request",
    });
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new LipilaError("timeoutMs must be a positive integer.", {
      code: "configuration_error",
      operation: "create_mobile_money_payment",
      outcome: "not_started",
      nextStep: "fix_request",
    });
  }
  if (config.fetch !== undefined && typeof config.fetch !== "function") {
    throw new LipilaError("fetch must be a function.", {
      code: "configuration_error",
      operation: "create_mobile_money_payment",
      outcome: "not_started",
      nextStep: "fix_request",
    });
  }
  if (
    config.webhookSecret !== undefined &&
    typeof config.webhookSecret !== "string" &&
    (!Array.isArray(config.webhookSecret) ||
      config.webhookSecret.some((secret) => typeof secret !== "string"))
  ) {
    throw new LipilaError("webhookSecret must be a string or an array of strings.", {
      code: "configuration_error",
      operation: "verify_webhook",
      outcome: "not_applicable",
      nextStep: "fix_request",
    });
  }
  if (config.lifecycle !== undefined) validateLifecycle(config.lifecycle);

  const webhookSecrets = (
    config.webhookSecret === undefined
      ? []
      : typeof config.webhookSecret === "string"
        ? [config.webhookSecret]
        : [...config.webhookSecret]
  ).map(decodeWebhookSecret);

  return {
    apiKey,
    baseUrl: new URL(
      environment === "sandbox" ? "https://api.lipila.dev" : "https://blz.lipila.io",
    ),
    webhookSecrets,
    timeoutMs,
    fetch: config.fetch ?? globalThis.fetch,
    lifecycle: config.lifecycle,
  };
}

export function resolveStatusMaxAttempts(options: RetrievePaymentOptions | undefined): number {
  if (options?.retry === undefined) return 1;
  const { maxAttempts } = options.retry;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 2 || maxAttempts > 6) {
    validationError("retrieve_payment", "retry.maxAttempts must be an integer from 2 through 6.");
  }
  return maxAttempts;
}

export function resolveTimeout(
  options: RequestOptions | undefined,
  fallback: number,
  operation: LipilaOperation,
): number {
  const timeoutMs = options?.timeoutMs ?? fallback;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    validationError(operation, "timeoutMs must be a positive integer.");
  }
  return timeoutMs;
}
