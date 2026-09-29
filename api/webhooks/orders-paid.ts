import { getConfig } from "../../src/config.js";
import { fulfillPaidPaymentOrder } from "../../src/paymentFulfillment.js";
import { verifyShopifyWebhookHmac } from "../../src/shopifyWebhook.js";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

type ErrorCode = "bad_request" | "configuration_error" | "internal_error" | "unauthorized";

export async function POST(request: Request): Promise<Response> {
  const traceId = randomUUID();
  const debugLog = createDebugLogger(traceId);
  let stage = "request_received";

  try {
    const requestUrl = new URL(request.url);
    debugLog("request_metadata", {
      timestamp: new Date().toISOString(),
      method: request.method,
      pathname: requestUrl.pathname,
      contentType: request.headers.get("content-type"),
      contentLengthHeader: request.headers.get("content-length"),
      userAgent: request.headers.get("user-agent"),
      hasHmacHeader: request.headers.has("x-shopify-hmac-sha256"),
      hasShopDomainHeader: request.headers.has("x-shopify-shop-domain"),
      hasTopicHeader: request.headers.has("x-shopify-topic"),
      hasWebhookIdHeader: request.headers.has("x-shopify-webhook-id"),
      hasApiVersionHeader: request.headers.has("x-shopify-api-version"),
      hasTriggeredAtHeader: request.headers.has("x-shopify-triggered-at"),
      hasEventIdHeader: request.headers.has("x-shopify-event-id"),
      shopDomain: request.headers.get("x-shopify-shop-domain"),
      topic: request.headers.get("x-shopify-topic"),
      apiVersionHeader: request.headers.get("x-shopify-api-version"),
      webhookId: request.headers.get("x-shopify-webhook-id"),
      eventId: request.headers.get("x-shopify-event-id")
    });

    stage = "config_loaded";
    const appConfig = getConfig();
    const envClientId = process.env.SHOPIFY_CLIENT_ID ?? "";
    const envClientSecret = process.env.SHOPIFY_CLIENT_SECRET ?? "";
    const envStoreDomain = process.env.SHOPIFY_STORE_DOMAIN ?? "";

    debugLog("deployed_config", {
      clientIdFingerprint: fingerprint(appConfig.shopifyClientId),
      clientSecretFingerprint: fingerprint(appConfig.shopifyClientSecret),
      secretLength: appConfig.shopifyClientSecret.length,
      secretTrimmedLength: envClientSecret.trim().length,
      secretHasLeadingWhitespace: /^\s/.test(envClientSecret),
      secretHasTrailingWhitespace: /\s$/.test(envClientSecret),
      secretStartsWithQuote: envClientSecret.startsWith('"') || envClientSecret.startsWith("'"),
      secretEndsWithQuote: envClientSecret.endsWith('"') || envClientSecret.endsWith("'"),
      secretContainsNewline: envClientSecret.includes("\n"),
      secretContainsCarriageReturn: envClientSecret.includes("\r"),
      configuredShopifyStoreDomain: appConfig.shopifyStoreDomain,
      shopifyApiVersion: appConfig.shopifyApiVersion,
      hasShopifyClientId: Boolean(envClientId),
      hasShopifyClientSecret: Boolean(envClientSecret),
      hasShopifyStoreDomain: Boolean(envStoreDomain)
    });

    stage = "raw_body_read";
    const rawBody = Buffer.from(await request.arrayBuffer());
    const hmacHeader = request.headers.get("x-shopify-hmac-sha256") ?? undefined;
    const contentLengthHeader = request.headers.get("content-length");
    const numericContentLength =
      contentLengthHeader && /^\d+$/.test(contentLengthHeader)
        ? Number(contentLengthHeader)
        : undefined;

    debugLog("raw_body", {
      rawBodyByteLength: rawBody.byteLength,
      rawBodyFingerprint: fingerprint(rawBody),
      rawBodyLengthIsZero: rawBody.byteLength === 0,
      contentLengthHeader,
      contentLengthMatchesRawBody:
        typeof numericContentLength === "number"
          ? numericContentLength === rawBody.byteLength
          : undefined,
      firstByte: rawBody.byteLength > 0 ? rawBody[0] : undefined,
      lastByte: rawBody.byteLength > 0 ? rawBody[rawBody.byteLength - 1] : undefined
    });

    stage = "hmac_diagnostics";
    const hmacShape = inspectHmacHeader(hmacHeader);
    debugLog("hmac_header_shape", {
      hmacHeaderExists: hmacShape.hmacHeaderExists,
      hmacHeaderLength: hmacShape.hmacHeaderLength,
      hmacHeaderLooksBase64: hmacShape.hmacHeaderLooksBase64,
      decodedLength: hmacShape.decodedLength,
      decodedLengthIs32: hmacShape.decodedLengthIs32
    });

    const parsedForDiagnostics = parseJsonForDiagnostics(rawBody);
    const currentSecretRawBodyMatches = verifyShopifyWebhookHmac(
      rawBody,
      hmacHeader,
      appConfig.shopifyClientSecret
    );
    const trimmedSecretRawBodyMatches = hmacMatches(
      rawBody,
      hmacShape.decoded,
      appConfig.shopifyClientSecret.trim()
    );
    const utf8RoundTrippedBody = Buffer.from(rawBody.toString("utf8"), "utf8");
    const currentSecretUtf8BodyMatches = hmacMatches(
      utf8RoundTrippedBody,
      hmacShape.decoded,
      appConfig.shopifyClientSecret
    );
    const currentSecretJsonReserializedMatches = parsedForDiagnostics.succeeded
      ? hmacMatches(
          Buffer.from(JSON.stringify(parsedForDiagnostics.value), "utf8"),
          hmacShape.decoded,
          appConfig.shopifyClientSecret
        )
      : undefined;
    const hmacValid = currentSecretRawBodyMatches;

    debugLog("hmac_candidate_diagnostics", {
      currentSecretRawBodyMatches,
      trimmedSecretRawBodyMatches,
      currentSecretUtf8BodyMatches,
      currentSecretJsonReserializedMatches
    });

    debugLog("json_parsing", {
      jsonParseSucceeded: parsedForDiagnostics.succeeded,
      parsedValueType: parsedForDiagnostics.valueType,
      parsedObjectHasId: parsedForDiagnostics.succeeded
        ? isRecord(parsedForDiagnostics.value) && "id" in parsedForDiagnostics.value
        : undefined,
      parsedObjectHasTags: parsedForDiagnostics.succeeded
        ? isRecord(parsedForDiagnostics.value) && "tags" in parsedForDiagnostics.value
        : undefined,
      parsedObjectHasFinancialStatus: parsedForDiagnostics.succeeded
        ? isRecord(parsedForDiagnostics.value) && "financial_status" in parsedForDiagnostics.value
        : undefined,
      hasPriorityPaymentTag: parsedForDiagnostics.succeeded
        ? hasPaymentTag(parsedForDiagnostics.value, "priority-payment")
        : undefined,
      hasAdditionalPaymentTag: parsedForDiagnostics.succeeded
        ? hasPaymentTag(parsedForDiagnostics.value, "additional-payment")
        : undefined
    });

    const authReason = getAuthenticationReason(hmacHeader, hmacShape, hmacValid);
    debugLog("auth_decision", {
      authenticationDecision: hmacValid ? "accepted" : "rejected",
      reason: authReason
    });

    if (!hmacValid) {
      debugLog("final_outcome", { finalOutcome: "auth_failed" });
      return errorResponse(401, "unauthorized", "Invalid Shopify webhook signature.");
    }

    stage = "json_parse";
    let payload: unknown;
    if (!parsedForDiagnostics.succeeded) {
      return errorResponse(400, "bad_request", "Webhook body must be valid JSON.");
    }

    payload = parsedForDiagnostics.value;
    debugLog("json_parsed");

    if (!isRecord(payload)) {
      return errorResponse(400, "bad_request", "Webhook body must be a JSON object.");
    }

    stage = "fulfillment_flow";
    const result = await fulfillPaidPaymentOrder(appConfig, payload, debugLog);

    debugLog("handler_complete", { resultStatus: result.status });
    return Response.json({ ok: true, result }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Missing required environment variable")) {
      debugLog("error_boundary", {
        stage,
        errorName: error.name,
        errorMessage: sanitizeMessage(error.message)
      });
      return errorResponse(500, "configuration_error", error.message);
    }

    debugLog("error_boundary", {
      stage,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: sanitizeMessage(error instanceof Error ? error.message : String(error))
    });
    return errorResponse(500, "internal_error", "An unexpected error occurred.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createDebugLogger(traceId: string): (stage: string, details?: Record<string, unknown>) => void {
  return (stage: string, details: Record<string, unknown> = {}) => {
    console.log(
      `[orders-paid-debug] ${JSON.stringify({
        traceId,
        stage,
        ...details
      })}`
    );
  };
}

function fingerprint(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function inspectHmacHeader(hmacHeader: string | undefined): {
  hmacHeaderExists: boolean;
  hmacHeaderLength?: number;
  hmacHeaderLooksBase64: boolean;
  decodedLength?: number;
  decodedLengthIs32?: boolean;
  decoded?: Buffer;
} {
  if (!hmacHeader) {
    return {
      hmacHeaderExists: false,
      hmacHeaderLooksBase64: false
    };
  }

  const hmacHeaderLooksBase64 =
    hmacHeader.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(hmacHeader);
  const decoded = hmacHeaderLooksBase64 ? Buffer.from(hmacHeader, "base64") : undefined;

  return {
    hmacHeaderExists: true,
    hmacHeaderLength: hmacHeader.length,
    hmacHeaderLooksBase64,
    decodedLength: decoded?.length,
    decodedLengthIs32: decoded?.length === 32,
    decoded
  };
}

function hmacMatches(rawBody: Buffer, received: Buffer | undefined, secret: string): boolean {
  if (!received || received.length !== 32) {
    return false;
  }

  const calculated = createHmac("sha256", secret).update(rawBody).digest();

  return calculated.length === received.length && timingSafeEqual(calculated, received);
}

function parseJsonForDiagnostics(rawBody: Buffer):
  | { succeeded: true; value: unknown; valueType: string }
  | { succeeded: false; valueType: undefined } {
  try {
    const value = JSON.parse(rawBody.toString("utf8")) as unknown;
    return { succeeded: true, value, valueType: Array.isArray(value) ? "array" : typeof value };
  } catch {
    return { succeeded: false, valueType: undefined };
  }
}

function hasPaymentTag(value: unknown, tag: "priority-payment" | "additional-payment"): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const tags = value.tags;

  if (Array.isArray(tags)) {
    return tags.some((entry) => typeof entry === "string" && entry.trim().toLowerCase() === tag);
  }

  if (typeof tags === "string") {
    return tags
      .split(",")
      .some((entry) => entry.trim().toLowerCase() === tag);
  }

  return false;
}

function getAuthenticationReason(
  hmacHeader: string | undefined,
  hmacShape: { hmacHeaderLooksBase64: boolean; decodedLengthIs32?: boolean },
  hmacValid: boolean
): "missing_hmac_header" | "malformed_hmac_header" | "hmac_length_mismatch" | "hmac_mismatch" | "hmac_valid" {
  if (!hmacHeader) {
    return "missing_hmac_header";
  }

  if (!hmacShape.hmacHeaderLooksBase64) {
    return "malformed_hmac_header";
  }

  if (!hmacShape.decodedLengthIs32) {
    return "hmac_length_mismatch";
  }

  return hmacValid ? "hmac_valid" : "hmac_mismatch";
}

function sanitizeMessage(message: string): string {
  return message.replace(/[^\w .,:;-]/g, "").slice(0, 200);
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
