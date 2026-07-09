# Syl'a'Vie Payment API

Minimal Vercel-hosted Node.js API for creating Shopify Draft Orders from the
Syl'a'Vie storefront and returning the hosted invoice URL.

## Endpoint

`POST /api/payment-drafts/create`

Creates a Shopify Draft Order through the Admin GraphQL API.

### Request

```json
{
  "email": "customer@example.com",
  "lineItems": [
    {
      "variantId": "gid://shopify/ProductVariant/1234567890",
      "quantity": 1
    }
  ],
  "shippingAddress": {
    "firstName": "Ada",
    "lastName": "Lovelace",
    "address1": "1 Example Street",
    "city": "London",
    "country": "United Kingdom",
    "zip": "SW1A 1AA"
  }
}
```

For custom line items, send `title`, `price`, and `quantity` instead of
`variantId`.

### Response

```json
{
  "draftOrderId": "gid://shopify/DraftOrder/1234567890",
  "invoiceUrl": "https://..."
}
```

Validation and Shopify errors are returned as:

```json
{
  "error": {
    "code": "bad_request",
    "message": "lineItems must contain at least one item."
  }
}
```

## Environment

Copy `.env.example` to `.env.local` for local development.

```bash
SHOPIFY_STORE_DOMAIN=sylavie.myshopify.com
SHOPIFY_CLIENT_ID=your-dev-dashboard-client-id
SHOPIFY_CLIENT_SECRET=your-dev-dashboard-client-secret
SHOPIFY_API_VERSION=2026-07
ALLOWED_ORIGINS=https://www.sylavie.com,https://sylavie.myshopify.com
```

`SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` come from the app's Shopify Dev
Dashboard settings. The API exchanges them server-side for an Admin API access
token using Shopify's client credentials grant, caches expiring tokens in memory
for the lifetime of the serverless instance, and sends the token only from the
backend to Shopify.

The installed app needs Admin API permission to create draft orders. Do not put
the client secret or Admin API access token in storefront/theme code.

## Development

```bash
yarn install
yarn dev
```

Type-check the project with:

```bash
yarn typecheck
```
