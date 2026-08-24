import type {
  LipilaPaymentTransaction,
  Payment,
  PaymentIntent,
  PaymentObservation,
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
  parseStoredPayment,
  providerIdentities,
  required,
  shouldApplyPayment,
  validateIdentifier,
  validateNamespace,
} from "@cozycodr/lipila-store-core";
import { Pool, type PoolClient } from "pg";

export type PostgresPaymentStoreOptions =
  | { namespace: string; pool: Pool; connectionString?: never; leaseMs?: number }
  | { namespace: string; connectionString: string; pool?: never; leaseMs?: number };

interface PaymentRow {
  fingerprint: string;
  payment: Payment | string;
}
interface WebhookRow {
  state: "processing" | "completed";
  token: string;
  expires_at: Date;
}

const MIGRATION = `
CREATE TABLE IF NOT EXISTS lipila_store_schema (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS lipila_payments (
  namespace varchar(255) NOT NULL, reference_id varchar(255) NOT NULL, fingerprint varchar(128) NOT NULL,
  payment jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (namespace, reference_id)
);
CREATE TABLE IF NOT EXISTS lipila_observations (
  namespace varchar(255) NOT NULL, observation_id varchar(255) NOT NULL, payment jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (namespace, observation_id)
);
CREATE TABLE IF NOT EXISTS lipila_identities (
  namespace varchar(255) NOT NULL, provider_identity varchar(255) NOT NULL, reference_id varchar(255) NOT NULL,
  PRIMARY KEY (namespace, provider_identity)
);
CREATE TABLE IF NOT EXISTS lipila_webhooks (
  namespace varchar(255) NOT NULL, webhook_id varchar(255) NOT NULL, state varchar(16) NOT NULL,
  token uuid NOT NULL, expires_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, webhook_id)
);
INSERT INTO lipila_store_schema(version) VALUES (1) ON CONFLICT DO NOTHING;
`;

function placeholder(intent: PaymentIntent): Payment {
  return { referenceId: intent.referenceId, method: intent.method, state: "reconciling" };
}

function adapterError(cause: unknown): PaymentStoreAdapterError {
  if (cause instanceof PaymentStoreAdapterError) return cause;
  if ((cause as { code?: string } | null | undefined)?.code === "42P01") {
    return new PaymentStoreAdapterError(
      "migration_required",
      "PostgreSQL lifecycle tables are missing. Run store.migrate().",
      cause,
    );
  }
  // Preserve the driver error: without it every deadlock, connection reset and
  // constraint violation collapses into one indistinguishable string.
  return new PaymentStoreAdapterError(
    "unavailable",
    "PostgreSQL lifecycle store operation failed.",
    cause,
  );
}

