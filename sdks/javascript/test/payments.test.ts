import { describe, expect, it, vi } from "vitest";

import {
  type CreateCardPaymentInput,
  LipilaError,
  LipilaUnknownOutcomeError,
  lipila,
} from "../src/index.js";

function asFetch(
  implementation: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return implementation as typeof fetch;
}

describe("mobile-money payments", () => {
  it("uses the lowercase factory and sends the provider-native request", async () => {
    const fetchMock = vi.fn(
      asFetch(async (input, init) => {
        expect(String(input)).toBe("https://api.lipila.dev/api/v1/collections/mobile-money");
        expect(init?.method).toBe("POST");
        expect(init?.redirect).toBe("error");
        expect(init?.headers).toEqual({
          accept: "application/json",
          "content-type": "application/json",
          "x-api-key": "lipila_test_key",
          callbackUrl: "https://merchant.example/webhooks/lipila",
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          referenceId: "order-1001",
          amount: 125.5,
          narration: "Order 1001",
          accountNumber: "260971234567",
          currency: "ZMW",
          email: "buyer@example.com",
          referenceData: "cart-44",
        });
        return Response.json({
          status: "Pending",
          identifier: "provider-987",
          futureField: "preserved",
        });
      }),
    );
    const client = lipila({ apiKey: "lipila_test_key", fetch: fetchMock });

    const result = await client.payments.mobileMoney.create({
      referenceId: "order-1001",
      amount: 125.5,
      narration: "Order 1001",
      accountNumber: "260971234567",
      currency: "ZMW",
      email: "buyer@example.com",
      referenceData: "cart-44",
      callbackUrl: "https://merchant.example/webhooks/lipila",
    });

    expect(result.submittedReferenceId).toBe("order-1001");
    expect(result.payment.status).toBe("Pending");
    expect(result.payment.identifier).toBe("provider-987");
    expect(result.payment.raw.futureField).toBe("preserved");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns a provider business failure instead of throwing", async () => {
    const client = lipila({
      apiKey: "lipila_live_key",
      environment: "production",
      fetch: asFetch(async (input) => {
        expect(String(input)).toBe("https://blz.lipila.io/api/v1/collections/mobile-money");
        return Response.json({ status: "Failed", message: "Subscriber declined" });
      }),
    });

    const result = await client.payments.mobileMoney.create({
      referenceId: "order-1002",
      amount: 10,
      narration: "Order 1002",
      accountNumber: "260971234567",
      currency: "ZMW",
    });
    expect(result.payment).toMatchObject({ status: "Failed", message: "Subscriber declined" });
  });

  it("validates locally before dispatch", async () => {
    const fetchMock = vi.fn(asFetch(async () => Response.json({ status: "Pending" })));
    const client = lipila({ apiKey: "lipila_test_key", fetch: fetchMock });

    await expect(
      client.payments.mobileMoney.create({
        referenceId: "order-1003",
        amount: 0,
        narration: "Order 1003",
        accountNumber: "260971234567",
        currency: "ZMW",
      }),
    ).rejects.toMatchObject({ code: "validation_error", outcome: "not_started" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never retries an ambiguous creation", async () => {
    const fetchMock = vi.fn(
      asFetch(async () => {
        throw new TypeError("socket closed");
      }),
    );
    const client = lipila({ apiKey: "lipila_test_key", fetch: fetchMock });
    const promise = client.payments.mobileMoney.create({
      referenceId: "order-1004",
      amount: 10,
      narration: "Order 1004",
      accountNumber: "260971234567",
      currency: "ZMW",
    });

    await expect(promise).rejects.toBeInstanceOf(LipilaUnknownOutcomeError);
    await expect(promise).rejects.toMatchObject({
      referenceId: "order-1004",
      operation: "create_mobile_money_payment",
      nextStep: "reconcile_by_reference",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("defaults currency to ZMW and accepts USD", async () => {
    const currencies: unknown[] = [];
    const client = lipila({
      apiKey: "test",
      fetch: asFetch(async (_input, init) => {
        currencies.push(JSON.parse(String(init?.body)).currency);
        return Response.json({ status: "Pending" });
      }),
    });
    const base = { referenceId: "c", amount: 10, narration: "n", accountNumber: "260971234567" };

    await client.payments.mobileMoney.create(base);
    await client.payments.mobileMoney.create({ ...base, currency: "USD" });

    expect(currencies).toEqual(["ZMW", "USD"]);
  });

  it("rejects a malformed currency before dispatch", async () => {
    const fetchMock = vi.fn(asFetch(async () => Response.json({ status: "Pending" })));
    const client = lipila({ apiKey: "test", fetch: fetchMock });

    await expect(
      client.payments.mobileMoney.create({
        referenceId: "c",
        amount: 10,
        narration: "n",
        accountNumber: "260971234567",
        currency: "zmw" as "ZMW",
      }),
    ).rejects.toMatchObject({ code: "validation_error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-HTTPS callbackUrl but allows localhost", async () => {
    const fetchMock = vi.fn(asFetch(async () => Response.json({ status: "Pending" })));
    const client = lipila({ apiKey: "test", fetch: fetchMock });
    const base = { referenceId: "c", amount: 10, narration: "n", accountNumber: "260971234567" };

    await expect(
      client.payments.mobileMoney.create({ ...base, callbackUrl: "http://merchant.example/hook" }),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      client.payments.mobileMoney.create({ ...base, callbackUrl: "http://localhost:3000/hook" }),
    ).resolves.toMatchObject({ payment: { status: "Pending" } });
  });
});

describe("card payments", () => {
  it("creates a hosted card payment and returns the redirect action", async () => {
    const fetchMock = vi.fn(
      asFetch(async (input, init) => {
        expect(String(input)).toBe("https://api.lipila.dev/api/v1/collections/card");
        expect(init?.headers).toEqual({
          accept: "application/json",
          "content-type": "application/json",
          "x-api-key": "lipila_test_key",
          callbackUrl: "https://merchant.example/webhooks/lipila",
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          customerInfo: {
            firstName: "Jane",
            lastName: "Doe",
            phoneNumber: "260971234567",
            email: "jane@example.com",
            city: "Lusaka",
            country: "ZM",
            address: "Plot 10",
            zip: "10101",
          },
          collectionRequest: {
            referenceId: "card-order-1",
            amount: 200,
            narration: "Card order 1",
            accountNumber: "customer-1",
            currency: "ZMW",
            backUrl: "https://merchant.example/checkout/return",
            referenceData: "cart-1",
          },
        });
        return Response.json({
          status: "Pending",
          paymentType: "Card",
          cardRedirectionUrl: "https://checkout.lipila.example/session-1",
        });
      }),
    );
    const client = lipila({ apiKey: "lipila_test_key", fetch: fetchMock });

    const result = await client.payments.card.create({
      referenceId: "card-order-1",
      amount: 200,
      narration: "Card order 1",
      accountNumber: "customer-1",
      currency: "ZMW",
      customer: {
        firstName: "Jane",
        lastName: "Doe",
        phoneNumber: "260971234567",
        email: "jane@example.com",
        city: "Lusaka",
        country: "ZM",
        address: "Plot 10",
        zip: "10101",
      },
      backUrl: "https://merchant.example/checkout/return",
      referenceData: "cart-1",
      callbackUrl: "https://merchant.example/webhooks/lipila",
    });

    expect(result.payment.status).toBe("Pending");
    expect(result.action).toEqual({
      type: "redirect",
      url: "https://checkout.lipila.example/session-1",
    });
  });

  it("rejects an incomplete customer before dispatch", async () => {
    const fetchMock = vi.fn(asFetch(async () => Response.json({ status: "Pending" })));
    const client = lipila({ apiKey: "lipila_test_key", fetch: fetchMock });

    await expect(
      client.payments.card.create({
        referenceId: "card-order-2",
        amount: 200,
        narration: "Card order 2",
        accountNumber: "customer-2",
        currency: "ZMW",
        customer: {
          firstName: "",
          lastName: "Doe",
          phoneNumber: "260971234567",
          email: "jane@example.com",
          city: "Lusaka",
          country: "ZM",
          address: "Plot 10",
          zip: "10101",
        },
        backUrl: "https://merchant.example/checkout/return",
        referenceData: "cart-2",
      }),
    ).rejects.toMatchObject({ code: "validation_error", operation: "create_card_payment" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the same unknown-outcome safety as mobile money", async () => {
    const fetchMock = vi.fn(asFetch(async () => new Response("", { status: 500 })));
    const client = lipila({ apiKey: "lipila_test_key", fetch: fetchMock });

    await expect(
      client.payments.card.create({
        referenceId: "card-order-3",
        amount: 200,
        narration: "Card order 3",
        accountNumber: "customer-3",
        currency: "ZMW",
        customer: {
          firstName: "Jane",
          lastName: "Doe",
          phoneNumber: "260971234567",
          email: "jane@example.com",
          city: "Lusaka",
          country: "ZM",
          address: "Plot 10",
          zip: "10101",
        },
        backUrl: "https://merchant.example/checkout/return",
        referenceData: "cart-3",
      }),
    ).rejects.toMatchObject({
      code: "unknown_outcome",
      operation: "create_card_payment",
      httpStatus: 500,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("requires referenceData, which Lipila documents as required for cards", async () => {
    const fetchMock = vi.fn(asFetch(async () => Response.json({ status: "Pending" })));
    const client = lipila({ apiKey: "test", fetch: fetchMock });
    const input = {
      referenceId: "card-no-ref",
      amount: 200,
      narration: "Card order",
      accountNumber: "customer-1",
      customer: {
        firstName: "Jane",
        lastName: "Doe",
        phoneNumber: "260971234567",
        email: "jane@example.com",
        city: "Lusaka",
        country: "ZM",
        address: "Plot 10",
        zip: "10101",
      },
      backUrl: "https://merchant.example/checkout/return",
    };

    await expect(
      client.payments.card.create(input as unknown as CreateCardPaymentInput),
    ).rejects.toMatchObject({ code: "validation_error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("defaults card currency to ZMW and sends the normalized backUrl", async () => {
    let body: Record<string, unknown> | undefined;
    const client = lipila({
      apiKey: "test",
      fetch: asFetch(async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({ status: "Pending" });
      }),
    });

    await client.payments.card.create({
      referenceId: "card-defaults",
      amount: 200,
      narration: "Card order",
      accountNumber: "customer-1",
      customer: {
        firstName: "Jane",
        lastName: "Doe",
        phoneNumber: "260971234567",
        email: "jane@example.com",
        city: "Lusaka",
        country: "ZM",
        address: "Plot 10",
        zip: "10101",
      },
      backUrl: "https://merchant.example/checkout/return",
      referenceData: "cart-9",
    });

    expect(
      (body as { collectionRequest: Record<string, unknown> }).collectionRequest,
    ).toMatchObject({
      currency: "ZMW",
      referenceData: "cart-9",
      backUrl: "https://merchant.example/checkout/return",
    });
  });
});

describe("payment retrieval", () => {
  it("URL-encodes references and preserves unknown statuses", async () => {
    const client = lipila({
      apiKey: "lipila_test_key",
      fetch: asFetch(async (input, init) => {
        expect(String(input)).toBe(
          "https://api.lipila.dev/api/v1/collections/check-status?referenceId=order+%26+10",
        );
        expect(init?.method).toBe("GET");
        return Response.json({ status: "Processing", newField: true });
      }),
    });

    const payment = await client.payments.retrieve("order & 10");
    expect(payment.status).toBe("Processing");
    expect(payment.raw.newField).toBe(true);
  });

  it("retries only when the caller opts in", async () => {
    const fetchMock = vi.fn(
      asFetch(async () => {
        if (fetchMock.mock.calls.length === 1) {
          return new Response("", { status: 429, headers: { "retry-after": "0" } });
        }
        return Response.json({ status: "Successful" });
      }),
    );
    const client = lipila({ apiKey: "lipila_test_key", fetch: fetchMock });

    await expect(client.payments.retrieve("one-attempt")).rejects.toMatchObject({
      code: "rate_limited",
    });
    expect(fetchMock).toHaveBeenCalledOnce();

    fetchMock.mockClear();
    const payment = await client.payments.retrieve("two-attempts", {
      retry: { maxAttempts: 2 },
    });
    expect(payment.status).toBe("Successful");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces typed provider errors", async () => {
    const client = lipila({
      apiKey: "lipila_test_key",
      fetch: asFetch(async () =>
        Response.json({ message: "Transaction not found" }, { status: 404 }),
      ),
    });
    const promise = client.payments.retrieve("missing");
    await expect(promise).rejects.toBeInstanceOf(LipilaError);
    await expect(promise).rejects.toMatchObject({ code: "not_found", httpStatus: 404 });
  });
});
