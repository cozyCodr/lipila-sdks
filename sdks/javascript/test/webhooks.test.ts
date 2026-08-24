import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LipilaWebhookVerificationError, lipila } from "../src/index.js";

interface SignatureFixture {
  secretBase64: string;
  webhookId: string;
  webhookTimestamp: string;
  rawBody: string;
  signatureHeader: string;
}

const FIXTURE = JSON.parse(
  readFileSync(new URL("../../../spec/fixtures/webhook-hmac-sha256.json", import.meta.url), "utf8"),
) as SignatureFixture;
const SECRET = FIXTURE.secretBase64;
const WEBHOOK_ID = FIXTURE.webhookId;
const TIMESTAMP = Number(FIXTURE.webhookTimestamp);

function signature(body: string, secret = SECRET): string {
  const key = Buffer.from(secret, "base64");
  const digest = createHmac("sha256", key)
    .update(`${WEBHOOK_ID}.${TIMESTAMP}.${body}`)
    .digest("base64");
  return `v1,${digest}`;
}

function headers(body: string): Record<string, string> {
  return {
    "webhook-id": WEBHOOK_ID,
    "webhook-timestamp": String(TIMESTAMP),
    "webhook-signature": signature(body),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("webhook verification", () => {
  it("matches the independent HMAC-SHA256 known-answer vector", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(TIMESTAMP * 1_000));
    const client = lipila({ apiKey: "unused", webhookSecret: SECRET });

    const event = client.webhooks.verify({
      rawBody: FIXTURE.rawBody,
      headers: {
        "webhook-id": WEBHOOK_ID,
        "webhook-timestamp": FIXTURE.webhookTimestamp,
        "webhook-signature": FIXTURE.signatureHeader,
      },
    });

    expect(event).toMatchObject({
      id: WEBHOOK_ID,
      shape: "envelope",
      type: "transaction.completed",
      data: { status: "Successful" },
    });
  });

  it("classifies the documented flat transaction callback", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(TIMESTAMP * 1_000));
    const body = '{"status":"Successful","referenceId":"order-1001"}';
    const client = lipila({ apiKey: "unused", webhookSecret: SECRET });

    const event = client.webhooks.verify({ rawBody: Buffer.from(body), headers: headers(body) });

    expect(event.shape).toBe("transaction");
    if (event.shape === "transaction") {
      expect(event.transaction.referenceId).toBe("order-1001");
    }
  });

  it("accepts overlapping secrets and multiple v1 signatures during rotation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(TIMESTAMP * 1_000));
    const body = '{"status":"Pending"}';
    const wrongSecret = Buffer.alloc(32, 9).toString("base64");
    const client = lipila({
      apiKey: "unused",
      webhookSecret: [wrongSecret, SECRET],
    });

    const event = client.webhooks.verify({
      rawBody: body,
      headers: {
        ...headers(body),
        "webhook-signature": `${signature(body, wrongSecret)} ${signature(body)}`,
      },
    });

    expect(event.shape).toBe("transaction");
  });

  it("rejects a body changed after signing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(TIMESTAMP * 1_000));
    const signedBody = '{"status":"Pending"}';
    const client = lipila({ apiKey: "unused", webhookSecret: SECRET });

    expect(() =>
      client.webhooks.verify({
        rawBody: '{"status": "Pending"}',
        headers: headers(signedBody),
      }),
    ).toThrowError(LipilaWebhookVerificationError);
  });

  it("rejects stale timestamps and incomplete headers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date((TIMESTAMP + 301) * 1_000));
    const body = '{"status":"Pending"}';
    const client = lipila({ apiKey: "unused", webhookSecret: SECRET });

    expect(() => client.webhooks.verify({ rawBody: body, headers: headers(body) })).toThrowError(
      expect.objectContaining({ reason: "timestamp_outside_tolerance" }),
    );
    expect(() => client.webhooks.verify({ rawBody: body, headers: {} })).toThrowError(
      expect.objectContaining({ reason: "missing_header" }),
    );
  });

  it("rejects a non-canonical timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(TIMESTAMP * 1_000));
    const body = '{"status":"Pending"}';
    const client = lipila({ apiKey: "unused", webhookSecret: SECRET });

    expect(() =>
      client.webhooks.verify({
        rawBody: body,
        headers: { ...headers(body), "webhook-timestamp": `${TIMESTAMP}.0` },
      }),
    ).toThrowError(expect.objectContaining({ reason: "invalid_timestamp" }));
  });

  it("rejects a malformed webhook secret at construction, not on first webhook", () => {
    expect(() => lipila({ apiKey: "unused", webhookSecret: "not valid base64!!" })).toThrowError(
      expect.objectContaining({ code: "configuration_error" }),
    );
    // A single bad secret in a rotation set fails fast too, so it can never
    // silently block verification with a valid sibling secret.
    expect(() => lipila({ apiKey: "unused", webhookSecret: [SECRET, "too-short"] })).toThrowError(
      expect.objectContaining({ code: "configuration_error" }),
    );
  });

  it("verifies bytes before reporting invalid JSON", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(TIMESTAMP * 1_000));
    const body = "not-json";
    const client = lipila({ apiKey: "unused", webhookSecret: SECRET });

    expect(() => client.webhooks.verify({ rawBody: body, headers: headers(body) })).toThrowError(
      expect.objectContaining({ reason: "invalid_json" }),
    );
  });
});
