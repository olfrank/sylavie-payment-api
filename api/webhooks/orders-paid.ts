import { getConfig } from "../../src/config.js";
import { fulfillPaidPaymentOrder } from "../../src/paymentFulfillment.js";
import { verifyShopifyWebhookHmac } from "../../src/shopifyWebhook.js";
import { createHash } from "node:crypto";

type ErrorCode = "bad_request" | "configuration_error" | "internal_error" | "unauthorized";

export async function POST(request: Request): Promise<Response> {
  try {
    const appConfig = getConfig();
    const rawBody = Buffer.from(await request.arrayBuffer());
    const hmacHeader = request.headers.get("x-shopify-hmac-sha256") ?? undefined;
    const hmacValid = verifyShopifyWebhookHmac(rawBody, hmacHeader, appConfig.shopifyClientSecret);

    console.log(
      JSON.stringify({
        clientIdFingerprint: fingerprint(appConfig.shopifyClientId),
        clientSecretFingerprint: fingerprint(appConfig.shopifyClientSecret),
        secretLength: appConfig.shopifyClientSecret.length,
        rawBodyByteLength: rawBody.byteLength,
        hasHmacHeader: Boolean(hmacHeader),
        hmacValid,
        shopDomain: request.headers.get("x-shopify-shop-domain")
      })
    );

    if (!hmacValid) {
      return errorResponse(401, "unauthorized", "Invalid Shopify webhook signature.");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return errorResponse(400, "bad_request", "Webhook body must be valid JSON.");
    }

    if (!isRecord(payload)) {
      return errorResponse(400, "bad_request", "Webhook body must be a JSON object.");
    }

    const result = await fulfillPaidPaymentOrder(appConfig, payload);

    return Response.json({ ok: true, result }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Missing required environment variable")) {
      return errorResponse(500, "configuration_error", error.message);
    }

    console.error(error);
    return errorResponse(500, "internal_error", "An unexpected error occurred.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function errorResponse(status: number, code: ErrorCode, message: string): Response {
  return Response.json(
    {
      error: {
        code,
        message
      }
    },
    { status }
  );
}
