import { ApiError } from "./http.js";
import { getShopifyAdminAccessToken } from "./shopifyAuth.js";

export type PaymentDraftRequest = {
  email?: string;
  phone?: string;
  note?: string;
  tags?: string[];
  lineItems: PaymentDraftLineItem[];
  billingAddress?: PaymentDraftAddress;
  shippingAddress?: PaymentDraftAddress;
  customAttributes?: PaymentDraftCustomAttribute[];
};

export type PaymentDraftLineItem = {
  variantId?: string;
  title?: string;
  quantity: number;
  price?: string;
  sku?: string;
  taxable?: boolean;
  requiresShipping?: boolean;
};

export type PaymentDraftAddress = {
  firstName?: string;
  lastName?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  country?: string;
  zip?: string;
  phone?: string;
};

export type PaymentDraftCustomAttribute = {
  key: string;
  value: string;
};

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

type DraftOrderCreateResponse = {
  draftOrderCreate: {
    draftOrder: {
      id: string;
      invoiceUrl: string | null;
    } | null;
    userErrors: Array<{
      field: string[] | null;
      message: string;
    }>;
  };
};

const DRAFT_ORDER_CREATE_MUTATION = `
  mutation DraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        invoiceUrl
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export function validatePaymentDraftRequest(value: unknown): PaymentDraftRequest {
  if (!isRecord(value)) {
    throw new ApiError(400, "bad_request", "Request body must be a JSON object.");
  }

  const email = optionalString(value.email, "email");
  const phone = optionalString(value.phone, "phone");

  if (!email && !phone) {
    throw new ApiError(400, "bad_request", "Either email or phone is required.");
  }

  if (!Array.isArray(value.lineItems) || value.lineItems.length === 0) {
    throw new ApiError(400, "bad_request", "lineItems must contain at least one item.");
  }

  return {
    email,
    phone,
    note: optionalString(value.note, "note"),
    tags: optionalStringArray(value.tags, "tags"),
    lineItems: value.lineItems.map(validateLineItem),
    billingAddress: optionalAddress(value.billingAddress, "billingAddress"),
    shippingAddress: optionalAddress(value.shippingAddress, "shippingAddress"),
    customAttributes: optionalCustomAttributes(value.customAttributes)
  };
}

export async function createPaymentDraft(
  config: ShopifyConfig,
  request: PaymentDraftRequest
): Promise<{ draftOrderId: string; invoiceUrl: string }> {
  const input = toDraftOrderInput(request);
  const response = await shopifyGraphQl<DraftOrderCreateResponse>(
    config,
    DRAFT_ORDER_CREATE_MUTATION,
    { input }
  );

  const payload = response.draftOrderCreate;

  if (payload.userErrors.length > 0) {
    throw new ApiError(422, "shopify_error", "Shopify rejected the draft order.", {
      userErrors: payload.userErrors
    });
  }

  if (!payload.draftOrder?.invoiceUrl) {
    throw new ApiError(502, "shopify_error", "Shopify did not return an invoice URL.");
  }

  return {
    draftOrderId: payload.draftOrder.id,
    invoiceUrl: payload.draftOrder.invoiceUrl
  };
}

function toDraftOrderInput(request: PaymentDraftRequest): Record<string, unknown> {
  return compactObject({
    email: request.email,
    phone: request.phone,
    note: request.note,
    tags: request.tags,
    billingAddress: request.billingAddress,
    shippingAddress: request.shippingAddress,
    customAttributes: request.customAttributes,
    lineItems: request.lineItems.map((item) =>
      compactObject({
        variantId: item.variantId,
        title: item.title,
        quantity: item.quantity,
        originalUnitPrice: item.price,
        sku: item.sku,
        taxable: item.taxable,
        requiresShipping: item.requiresShipping
      })
    )
  });
}

async function shopifyGraphQl<T>(
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

function validateLineItem(value: unknown, index: number): PaymentDraftLineItem {
  if (!isRecord(value)) {
    throw new ApiError(400, "bad_request", `lineItems[${index}] must be an object.`);
  }

  const variantId = optionalString(value.variantId, `lineItems[${index}].variantId`);
  const title = optionalString(value.title, `lineItems[${index}].title`);
  const price = optionalPrice(value.price, `lineItems[${index}].price`);

  if (!variantId && (!title || !price)) {
    throw new ApiError(
      400,
      "bad_request",
      `lineItems[${index}] must include variantId, or both title and price.`
    );
  }

  return {
    variantId,
    title,
    quantity: requiredPositiveInteger(value.quantity, `lineItems[${index}].quantity`),
    price,
    sku: optionalString(value.sku, `lineItems[${index}].sku`),
    taxable: optionalBoolean(value.taxable, `lineItems[${index}].taxable`),
    requiresShipping: optionalBoolean(
      value.requiresShipping,
      `lineItems[${index}].requiresShipping`
    )
  };
}

function optionalAddress(value: unknown, field: string): PaymentDraftAddress | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw new ApiError(400, "bad_request", `${field} must be an object.`);
  }

  return compactObject({
    firstName: optionalString(value.firstName, `${field}.firstName`),
    lastName: optionalString(value.lastName, `${field}.lastName`),
    address1: optionalString(value.address1, `${field}.address1`),
    address2: optionalString(value.address2, `${field}.address2`),
    city: optionalString(value.city, `${field}.city`),
    province: optionalString(value.province, `${field}.province`),
    country: optionalString(value.country, `${field}.country`),
    zip: optionalString(value.zip, `${field}.zip`),
    phone: optionalString(value.phone, `${field}.phone`)
  });
}

function optionalCustomAttributes(value: unknown): PaymentDraftCustomAttribute[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new ApiError(400, "bad_request", "customAttributes must be an array.");
  }

  return value.map((attribute, index) => {
    if (!isRecord(attribute)) {
      throw new ApiError(400, "bad_request", `customAttributes[${index}] must be an object.`);
    }

    return {
      key: requiredString(attribute.key, `customAttributes[${index}].key`),
      value: requiredString(attribute.value, `customAttributes[${index}].value`)
    };
  });
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ApiError(400, "bad_request", `${field} must be a positive integer.`);
  }

  return value;
}

function requiredString(value: unknown, field: string): string {
  const stringValue = optionalString(value, field);

  if (!stringValue) {
    throw new ApiError(400, "bad_request", `${field} is required.`);
  }

  return stringValue;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new ApiError(400, "bad_request", `${field} must be a string.`);
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalPrice(value: unknown, field: string): string | undefined {
  const price = optionalString(value, field);

  if (price === undefined) {
    return undefined;
  }

  if (!/^\d+(\.\d{1,2})?$/.test(price) || Number(price) <= 0) {
    throw new ApiError(400, "bad_request", `${field} must be a positive decimal string.`);
  }

  return price;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ApiError(400, "bad_request", `${field} must be an array of strings.`);
  }

  return value.map((item) => item.trim()).filter(Boolean);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new ApiError(400, "bad_request", `${field} must be a boolean.`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactObject<T extends Record<string, unknown>>(object: T): T {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined)
  ) as T;
}
