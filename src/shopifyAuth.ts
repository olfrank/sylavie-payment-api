import { URLSearchParams } from "node:url";
import { ApiError } from "./http.js";

export type ShopifyAuthConfig = {
  shopifyClientId: string;
  shopifyClientSecret: string;
  shopifyStoreDomain: string;
};

type TokenResponse = {
  access_token?: unknown;
  scope?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
};

type CachedToken = {
  accessToken: string;
  expiresAt: number;
};

let cachedToken: CachedToken | undefined;
let pendingTokenRequest: Promise<string> | undefined;

const TOKEN_REFRESH_BUFFER_MS = 60_000;

export async function getShopifyAdminAccessToken(config: ShopifyAuthConfig): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
    return cachedToken.accessToken;
  }

  if (!pendingTokenRequest) {
    pendingTokenRequest = requestShopifyAdminAccessToken(config).finally(() => {
      pendingTokenRequest = undefined;
    });
  }

  return pendingTokenRequest;
}

async function requestShopifyAdminAccessToken(config: ShopifyAuthConfig): Promise<string> {
  const endpoint = `https://${config.shopifyStoreDomain}/admin/oauth/access_token`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: config.shopifyClientId,
        client_secret: config.shopifyClientSecret
      })
    });
  } catch (error) {
    throw new ApiError(502, "shopify_error", "Shopify token exchange request failed.", {
      endpoint,
      reason: error instanceof Error ? error.message : String(error)
    });
  }

  const body = await readTokenResponse(response);

  if (!response.ok) {
    throw new ApiError(response.status, "shopify_error", "Shopify token exchange failed.", {
      endpoint,
      status: response.status,
      statusText: response.statusText,
      body
    });
  }

  if (
    !body ||
    typeof body === "string" ||
    typeof body.access_token !== "string" ||
    !body.access_token
  ) {
    throw new ApiError(502, "shopify_error", "Shopify token exchange returned no access token.", {
      endpoint,
      body
    });
  }

  if (typeof body.expires_in === "number" && Number.isFinite(body.expires_in)) {
    cachedToken = {
      accessToken: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000
    };
  }

  return body.access_token;
}

async function readTokenResponse(response: Response): Promise<TokenResponse | string | null> {
  const text = await response.text().catch(() => "");

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as TokenResponse;
  } catch {
    return text;
  }
}
