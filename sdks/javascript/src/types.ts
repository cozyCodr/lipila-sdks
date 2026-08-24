export type LipilaEnvironment = "sandbox" | "production";

export type LipilaOperation =
  | "create_mobile_money_payment"
  | "create_card_payment"
  | "retrieve_payment"
  | "reconcile_payment"
  | "get_payment"
  | "verify_webhook"
  | "handle_webhook";

export type LipilaTransactionStatus = "Pending" | "Successful" | "Failed" | (string & {});

/**
 * ISO 4217 currency code. Lipila documents `ZMW` and `USD`; the open union keeps
 * ZMW and USD discoverable while accepting any code Lipila may add later.
 */
export type LipilaCurrency = "ZMW" | "USD" | (string & {});

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface StatusRetryOptions {
  /** Total attempts, including the first request. Must be between 2 and 6. */
  maxAttempts: number;
}

export interface RetrievePaymentOptions extends RequestOptions {
  /** Opt in to bounded retries for this read-only request. No retries occur by default. */
  retry?: StatusRetryOptions;
}

export interface CreateMobileMoneyPaymentInput {
  referenceId: string;
  amount: number;
  narration: string;
  accountNumber: string;
  /** Optional. Defaults to `"ZMW"`. Lipila also documents `"USD"`. */
  currency?: LipilaCurrency;
  email?: string;
  referenceData?: string;

  /** Sent as Lipila's callbackUrl HTTP header. */
  callbackUrl?: string;
}

export interface CardCustomer {
  firstName: string;
  lastName: string;
  phoneNumber: string;
  email: string;
  city: string;
  country: string;
  address: string;
  zip: string;
}

export interface CreateCardPaymentInput {
  referenceId: string;
  amount: number;
  narration: string;
  accountNumber: string;
  /** Optional. Defaults to `"ZMW"`. Lipila also documents `"USD"`. */
  currency?: LipilaCurrency;
  customer: CardCustomer;
  backUrl: string;
  /** Required by Lipila's card endpoint, unlike the mobile-money endpoint. */
  referenceData: string;

  /** Sent as Lipila's callbackUrl HTTP header. */
  callbackUrl?: string;
}

export interface LipilaPaymentTransaction {
  /** Lipila's provider-native status. Unknown future values are preserved. */
  readonly status: LipilaTransactionStatus;

  readonly referenceId?: string;
  readonly identifier?: string;
  readonly externalId?: string;
  readonly currency?: string;
  readonly amount?: number;
  readonly accountNumber?: string;
  readonly paymentType?: string;
  readonly type?: string;
  readonly message?: string;
  readonly narration?: string;
  readonly referenceData?: string;
  readonly ipAddress?: string;
  readonly cardRedirectionUrl?: string | null;
  readonly createdAt?: string;

  /** Complete response object, including undocumented provider fields. */
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface RedirectPaymentAction {
  readonly type: "redirect";
  readonly url: string;
}

export interface CreatePaymentResult {
  /** Caller-provided reference that remains safe for reconciliation. */
  readonly submittedReferenceId: string;
  readonly payment: LipilaPaymentTransaction;
  readonly action?: RedirectPaymentAction;
}

export type CreateMobileMoneyPaymentResult = CreatePaymentResult;
export type CreateCardPaymentResult = CreatePaymentResult;

export interface MobileMoneyPaymentsResource {
  create(
    input: CreateMobileMoneyPaymentInput,
    options?: RequestOptions,
  ): Promise<CreateMobileMoneyPaymentResult>;
}

export interface CardPaymentsResource {
  create(input: CreateCardPaymentInput, options?: RequestOptions): Promise<CreateCardPaymentResult>;
}

export type PaymentMethod = "mobile_money" | "card" | "unknown";
export type PaymentState =
  | "pending"
  | "action_required"
  | "paid"
  | "failed"
  | "reconciling"
  | "unknown";
export type PaymentObservationSource = "initiation" | "webhook" | "reconciliation";

export interface PaymentIntent {
  readonly referenceId: string;
  readonly method: Exclude<PaymentMethod, "unknown">;
  readonly amount: number;
  readonly currency: LipilaCurrency;
  readonly fingerprint: string;
}

export interface Payment {
  readonly referenceId: string;
  readonly method: PaymentMethod;
  readonly state: PaymentState;
  readonly rawStatus?: string;
  readonly transaction?: LipilaPaymentTransaction;
  readonly action?: RedirectPaymentAction;
}

export interface PaymentObservation {
  readonly id: string;
  readonly source: PaymentObservationSource;
  readonly payment: Payment;
  readonly webhookId?: string;
}

export type PreparePaymentResult =
  | { readonly status: "created" }
  | { readonly status: "existing"; readonly payment: Payment; readonly fingerprint: string };

export type RecordPaymentResult =
  | { readonly status: "recorded"; readonly payment: Payment }
  | { readonly status: "duplicate"; readonly payment: Payment }
  | { readonly status: "stale"; readonly payment: Payment };

export type WebhookProcessingResult<T> =
  | { readonly status: "processed"; readonly value: T }
  | { readonly status: "duplicate" }
  | { readonly status: "in_progress" };

/**
 * Describes how the current worker acquired the webhook claim.
 *
 * `first` means this worker created the webhook record: no other worker holds
 * or held an unexpired lease, so an already-recorded observation can only mean
 * a previous attempt failed after recording and released its claim.
 *
 * `takeover` means this worker reclaimed a lease that expired while another
 * worker held it. That worker may still be running its handler, so the SDK
 * must not re-run a handler for work it already recorded.
 */
export interface WebhookClaim {
  readonly attempt: "first" | "takeover";
}

/**
 * Durable seam used only when lifecycle behavior is enabled.
 * Implementations must be atomic across application processes.
 */
export interface PaymentLifecycleStore {
  /** Store contract version. Prevents incompatible adapters from failing silently. */
  readonly protocolVersion: 2;
  prepare(intent: PaymentIntent): Promise<PreparePaymentResult>;
  /** Releases a prepared intent only when the SDK knows provider dispatch did not start it. */
  release(intent: PaymentIntent): Promise<void>;
  record(observation: PaymentObservation): Promise<RecordPaymentResult>;
  resolve(transaction: LipilaPaymentTransaction): Promise<Payment | null>;
  /**
   * Claims the webhook, runs `work`, and completes the claim only after `work`
   * resolves. `work` receives how the claim was acquired so the SDK can tell a
   * genuine retry apart from a concurrent lease takeover.
   */
  processWebhook<T>(
    webhookId: string,
    work: (claim: WebhookClaim) => Promise<T>,
  ): Promise<WebhookProcessingResult<T>>;
  get(referenceId: string): Promise<Payment | null>;
}

export interface PaymentHandlerContext {
  readonly source: PaymentObservationSource;
  readonly payment: Payment;
  readonly webhookId?: string;
  /** Stable key that application effects should enforce idempotently. */
  readonly idempotencyKey: string;
}

export type PaymentHandler = (context: PaymentHandlerContext) => void | Promise<void>;

export interface PaymentLifecycleHandlers {
  pending?: PaymentHandler;
  actionRequired?: PaymentHandler;
  paid?: PaymentHandler;
  failed?: PaymentHandler;
  reconciling?: PaymentHandler;
  unknown?: PaymentHandler;
  changed?: PaymentHandler;
}

export interface PaymentLifecycleConfig {
  store: PaymentLifecycleStore;
  on?: PaymentLifecycleHandlers;
}

export interface LipilaConfig {
  /** Lipila secret key. Keep this value server-side. */
  apiKey: string;

