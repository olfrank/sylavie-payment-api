import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../src/http.js";
import {
  toDraftOrderInput,
  validatePaymentDraftRequest
} from "../src/paymentDrafts.js";

function simplePayment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paymentType: "priority",
    amount: "85.50",
    currency: "GBP",
    orderNumber: "SV1421",
    firstName: "Test",
    lastName: "Customer",
    email: "test@example.com",
    country: "United Kingdom",
    countryCode: "GB",
    termsAccepted: true,
    ...overrides
  };
}

test("GB priority payment is taxable and maps a GB billing address", () => {
  const request = validatePaymentDraftRequest(simplePayment());
  const input = toDraftOrderInput(request);

  assert.deepEqual(input.billingAddress, {
    firstName: "Test",
    lastName: "Customer",
    countryCode: "GB"
  });
  assert.equal((input.lineItems as Array<{ taxable: boolean }>)[0]?.taxable, true);
});

test("US additional payment remains taxable and maps a US billing address", () => {
  const request = validatePaymentDraftRequest(
    simplePayment({
      paymentType: "additional",
      country: "United States",
      countryCode: "US",
      reason: "Order change"
    })
  );
  const input = toDraftOrderInput(request);

  assert.deepEqual(input.billingAddress, {
    firstName: "Test",
    lastName: "Customer",
    countryCode: "US"
  });
  assert.equal((input.lineItems as Array<{ taxable: boolean }>)[0]?.taxable, true);
});

test("AU, JE and GG country codes pass through unchanged", () => {
  for (const countryCode of ["AU", "JE", "GG"]) {
    const request = validatePaymentDraftRequest(
      simplePayment({ country: undefined, countryCode })
    );
    const input = toDraftOrderInput(request);

    assert.equal(
      (input.billingAddress as { countryCode: string }).countryCode,
      countryCode
    );
    assert.equal((input.lineItems as Array<{ taxable: boolean }>)[0]?.taxable, true);
  }
});

test("a supplied shipping address is mapped with the authoritative country code", () => {
  const request = validatePaymentDraftRequest(
    simplePayment({
      countryCode: "AU",
      shippingAddress: {
        firstName: "Test",
        lastName: "Customer",
        address1: "1 Harbour Street",
        city: "Sydney",
        provinceCode: "NSW",
        country: "Australia",
        countryCode: "AU",
        zip: "2000"
      }
    })
  );
  const input = toDraftOrderInput(request);

  assert.deepEqual(input.shippingAddress, {
    firstName: "Test",
    lastName: "Customer",
    address1: "1 Harbour Street",
    city: "Sydney",
    provinceCode: "NSW",
    countryCode: "AU",
    zip: "2000"
  });
});

test("missing or invalid countryCode returns a 400 validation error", () => {
  for (const countryCode of [undefined, "", "UK", "GBR", "gb", "ZZ", 123]) {
    assert.throws(
      () => validatePaymentDraftRequest(simplePayment({ countryCode })),
      (error: unknown) =>
        error instanceof ApiError && error.status === 400 && error.code === "bad_request"
    );
  }
});