export function postgresPaymentStore(options: PostgresPaymentStoreOptions): ManagedPaymentStore {
  const namespace = validateNamespace(options.namespace);
  const leaseMs = options.leaseMs ?? DEFAULT_WEBHOOK_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0)
    throw new TypeError("leaseMs must be a positive integer.");
  if (
    "connectionString" in options &&
    (typeof options.connectionString !== "string" || options.connectionString === "")
  ) {
    throw new TypeError("connectionString must be a non-empty string.");
  }
  const owned = "connectionString" in options;
  const pool = owned ? new Pool({ connectionString: options.connectionString }) : options.pool;

  async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (cause) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw cause;
    } finally {
      client.release();
    }
  }

  async function get(
    referenceId: string,
    client: Pool | PoolClient = pool,
  ): Promise<Payment | null> {
    const result = await client.query<Pick<PaymentRow, "payment">>(
      "SELECT payment FROM lipila_payments WHERE namespace = $1 AND reference_id = $2",
      [namespace, referenceId],
    );
    return result.rowCount === 0
      ? null
      : parseStoredPayment(required(result.rows[0], "Payment row is missing.").payment);
  }

  return {
    protocolVersion: PAYMENT_STORE_PROTOCOL_VERSION,
    async migrate() {
      try {
        await transaction(async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext('cozycodr_lipila_store'))");
          await client.query(MIGRATION);
        });
      } catch (cause) {
        throw adapterError(cause);
      }
    },
    async close() {
      if (owned) await pool.end();
    },
    async prepare(intent): Promise<PreparePaymentResult> {
      try {
        const payment = placeholder(intent);
        const inserted = await pool.query(
          `INSERT INTO lipila_payments(namespace, reference_id, fingerprint, payment) VALUES ($1,$2,$3,$4::jsonb)
           ON CONFLICT DO NOTHING RETURNING reference_id`,
          [namespace, intent.referenceId, intent.fingerprint, assertJsonSize(payment)],
        );
        if ((inserted.rowCount ?? 0) === 1) return { status: "created" };
        const existing = await pool.query<PaymentRow>(
          "SELECT fingerprint, payment FROM lipila_payments WHERE namespace=$1 AND reference_id=$2",
          [namespace, intent.referenceId],
        );
        if (existing.rowCount === 0)
          throw new PaymentStoreAdapterError(
            "unavailable",
            "Reference reservation could not be read.",
          );
        const row = required(existing.rows[0], "Existing payment row is missing.");
        return {
          status: "existing",
          fingerprint: row.fingerprint,
          payment: parseStoredPayment(row.payment),
        };
      } catch (cause) {
        throw adapterError(cause);
      }
    },
    async release(intent) {
      try {
        await pool.query(
          "DELETE FROM lipila_payments WHERE namespace=$1 AND reference_id=$2 AND fingerprint=$3 AND payment->>'state'='reconciling'",
          [namespace, intent.referenceId, intent.fingerprint],
        );
      } catch (cause) {
        throw adapterError(cause);
      }
    },
    async record(observation: PaymentObservation): Promise<RecordPaymentResult> {
      try {
        assertJsonSize(observation);
        return await transaction(async (client) => {
          const duplicate = await client.query<Pick<PaymentRow, "payment">>(
            "SELECT payment FROM lipila_observations WHERE namespace=$1 AND observation_id=$2",
            [namespace, observation.id],
          );
          if ((duplicate.rowCount ?? 0) > 0)
            return {
              status: "duplicate",
              payment: parseStoredPayment(
                required(duplicate.rows[0], "Observation row is missing.").payment,
              ),
            };
          const row = await client.query<PaymentRow>(
            "SELECT fingerprint, payment FROM lipila_payments WHERE namespace=$1 AND reference_id=$2 FOR UPDATE",
            [namespace, observation.payment.referenceId],
          );
          if (row.rowCount === 0)
            throw new PaymentStoreAdapterError(
              "conflict",
              "Payment was not prepared before observation.",
            );
          const current = parseStoredPayment(
            required(row.rows[0], "Locked payment row is missing.").payment,
          );
          for (const identity of providerIdentities(observation.payment)) {
            const claimed = await client.query<{ reference_id: string }>(
              `INSERT INTO lipila_identities(namespace, provider_identity, reference_id) VALUES ($1,$2,$3)
               ON CONFLICT (namespace, provider_identity) DO UPDATE SET provider_identity=EXCLUDED.provider_identity RETURNING reference_id`,
              [namespace, identity, observation.payment.referenceId],
            );
            if (
              required(claimed.rows[0], "Provider identity row is missing.").reference_id !==
              observation.payment.referenceId
            ) {
              throw new PaymentStoreAdapterError(
                "conflict",
                "A provider identity belongs to another payment.",
              );
            }
          }
          const applied = shouldApplyPayment(current, observation.payment);
          const projected = applied ? observation.payment : current;
          if (applied) {
            await client.query(
              "UPDATE lipila_payments SET payment=$3::jsonb, updated_at=now() WHERE namespace=$1 AND reference_id=$2",
              [namespace, observation.payment.referenceId, assertJsonSize(projected)],
            );
          }
          // DO NOTHING rather than letting a primary-key violation escape as an
          // opaque "unavailable": the same observation id arriving for a second
          // reference is a duplicate, not an outage.
          const stored = await client.query(
            "INSERT INTO lipila_observations(namespace, observation_id, payment) VALUES ($1,$2,$3::jsonb) ON CONFLICT (namespace, observation_id) DO NOTHING",
            [namespace, observation.id, assertJsonSize(projected)],
          );
          if ((stored.rowCount ?? 0) === 0) return { status: "duplicate", payment: projected };
          return { status: applied ? "recorded" : "stale", payment: projected };
        });
      } catch (cause) {
        throw adapterError(cause);
      }
    },
    async resolve(transactionValue: LipilaPaymentTransaction) {
      try {
        const values = [
          ...new Set(
            [transactionValue.referenceId, transactionValue.identifier].filter(
              (value): value is string => typeof value === "string" && value !== "",
            ),
          ),
        ];
        if (values.length === 0) return null;
        const result = await pool.query<{ reference_id: string }>(
          `SELECT reference_id FROM lipila_identities WHERE namespace=$1 AND provider_identity=ANY($2::text[])
           UNION SELECT reference_id FROM lipila_payments WHERE namespace=$1 AND reference_id=ANY($2::text[])`,
          [namespace, values],
        );
        const references = [...new Set(result.rows.map((row) => row.reference_id))];
        return references.length === 1
          ? get(required(references[0], "Resolved payment reference is missing."))
          : null;
      } catch (cause) {
        throw adapterError(cause);
      }
    },
    async get(referenceId) {
      try {
        return await get(referenceId);
      } catch (cause) {
        throw adapterError(cause);
      }
    },
    async processWebhook<T>(
      webhookId: string,
      work: (claim: WebhookClaim) => Promise<T>,
    ): Promise<WebhookProcessingResult<T>> {
      validateIdentifier(webhookId, "webhookId");
      const token = ownershipToken();
      let claim: "first" | "takeover" | "duplicate" | "in_progress";
      try {
        claim = await transaction(async (client) => {
          await client.query(
            `INSERT INTO lipila_webhooks(namespace, webhook_id, state, token, expires_at) VALUES ($1,$2,'processing',$3,now()+($4 * interval '1 millisecond')) ON CONFLICT DO NOTHING`,
            [namespace, webhookId, token, leaseMs],
          );
          // Expiry is evaluated by the database, not the application clock: a
          // skewed worker must not treat a live lease as expired and take over.
          const result = await client.query<WebhookRow & { expired: boolean }>(
            "SELECT state, token, expires_at, (expires_at <= now()) AS expired FROM lipila_webhooks WHERE namespace=$1 AND webhook_id=$2 FOR UPDATE",
            [namespace, webhookId],
          );
          const row = required(result.rows[0], "Webhook lease row is missing.");
          if (row.state === "completed") return "duplicate" as const;
          if (row.token === token) return "first" as const;
          if (!row.expired) return "in_progress" as const;
          await client.query(
            "UPDATE lipila_webhooks SET token=$3, expires_at=now()+($4 * interval '1 millisecond'), updated_at=now() WHERE namespace=$1 AND webhook_id=$2",
            [namespace, webhookId, token, leaseMs],
          );
          return "takeover" as const;
        });
      } catch (cause) {
        throw adapterError(cause);
      }
      if (claim !== "first" && claim !== "takeover") return { status: claim };

      let value: T;
      try {
        value = await work({ attempt: claim });
      } catch (cause) {
        await pool
          .query(
            "DELETE FROM lipila_webhooks WHERE namespace=$1 AND webhook_id=$2 AND token=$3 AND state='processing'",
            [namespace, webhookId, token],
          )
          .catch(() => undefined);
        throw cause;
      }

      try {
        const completed = await pool.query(
          "UPDATE lipila_webhooks SET state='completed', updated_at=now() WHERE namespace=$1 AND webhook_id=$2 AND token=$3 AND state='processing'",
          [namespace, webhookId, token],
        );
        return (completed.rowCount ?? 0) === 1
          ? { status: "processed", value }
          : { status: "in_progress" };
      } catch (cause) {
        throw adapterError(cause);
      }
    },
  };
}

export type { ManagedPaymentStore } from "@cozycodr/lipila-store-core";