  /** Defaults to sandbox. Production must be selected explicitly. */
  environment?: LipilaEnvironment;

  /** One secret normally; multiple secrets support rotation overlap. */
  webhookSecret?: string | readonly string[];

  /** Per-request timeout in milliseconds. Defaults to 15 seconds. */
  timeoutMs?: number;

  /** Opt in to durable payment state and centrally registered lifecycle handlers. */
  lifecycle?: PaymentLifecycleConfig;

  /** Advanced adapter for proxies, test doubles, and compatible runtimes. */
  fetch?: typeof globalThis.fetch;
}

export interface PaymentsResource {
  readonly mobileMoney: MobileMoneyPaymentsResource;
  readonly card: CardPaymentsResource;

  retrieve(
    referenceId: string,
    options?: RetrievePaymentOptions,
  ): Promise<LipilaPaymentTransaction>;

  /** Requires lifecycle configuration and feeds provider status through the durable state flow. */
  reconcile(referenceId: string, options?: RetrievePaymentOptions): Promise<Payment>;

  /** Reads the durable local projection. Requires lifecycle configuration. */
  get(referenceId: string): Promise<Payment | null>;
}

export type WebhookHeaders =
  | Headers
  | Readonly<Record<string, string | readonly string[] | undefined>>;

export interface VerifyWebhookInput {
  /** Untouched request bytes or the exact untouched UTF-8 string. */
  rawBody: Uint8Array | string;
  headers: WebhookHeaders;
}

interface VerifiedWebhookBase {
  /** Stable across retries and suitable as the caller's deduplication key. */
  readonly id: string;
  readonly timestamp: Date;
}

export type VerifiedLipilaWebhook =
  | (VerifiedWebhookBase & {
      readonly shape: "transaction";
      readonly transaction: LipilaPaymentTransaction;
      readonly payload: Readonly<Record<string, unknown>>;
    })
  | (VerifiedWebhookBase & {
      readonly shape: "envelope";
      readonly type: string;
      readonly data: unknown;
      readonly payload: Readonly<Record<string, unknown>>;
    })
  | (VerifiedWebhookBase & {
      readonly shape: "unknown";
      readonly payload: unknown;
    });

export type WebhookReceipt =
  | { readonly status: "handled"; readonly acknowledge: true; readonly eventId: string }
  | { readonly status: "duplicate"; readonly acknowledge: true; readonly eventId: string }
  | { readonly status: "in_progress"; readonly acknowledge: false; readonly eventId: string }
  | {
      readonly status: "unresolved";
      readonly acknowledge: false;
      readonly eventId: string;
    };

export interface WebhooksResource {
  verify(input: VerifyWebhookInput): VerifiedLipilaWebhook;
  /** Requires lifecycle configuration. */
  handle(input: VerifyWebhookInput): Promise<WebhookReceipt>;
}

export interface LipilaClient {
  readonly payments: PaymentsResource;
  readonly webhooks: WebhooksResource;
}
