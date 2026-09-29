import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getConfig } from "../../src/config.js";
import { ApiError, sendError } from "../../src/http.js";
import { fulfillPaidPaymentOrder } from "../../src/paymentFulfillment.js";
import { readRawRequestBody, verifyShopifyWebhookHmac } from "../../src/shopifyWebhook.js";

export const config = {
  api: {
    bodyParser: false
  }
};

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  try {
    if (req.method !== "POST") {
      throw new ApiError(405, "method_not_allowed", "Use POST for this endpoint.");
    }

    const appConfig = getConfig();
    const rawBody = await readRawRequestBody(req);
    const hmacHeader = req.headers["x-shopify-hmac-sha256"];

    if (!verifyShopifyWebhookHmac(rawBody, hmacHeader, appConfig.shopifyClientSecret)) {
      res.status(401).json({
        error: {
          code: "unauthorized",
          message: "Invalid Shopify webhook signature."
        }
      });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new ApiError(400, "bad_request", "Webhook body must be valid JSON.");
    }

    if (!isRecord(payload)) {
      throw new ApiError(400, "bad_request", "Webhook body must be a JSON object.");
    }

    const result = await fulfillPaidPaymentOrder(appConfig, payload);

    res.status(200).json({ ok: true, result });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Missing required environment variable")) {
      sendError(res, new ApiError(500, "configuration_error", error.message));
      return;
    }

    sendError(res, error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
