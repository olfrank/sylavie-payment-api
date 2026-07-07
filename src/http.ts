import type { VercelRequest, VercelResponse } from "@vercel/node";

export type ApiErrorCode =
  | "bad_request"
  | "method_not_allowed"
  | "configuration_error"
  | "shopify_error"
  | "internal_error";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export function applyCors(
  req: VercelRequest,
  res: VercelResponse,
  allowedOrigins: string[]
): void {
  const origin = req.headers.origin;
  const allowOrigin =
    typeof origin === "string" && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  if (allowOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

export function sendError(res: VercelResponse, error: unknown): void {
  if (error instanceof ApiError) {
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details
      }
    });
    return;
  }

  console.error(error);
  res.status(500).json({
    error: {
      code: "internal_error",
      message: "An unexpected error occurred."
    }
  });
}
