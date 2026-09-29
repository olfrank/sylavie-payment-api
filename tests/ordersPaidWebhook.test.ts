import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import assert from "node:assert/strict";
import test from "node:test";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import handler from "../api/webhooks/orders-paid.js";

const WEBHOOK_SECRET = "test-secret";

type MockResponse = VercelResponse & {
  statusCodeValue?: number;
  jsonBody?: unknown;
};

function webhookPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 123,
    admin_graphql_api_id: "gid://shopify/Order/123",
    tags: "",
    ...overrides
  };
}

function sign(rawBody: Buffer): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("base64");
}

function mockRequest(payload: Record<string, unknown>, hmac?: string): VercelRequest {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const req = Readable.from([rawBody]) as VercelRequest;

  req.method = "POST";
  req.headers = {
    "x-shopify-hmac-sha256": hmac ?? sign(rawBody)
  };

  return req;
}

function mockResponse(): MockResponse {
  return {
    status(code: number) {
      this.statusCodeValue = code;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
      return this;
    }
  } as MockResponse;
}

function withEnv(): NodeJS.ProcessEnv {
  const originalEnv = process.env;

  process.env = {
    ...originalEnv,
    SHOPIFY_STORE_DOMAIN: "test-shop.myshopify.com",
    SHOPIFY_CLIENT_ID: "client-id",
    SHOPIFY_CLIENT_SECRET: WEBHOOK_SECRET,
    SHOPIFY_API_VERSION: "2026-07"
  };

  return originalEnv;
}

function installFetchMock(options: {
  fulfillmentOrder?: {
    status?: string;
    requestStatus?: string;
    supportedActions?: Array<{ action: string }>;
    remainingQuantity?: number;
  };
  onGraphQlBody?: (body: Record<string, unknown>) => void;
} = {}): typeof fetch {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const endpoint = String(url);

    if (endpoint.endsWith("/admin/oauth/access_token")) {
      return Response.json({ access_token: "test-token", expires_in: 60 });
    }

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    options.onGraphQlBody?.(body);

    if (String(body.query).includes("PaymentOrderFulfillmentLookup")) {
      const fulfillmentOrder = options.fulfillmentOrder ?? {};

      return Response.json({
        data: {
          order: {
            id: "gid://shopify/Order/123",
            displayFulfillmentStatus:
              fulfillmentOrder.status === "CLOSED" ? "FULFILLED" : "UNFULFILLED",
            fulfillable: fulfillmentOrder.status !== "CLOSED",
            tags: ["priority-payment"],
            fulfillmentOrders: {
              nodes: [
                {
                  id: "gid://shopify/FulfillmentOrder/1",
                  status: fulfillmentOrder.status ?? "OPEN",
                  requestStatus: fulfillmentOrder.requestStatus ?? "UNSUBMITTED",
                  supportedActions: fulfillmentOrder.supportedActions ?? [
                    { action: "CREATE_FULFILLMENT" }
                  ],
                  lineItems: {
                    nodes: [
                      {
                        id: "gid://shopify/FulfillmentOrderLineItem/1",
                        remainingQuantity: fulfillmentOrder.remainingQuantity ?? 1
                      }
                    ]
                  }
                }
              ]
            }
          }
        }
      });
    }

    return Response.json({
      data: {
        fulfillmentCreate: {
          fulfillment: {
            id: "gid://shopify/Fulfillment/1"
          },
          userErrors: []
        }
      }
    });
  }) as typeof fetch;

  return originalFetch;
}

test("invalid HMAC is rejected", async () => {
  const originalEnv = withEnv();
  const originalFetch = installFetchMock();
  const res = mockResponse();

  try {
    await handler(mockRequest(webhookPayload(), "invalid-signature"), res);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }

  assert.equal(res.statusCodeValue, 401);
});

test("normal order is ignored", async () => {
  const originalEnv = withEnv();
  const graphQlBodies: Record<string, unknown>[] = [];
  const originalFetch = installFetchMock({
    onGraphQlBody: (body) => graphQlBodies.push(body)
  });
  const res = mockResponse();

  try {
    await handler(mockRequest(webhookPayload({ tags: "spring, swimwear" })), res);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }

  assert.equal(res.statusCodeValue, 200);
  assert.equal(graphQlBodies.length, 0);
});

