import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getConfig } from "../../src/config.js";
import { ApiError, applyCors, sendError } from "../../src/http.js";
import { createPaymentDraft, validatePaymentDraftRequest } from "../../src/paymentDrafts.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  let config;

  try {
    config = getConfig();
    applyCors(req, res, config.allowedOrigins);

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    if (req.method !== "POST") {
      throw new ApiError(405, "method_not_allowed", "Use POST for this endpoint.");
    }

    const request = validatePaymentDraftRequest(req.body);
    const paymentDraft = await createPaymentDraft(config, request);

    res.status(201).json(paymentDraft);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Missing required environment variable")) {
      sendError(res, new ApiError(500, "configuration_error", error.message));
      return;
    }

    sendError(res, error);
  }
}
