import { getConfig } from "../../src/config.js";
import { fulfillPaidPaymentOrder } from "../../src/paymentFulfillment.js";
import { verifyShopifyWebhookHmac } from "../../src/shopifyWebhook.js";

type ErrorCode = "bad_request" | "configuration_error" | "internal_error" | "unauthorized";

export async function POST(request: Request): Promise<Response> {
  try {
    const appConfig = getConfig();
    const rawBody = Buffer.from(await request.arrayBuffer());
    const hmacHeader = request.headers.get("x-shopify-hmac-sha256") ?? undefined;
    const hmacValid = verifyShopifyWebhookHmac(rawBody, hmacHeader, appConfig.shopifyClientSecret);

    if (!hmacValid) {
      console.warn("Shopify orders/paid webhook rejected: invalid signature.");
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
    logPaymentFulfillmentResult(result);

    return Response.json({ ok: true, result }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Missing required environment variable")) {
      return errorResponse(500, "configuration_error", error.message);
    }

    console.error("Shopify orders/paid webhook failed.", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: sanitizeMessage(error instanceof Error ? error.message : String(error))
    });
    return errorResponse(500, "internal_error", "An unexpected error occurred.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeMessage(message: string): string {
  return message.replace(/[^\w .,:;-]/g, "").slice(0, 200);
}

function logPaymentFulfillmentResult(result: Awaited<ReturnType<typeof fulfillPaidPaymentOrder>>): void {
  if (result.status === "fulfilled") {
    console.log("Shopify payment order fulfilled.", {
      fulfillmentCount: result.fulfillmentCount
    });
    return;
  }

  if (result.status === "noop") {
    console.log("Shopify payment order fulfillment no-op.", {
      reason: result.reason
    });
  }
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
