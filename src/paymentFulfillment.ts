import { ApiError } from "./http.js";
import { shopifyGraphQl, type ShopifyConfig } from "./shopifyAdmin.js";

const PAYMENT_ORDER_TAGS = new Set(["priority-payment", "additional-payment"]);

type OrdersPaidWebhookPayload = {
  id?: number | string;
  admin_graphql_api_id?: string;
  tags?: string | string[];
};

type FulfillmentOrderNode = {
  id: string;
  status: string;
  requestStatus: string;
  supportedActions: Array<{ action: string }>;
  lineItems: {
    nodes: Array<{
      id: string;
      remainingQuantity: number;
    }>;
  };
};

type OrderFulfillmentLookupResponse = {
  order: {
    id: string;
    displayFulfillmentStatus: string;
    fulfillable: boolean;
    tags: string[];
    fulfillmentOrders: {
      nodes: FulfillmentOrderNode[];
    };
  } | null;
};

type FulfillmentCreateResponse = {
  fulfillmentCreate: {
    fulfillment: {
      id: string;
    } | null;
    userErrors: Array<{
      field: string[] | null;
      message: string;
    }>;
  };
};

export type PaymentFulfillmentResult =
  | { status: "ignored"; reason: "not_payment_order" | "missing_order_id" | "order_not_found" }
  | { status: "noop"; reason: "already_fulfilled" | "nothing_fulfillable" }
  | { status: "fulfilled"; fulfillmentCount: number };

const ORDER_FULFILLMENT_LOOKUP_QUERY = `
  query PaymentOrderFulfillmentLookup($id: ID!) {
    order(id: $id) {
      id
      displayFulfillmentStatus
      fulfillable
      tags
      fulfillmentOrders(first: 20) {
        nodes {
          id
          status
          requestStatus
          supportedActions {
            action
          }
          lineItems(first: 50) {
            nodes {
              id
              remainingQuantity
            }
          }
        }
      }
    }
  }
`;

const FULFILLMENT_CREATE_MUTATION = `
  mutation FulfillPaymentOrder($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export function isPaymentOrderTags(tags: string | string[] | undefined): boolean {
  return parseTags(tags).some((tag) => PAYMENT_ORDER_TAGS.has(tag));
}

export async function fulfillPaidPaymentOrder(
  config: ShopifyConfig,
  payload: OrdersPaidWebhookPayload
): Promise<PaymentFulfillmentResult> {
  if (!isPaymentOrderTags(payload.tags)) {
    return { status: "ignored", reason: "not_payment_order" };
  }

  const orderId = toOrderGraphQlId(payload);

  if (!orderId) {
    return { status: "ignored", reason: "missing_order_id" };
  }

  const lookup = await shopifyGraphQl<OrderFulfillmentLookupResponse>(
    config,
    ORDER_FULFILLMENT_LOOKUP_QUERY,
    { id: orderId }
  );

  if (!lookup.order) {
    return { status: "ignored", reason: "order_not_found" };
  }

  const actualOrderPaymentTagEligible = isPaymentOrderTags(lookup.order.tags);

  if (!actualOrderPaymentTagEligible) {
    return { status: "ignored", reason: "not_payment_order" };
  }

  if (lookup.order.displayFulfillmentStatus === "FULFILLED" || !lookup.order.fulfillable) {
    return { status: "noop", reason: "already_fulfilled" };
  }

  const actionableFulfillmentOrders = lookup.order.fulfillmentOrders.nodes.filter(
    isActionableFulfillmentOrder
  );

  if (actionableFulfillmentOrders.length === 0) {
    return { status: "noop", reason: "nothing_fulfillable" };
  }

  let fulfillmentCount = 0;

  for (const fulfillmentOrder of actionableFulfillmentOrders) {
    const response = await shopifyGraphQl<FulfillmentCreateResponse>(
      config,
      FULFILLMENT_CREATE_MUTATION,
      {
        fulfillment: {
          lineItemsByFulfillmentOrder: [
            {
              fulfillmentOrderId: fulfillmentOrder.id
            }
          ],
          notifyCustomer: false
        }
      }
    );

    const userErrors = response.fulfillmentCreate.userErrors;

    if (userErrors.length > 0) {
      if (userErrors.every(isIdempotentFulfillmentError)) {
        continue;
      }

      throw new ApiError(422, "shopify_error", "Shopify rejected the fulfillment.", {
        userErrors
      });
    }

    if (response.fulfillmentCreate.fulfillment?.id) {
      fulfillmentCount += 1;
    }
  }

  if (fulfillmentCount > 0) {
    return { status: "fulfilled", fulfillmentCount };
  }

  return { status: "noop", reason: "nothing_fulfillable" };
}

function isActionableFulfillmentOrder(fulfillmentOrder: FulfillmentOrderNode): boolean {
  return (
    fulfillmentOrder.status === "OPEN" &&
    fulfillmentOrder.requestStatus === "UNSUBMITTED" &&
    hasCreateFulfillmentCapability(fulfillmentOrder) &&
    hasRemainingFulfillableQuantity(fulfillmentOrder)
  );
}

function hasCreateFulfillmentCapability(fulfillmentOrder: FulfillmentOrderNode): boolean {
  return fulfillmentOrder.supportedActions.some((action) => action.action === "CREATE_FULFILLMENT");
}

function hasRemainingFulfillableQuantity(fulfillmentOrder: FulfillmentOrderNode): boolean {
  return fulfillmentOrder.lineItems.nodes.some((lineItem) => lineItem.remainingQuantity > 0);
}

function isIdempotentFulfillmentError(error: { message: string }): boolean {
  return /already|closed|fulfilled|no fulfillable|remaining quantity/i.test(error.message);
}

function parseTags(tags: string | string[] | undefined): string[] {
  if (Array.isArray(tags)) {
    return tags.map(normalizeTag).filter(Boolean);
  }

  if (typeof tags === "string") {
    return tags.split(",").map(normalizeTag).filter(Boolean);
  }

  return [];
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function toOrderGraphQlId(payload: OrdersPaidWebhookPayload): string | undefined {
  if (payload.admin_graphql_api_id) {
    return payload.admin_graphql_api_id;
  }

  if (payload.id === undefined || payload.id === null || payload.id === "") {
    return undefined;
  }

  return `gid://shopify/Order/${payload.id}`;
}
