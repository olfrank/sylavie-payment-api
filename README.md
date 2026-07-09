# Syl'a'Vie Payment API

Minimal Vercel-hosted Node.js API for creating Shopify Draft Orders from the
Syl'a'Vie storefront and returning the hosted invoice URL.

## Endpoint

`POST /api/payment-drafts/create`

Creates a Shopify Draft Order through the Admin GraphQL API.

### Request

```json
{
  "paymentType": "priority",
  "amount": "85.50",
  "currency": "GBP",
  "orderNumber": "SV1421",
  "firstName": "Test",
  "lastName": "Customer",
  "email": "test@example.com",
  "country": "United Kingdom",
  "deliveryDate": "2026-08-14",
  "notes": "Optional note",
  "termsAccepted": true
}
```

For additional payments, send `"paymentType": "additional"` and include
`reason` when relevant.

The API also still accepts the original low-level draft order payload with
`lineItems` for internal testing and manual calls.

Priority and additional payment draft orders are created as custom service-charge
line items with `requiresShipping: false`, `taxable: false`, zero weight, and no
shipping address or shipping line.

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
    "message": "amount must be a positive GBP decimal string with up to 2 decimal places."
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

## Fulfilment status

Shopify's Draft Order custom line item input supports service-style fields such
as `requiresShipping`, `taxable`, and `weight`, but it does not expose a draft
order field that directly suppresses fulfilment status after the invoice is paid.

If paid priority/additional payment orders still appear as `Unfulfilled`, the
safest backend-only follow-up is to add an `orders/paid` webhook that identifies
orders tagged `priority-payment` or `additional-payment` and immediately marks
their fulfilment orders fulfilled through the Admin API. Avoid theme-side fixes
or order-status hacks.

## Development

```bash
yarn install
yarn dev
```

Type-check the project with:

```bash
yarn typecheck
```
