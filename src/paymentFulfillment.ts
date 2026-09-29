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

export type PaymentFulfillmentDebugLogger = (
  stage: string,
  details?: Record<string, unknown>
) => void;

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
  payload: OrdersPaidWebhookPayload,
  debugLog?: PaymentFulfillmentDebugLogger
): Promise<PaymentFulfillmentResult> {
  debugLog?.("eligibility_check_started");

  if (!isPaymentOrderTags(payload.tags)) {
    debugLog?.("ineligible_order", { paymentTagEligible: false, finalOutcome: "not_eligible" });
    return { status: "ignored", reason: "not_payment_order" };
  }

  debugLog?.("eligible_payment_order", { paymentTagEligible: true });

  const orderId = toOrderGraphQlId(payload);

  if (!orderId) {
    debugLog?.("admin_order_lookup_failed", {
      reason: "missing_order_id",
      finalOutcome: "not_eligible"
    });
    return { status: "ignored", reason: "missing_order_id" };
  }

  debugLog?.("admin_order_lookup_started");
  debugLog?.("fulfillment_orders_lookup_started");

  const lookup = await shopifyGraphQl<OrderFulfillmentLookupResponse>(
    config,
    ORDER_FULFILLMENT_LOOKUP_QUERY,
    { id: orderId }
  );

  if (!lookup.order) {
    debugLog?.("admin_order_lookup_succeeded", { orderFound: false });
    debugLog?.("fulfillment_orders_lookup_failed", {
      reason: "order_not_found",
      finalOutcome: "not_eligible"
    });
    return { status: "ignored", reason: "order_not_found" };
  }

  debugLog?.("admin_order_lookup_succeeded", { orderFound: true });
  debugLog?.("fulfillment_orders_lookup_succeeded", {
    fulfillmentOrderCount: lookup.order.fulfillmentOrders.nodes.length
  });

  const actualOrderPaymentTagEligible = isPaymentOrderTags(lookup.order.tags);
  debugLog?.("actual_order_tags_checked", {
    actualOrderPaymentTagEligible
  });

  if (!actualOrderPaymentTagEligible) {
    debugLog?.("ineligible_order", { paymentTagEligible: false, finalOutcome: "not_eligible" });
    return { status: "ignored", reason: "not_payment_order" };
  }

  if (lookup.order.displayFulfillmentStatus === "FULFILLED" || !lookup.order.fulfillable) {
    debugLog?.("already_fulfilled", {
      orderFulfillable: lookup.order.fulfillable,
      displayFulfillmentStatus: lookup.order.displayFulfillmentStatus,
      finalOutcome: "already_fulfilled"
    });
    return { status: "noop", reason: "already_fulfilled" };
  }

  const createFulfillmentCapabilityFound = lookup.order.fulfillmentOrders.nodes.some(
    hasCreateFulfillmentCapability
  );
  const remainingFulfillableQuantityFound = lookup.order.fulfillmentOrders.nodes.some(
    hasRemainingFulfillableQuantity
  );
  const actionableFulfillmentOrders = lookup.order.fulfillmentOrders.nodes.filter(
    isActionableFulfillmentOrder
  );
  const actionableFulfillmentOrderFound = actionableFulfillmentOrders.length > 0;

  debugLog?.("fulfillment_order_actionability_checked", {
    fulfillmentOrderCount: lookup.order.fulfillmentOrders.nodes.length,
    actionableFulfillmentOrderFound,
    createFulfillmentCapabilityFound,
    remainingFulfillableQuantityFound
  });

  if (actionableFulfillmentOrders.length === 0) {
    debugLog?.("no_actionable_fulfillment_order", {
      finalOutcome: "no_actionable_fulfillment_order"
    });
    return { status: "noop", reason: "nothing_fulfillable" };
  }

  let fulfillmentCount = 0;

  for (const fulfillmentOrder of actionableFulfillmentOrders) {
    debugLog?.("fulfillment_create_started", { notifyCustomer: false });

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
      debugLog?.("fulfillment_create_failed", {
        errorCount: userErrors.length,
        errorMessages: userErrors.map(sanitizeMessage),
        finalOutcome: userErrors.every(isIdempotentFulfillmentError)
          ? "no_actionable_fulfillment_order"
          : "fulfillment_error"
      });

      if (userErrors.every(isIdempotentFulfillmentError)) {
        continue;
      }

      throw new ApiError(422, "shopify_error", "Shopify rejected the fulfillment.", {
        userErrors
      });
    }

    if (response.fulfillmentCreate.fulfillment?.id) {
      fulfillmentCount += 1;
      debugLog?.("fulfillment_create_succeeded", { notifyCustomer: false });
    }
  }

  if (fulfillmentCount > 0) {
    debugLog?.("final_outcome", { finalOutcome: "fulfilled", fulfillmentCount });
    return { status: "fulfilled", fulfillmentCount };
  }

  debugLog?.("final_outcome", { finalOutcome: "no_actionable_fulfillment_order" });
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

function sanitizeMessage(error: { message: string }): string {
  return error.message.replace(/[^\w .,:;-]/g, "").slice(0, 200);
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
