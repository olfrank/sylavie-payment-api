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
  "countryCode": "GB",
  "deliveryDate": "2026-08-14",
  "notes": "Optional note",
  "termsAccepted": true
}
```

For additional payments, send `"paymentType": "additional"` and include
`reason` when relevant. Both payment types require `countryCode` to be a valid,
uppercase ISO 3166-1 alpha-2 code, such as `GB`, `US`, `AU`, `JE`, or `GG`.
`country` is an optional display name retained in the note and custom attributes;
`countryCode` is authoritative for Shopify's address and tax calculation.

The API adds a billing address containing `firstName`, `lastName`, and
`countryCode`. If the request includes a full `shippingAddress`, it is passed to
Shopify too. For example:

```json
{
  "shippingAddress": {
    "firstName": "Test",
    "lastName": "Customer",
    "address1": "1 Harbour Street",
    "city": "Sydney",
    "provinceCode": "NSW",
    "country": "Australia",
    "countryCode": "AU",
    "zip": "2000"
  }
}
```

Address display names such as `country` and `province` are accepted for
compatibility, but Shopify address inputs receive their code fields. Use
`countryCode` and, when applicable, `provinceCode` in a shipping address.

The API also still accepts the original low-level draft order payload with
`lineItems` for internal testing and manual calls.

Priority and additional payment draft orders are created as custom service-charge
line items with `requiresShipping: false`, `taxable: true`, zero weight, and no
shipping line. Shopify determines any actual destination tax from the customer
address and the store's tax settings.

`amount` is the final GBP amount agreed with the customer and the checkout total
before any destination taxes Shopify is legally configured to add. The backend
does not add VAT, reduce international amounts, or exempt international line
items from tax. Jersey (`JE`) and Guernsey (`GG`) are passed to Shopify without
application-level assumptions about their tax treatment.

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

Run the unit tests with:

```bash
yarn test
```
