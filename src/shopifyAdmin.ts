import { ApiError } from "./http.js";
import { getShopifyAdminAccessToken } from "./shopifyAuth.js";

export type ShopifyConfig = {
  shopifyApiVersion: string;
  shopifyClientId: string;
  shopifyClientSecret: string;
  shopifyStoreDomain: string;
};

type GraphQlResponse<T> = {
  data?: T;
  errors?: Array<{ message: string; extensions?: unknown }>;
};

export async function shopifyGraphQl<T>(
  config: ShopifyConfig,
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const url = `https://${config.shopifyStoreDomain}/admin/api/${config.shopifyApiVersion}/graphql.json`;
  const accessToken = await getShopifyAdminAccessToken(config);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken
    },
    body: JSON.stringify({ query, variables })
  });

  const body = (await response.json().catch(() => null)) as GraphQlResponse<T> | null;

  if (!response.ok) {
    throw new ApiError(response.status, "shopify_error", "Shopify Admin API request failed.", body);
  }

  if (!body) {
    throw new ApiError(502, "shopify_error", "Shopify returned an invalid JSON response.");
  }

  if (body.errors?.length) {
    throw new ApiError(502, "shopify_error", "Shopify returned GraphQL errors.", body.errors);
  }

  if (!body.data) {
    throw new ApiError(502, "shopify_error", "Shopify returned no GraphQL data.");
  }

  return body.data;
}
