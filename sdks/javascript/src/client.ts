import { PaymentLifecycle } from "./internal/lifecycle.js";
import { FetchTransport } from "./internal/transport.js";
import { resolveConfig } from "./internal/validation.js";
import { LipilaPayments } from "./payments.js";
import type { LipilaClient, LipilaConfig, PaymentsResource, WebhooksResource } from "./types.js";
import { LipilaWebhooks } from "./webhooks.js";

class LipilaClientImplementation implements LipilaClient {
  readonly payments: PaymentsResource;
  readonly webhooks: WebhooksResource;

  constructor(config: LipilaConfig) {
    const resolved = resolveConfig(config);
    const transport = new FetchTransport(resolved.fetch);
    const lifecycle =
      resolved.lifecycle === undefined ? undefined : new PaymentLifecycle(resolved.lifecycle);

    this.payments = new LipilaPayments(resolved, transport, lifecycle);
    this.webhooks = new LipilaWebhooks(resolved.webhookSecrets, lifecycle);
  }
}

/** Creates one configured Lipila client with Stripe-style payment resources. */
export function lipila(config: LipilaConfig): LipilaClient {
  return new LipilaClientImplementation(config);
}
