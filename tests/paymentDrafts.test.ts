import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../src/http.js";
import {
  createPaymentDraft,
  toDraftOrderInput,
  validatePaymentDraftRequest
} from "../src/paymentDrafts.js";

function simplePayment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paymentType: "priority",
    amount: "85.50",
    currency: "GBP",
    orderNumber: "SV1421",
    firstName: "Test",
    lastName: "Customer",
    email: "test@example.com",
    country: "United Kingdom",
    countryCode: "GB",
    termsAccepted: true,
    ...overrides
  };
}

test("GB priority payment is taxable and maps a GB billing address", () => {
  const request = validatePaymentDraftRequest(simplePayment());
  const input = toDraftOrderInput(request);

  assert.deepEqual(input.billingAddress, {
    firstName: "Test",
    lastName: "Customer",
    countryCode: "GB"
  });
  assert.equal((input.lineItems as Array<{ taxable: boolean }>)[0]?.taxable, true);
});

test("US additional payment remains taxable and maps a US billing address", () => {
  const request = validatePaymentDraftRequest(
    simplePayment({
      paymentType: "additional",
      country: "United States",
      countryCode: "US",
      reason: "Order change"
    })
  );
  const input = toDraftOrderInput(request);

  assert.deepEqual(input.billingAddress, {
    firstName: "Test",
    lastName: "Customer",
    countryCode: "US"
  });
  assert.equal((input.lineItems as Array<{ taxable: boolean }>)[0]?.taxable, true);
});

test("AU, JE and GG country codes pass through unchanged", () => {
  for (const countryCode of ["AU", "JE", "GG"]) {
    const request = validatePaymentDraftRequest(
      simplePayment({ country: undefined, countryCode })
    );
    const input = toDraftOrderInput(request);

    assert.equal(
      (input.billingAddress as { countryCode: string }).countryCode,
      countryCode
    );
    assert.equal((input.lineItems as Array<{ taxable: boolean }>)[0]?.taxable, true);
  }
});

test("a supplied shipping address is mapped with the authoritative country code", () => {
  const request = validatePaymentDraftRequest(
    simplePayment({
      countryCode: "AU",
      shippingAddress: {
        firstName: "Test",
        lastName: "Customer",
        address1: "1 Harbour Street",
        city: "Sydney",
        provinceCode: "NSW",
        country: "Australia",
        countryCode: "AU",
        zip: "2000"
      }
    })
  );
  const input = toDraftOrderInput(request);

  assert.deepEqual(input.shippingAddress, {
    firstName: "Test",
    lastName: "Customer",
    address1: "1 Harbour Street",
    city: "Sydney",
    provinceCode: "NSW",
    countryCode: "AU",
    zip: "2000"
  });
});

test("missing or invalid countryCode returns a 400 validation error", () => {
  for (const countryCode of [undefined, "", "UK", "GBR", "gb", "ZZ", 123]) {
    assert.throws(
      () => validatePaymentDraftRequest(simplePayment({ countryCode })),
      (error: unknown) =>
        error instanceof ApiError && error.status === 400 && error.code === "bad_request"
    );
  }
});

test("simple payments use the original order address as the draft shipping address", async () => {
  const originalFetch = globalThis.fetch;
  const graphQlBodies: Array<Record<string, unknown>> = [];

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const endpoint = String(url);

    if (endpoint.endsWith("/admin/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "test-token", expires_in: 60 }), {
        status: 200
      });
    }

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    graphQlBodies.push(body);

    if (String(body.query).includes("OriginalOrderAddress")) {
      return Response.json({
        data: {
          orders: {
            nodes: [
              {
                name: "SV1421",
                email: "test@example.com",
                shippingAddress: {
                  firstName: "Original",
                  lastName: "Customer",
                  address1: "10 Market Street",
                  address2: null,
                  city: "New York",
                  provinceCode: "NY",
                  countryCodeV2: "US",
                  zip: "10001",
                  phone: "+12125550100"
                },
                billingAddress: {
                  firstName: "Billing",
                  lastName: "Customer",
                  address1: "1 London Road",
                  address2: null,
                  city: "London",
                  provinceCode: null,
                  countryCodeV2: "GB",
                  zip: "SW1A 1AA",
                  phone: null
                }
              }
            ]
          }
        }
      });
    }

    return Response.json({
      data: {
        draftOrderCreate: {
          draftOrder: {
            id: "gid://shopify/DraftOrder/1",
            invoiceUrl: "https://example.com/invoice"
          },
          userErrors: []
        }
      }
    });
  }) as typeof fetch;

  try {
    await createPaymentDraft(
      {
        shopifyApiVersion: "2026-07",
        shopifyClientId: "client-id",
        shopifyClientSecret: "client-secret",
        shopifyStoreDomain: "test-shop.myshopify.com"
      },
      validatePaymentDraftRequest(
        simplePayment({
          paymentType: "additional",
          country: "United States",
          countryCode: "US",
          reason: "Order change"
        })
      )
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const draftMutation = graphQlBodies.find((body) =>
    String(body.query).includes("DraftOrderCreate")
  );
  const input = (draftMutation?.variables as { input: Record<string, unknown> }).input;

  assert.deepEqual(input.shippingAddress, {
    firstName: "Original",
    lastName: "Customer",
    address1: "10 Market Street",
    city: "New York",
    provinceCode: "NY",
    countryCode: "US",
    zip: "10001",
    phone: "+12125550100"
  });
  assert.deepEqual(input.billingAddress, {
    firstName: "Test",
    lastName: "Customer",
    countryCode: "US"
  });
  assert.equal((input.lineItems as Array<{ taxable: boolean }>)[0]?.taxable, true);
  assert.equal(
    (input.lineItems as Array<{ requiresShipping: boolean }>)[0]?.requiresShipping,
    false
  );
});
