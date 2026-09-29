import { createHmac, timingSafeEqual } from "node:crypto";
import type { VercelRequest } from "@vercel/node";

export async function readRawRequestBody(req: VercelRequest): Promise<Buffer> {
  const body = req.body as unknown;

  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }

  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

export function verifyShopifyWebhookHmac(
  rawBody: Buffer,
  hmacHeader: string | string[] | undefined,
  secret: string
): boolean {
  const hmac = Array.isArray(hmacHeader) ? hmacHeader[0] : hmacHeader;

  if (!hmac || !secret) {
    return false;
  }

  let received: Buffer;
  try {
    received = Buffer.from(hmac, "base64");
  } catch {
    return false;
  }

  const calculated = createHmac("sha256", secret).update(rawBody).digest();

  return received.length === calculated.length && timingSafeEqual(received, calculated);
}