test("priority-payment order is fulfilled without customer notification or tracking", async () => {
  const originalEnv = withEnv();
  const graphQlBodies: Record<string, unknown>[] = [];
  const originalFetch = installFetchMock({
    onGraphQlBody: (body) => graphQlBodies.push(body)
  });
  const res = mockResponse();

  try {
    await handler(mockRequest(webhookPayload({ tags: "priority-payment, SV1421" })), res);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }

  const fulfillmentMutation = graphQlBodies.find((body) =>
    String(body.query).includes("FulfillPaymentOrder")
  );
  const fulfillment = (fulfillmentMutation?.variables as { fulfillment: Record<string, unknown> })
    .fulfillment;

  assert.equal(res.statusCodeValue, 200);
  assert.equal(fulfillment.notifyCustomer, false);
  assert.equal("trackingInfo" in fulfillment, false);
});

test("additional-payment order is eligible for fulfillment", async () => {
  const originalEnv = withEnv();
  const graphQlBodies: Record<string, unknown>[] = [];
  const originalFetch = installFetchMock({
    onGraphQlBody: (body) => graphQlBodies.push(body)
  });
  const res = mockResponse();

  try {
    await handler(mockRequest(webhookPayload({ tags: "additional-payment" })), res);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }

  assert.equal(res.statusCodeValue, 200);
  assert.equal(
    graphQlBodies.some((body) => String(body.query).includes("FulfillPaymentOrder")),
    true
  );
});

test("already fulfilled order safely no-ops", async () => {
  const originalEnv = withEnv();
  const graphQlBodies: Record<string, unknown>[] = [];
  const originalFetch = installFetchMock({
    fulfillmentOrder: { status: "CLOSED" },
    onGraphQlBody: (body) => graphQlBodies.push(body)
  });
  const res = mockResponse();

  try {
    await handler(mockRequest(webhookPayload({ tags: "priority-payment" })), res);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }

  assert.equal(res.statusCodeValue, 200);
  assert.equal(
    graphQlBodies.some((body) => String(body.query).includes("FulfillPaymentOrder")),
    false
  );
});

test("no actionable fulfillment order safely no-ops", async () => {
  const originalEnv = withEnv();
  const graphQlBodies: Record<string, unknown>[] = [];
  const originalFetch = installFetchMock({
    fulfillmentOrder: { supportedActions: [], remainingQuantity: 1 },
    onGraphQlBody: (body) => graphQlBodies.push(body)
  });
  const res = mockResponse();

  try {
    await handler(mockRequest(webhookPayload({ tags: "priority-payment" })), res);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }

  assert.equal(res.statusCodeValue, 200);
  assert.equal(
    graphQlBodies.some((body) => String(body.query).includes("FulfillPaymentOrder")),
    false
  );
});

test("retried webhook does not create a duplicate fulfillment after order is fulfilled", async () => {
  const originalEnv = withEnv();
  const graphQlBodies: Record<string, unknown>[] = [];
  const originalFetch = installFetchMock({
    onGraphQlBody: (body) => graphQlBodies.push(body)
  });
  const res1 = mockResponse();
  const res2 = mockResponse();

  try {
    await handler(mockRequest(webhookPayload({ tags: "priority-payment" })), res1);

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const endpoint = String(url);

      if (endpoint.endsWith("/admin/oauth/access_token")) {
        return Response.json({ access_token: "test-token", expires_in: 60 });
      }

      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      graphQlBodies.push(body);

      return Response.json({
        data: {
          order: {
            id: "gid://shopify/Order/123",
            displayFulfillmentStatus: "FULFILLED",
            fulfillable: false,
            tags: ["priority-payment"],
            fulfillmentOrders: { nodes: [] }
          }
        }
      });
    }) as typeof fetch;

    await handler(mockRequest(webhookPayload({ tags: "priority-payment" })), res2);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }

  assert.equal(res1.statusCodeValue, 200);
  assert.equal(res2.statusCodeValue, 200);
  assert.equal(
    graphQlBodies.filter((body) => String(body.query).includes("FulfillPaymentOrder")).length,
    1
  );
});
