export type Config = {
  allowedOrigins: string[];
  shopifyApiVersion: string;
  shopifyClientId: string;
  shopifyClientSecret: string;
  shopifyStoreDomain: string;
};

export function getConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const shopifyStoreDomain = requireEnv(env, "SHOPIFY_STORE_DOMAIN");
  const shopifyClientId = requireEnv(env, "SHOPIFY_CLIENT_ID");
  const shopifyClientSecret = requireEnv(env, "SHOPIFY_CLIENT_SECRET");

  return {
    allowedOrigins: parseCsv(env.ALLOWED_ORIGINS),
    shopifyApiVersion: env.SHOPIFY_API_VERSION || "2026-07",
    shopifyClientId,
    shopifyClientSecret,
    shopifyStoreDomain: normalizeShopDomain(shopifyStoreDomain)
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parseCsv(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeShopDomain(domain: string): string {
  const normalized = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  return normalized.includes(".") ? normalized : `${normalized}.myshopify.com`;
}
