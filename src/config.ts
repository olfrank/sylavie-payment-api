export type Config = {
  allowedOrigins: string[];
  shopifyAdminAccessToken: string;
  shopifyApiVersion: string;
  shopifyStoreDomain: string;
};

export function getConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const shopifyStoreDomain = requireEnv(env, "SHOPIFY_STORE_DOMAIN");
  const shopifyAdminAccessToken = requireEnv(env, "SHOPIFY_ADMIN_ACCESS_TOKEN");

  return {
    allowedOrigins: parseCsv(env.ALLOWED_ORIGINS),
    shopifyAdminAccessToken,
    shopifyApiVersion: env.SHOPIFY_API_VERSION || "2026-07",
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
  return domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
}
