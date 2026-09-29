const webhookUrl =
  process.env.SHOPIFY_ORDERS_PAID_WEBHOOK_URL ||
  "https://sylavie-payment-api.vercel.app/api/webhooks/orders-paid";

const config = {
  shopifyStoreDomain: normalizeShopDomain(requiredEnv("SHOPIFY_STORE_DOMAIN")),
  shopifyClientId: requiredEnv("SHOPIFY_CLIENT_ID"),
  shopifyClientSecret: requiredEnv("SHOPIFY_CLIENT_SECRET"),
  shopifyApiVersion: process.env.SHOPIFY_API_VERSION || "2026-07"
};

const existingSubscriptionQuery = `
  query ExistingOrdersPaidWebhooks($topics: [WebhookSubscriptionTopic!]) {
    webhookSubscriptions(first: 100, topics: $topics) {
      edges {
        node {
          id
          topic
          uri
        }
      }
    }
  }
`;

const mutation = `
  mutation RegisterOrdersPaidWebhook(
    $topic: WebhookSubscriptionTopic!
    $webhookSubscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription {
        id
        topic
        uri
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const accessToken = await getShopifyAdminAccessToken(config);

const existingResponse = await shopifyGraphQl(accessToken, existingSubscriptionQuery, {
  topics: ["ORDERS_PAID"]
});
const existingSubscription =
  existingResponse.webhookSubscriptions.edges
    .map((edge) => edge.node)
    .find((subscription) => subscription.topic === "ORDERS_PAID" && subscription.uri === webhookUrl);

if (existingSubscription) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        alreadyRegistered: true,
        webhookSubscription: existingSubscription
      },
      null,
      2
    )
  );
  process.exit(0);
}

const payload = await shopifyGraphQl(accessToken, mutation, {
  topic: "ORDERS_PAID",
  webhookSubscription: {
    uri: webhookUrl,
    format: "JSON"
  }
});
const createPayload = payload.webhookSubscriptionCreate;

if (!createPayload || createPayload.userErrors.length > 0) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        userErrors: createPayload?.userErrors || []
      },
      null,
      2
    )
  );
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      alreadyRegistered: false,
      webhookSubscription: createPayload.webhookSubscription
    },
    null,
    2
  )
);

async function shopifyGraphQl(accessToken, query, variables) {
  const response = await fetch(
  `https://${config.shopifyStoreDomain}/admin/api/${config.shopifyApiVersion}/graphql.json`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken
    },
    body: JSON.stringify({ query, variables })
  }
  );

  const body = await response.json().catch(() => null);

  if (!response.ok || body?.errors?.length || !body?.data) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          status: response.status,
          errors: body?.errors?.map((error) => error.message) || []
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  return body.data;
}

async function getShopifyAdminAccessToken(shopifyConfig) {
  const response = await fetch(`https://${shopifyConfig.shopifyStoreDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: shopifyConfig.shopifyClientId,
      client_secret: shopifyConfig.shopifyClientSecret
    })
  });

  const body = await response.json().catch(() => null);

  if (!response.ok || typeof body?.access_token !== "string") {
    console.error(
      JSON.stringify(
        {
          ok: false,
          status: response.status,
          message: "Shopify token exchange failed."
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  return body.access_token;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function normalizeShopDomain(domain) {
  const normalized = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  return normalized.includes(".") ? normalized : `${normalized}.myshopify.com`;
}
