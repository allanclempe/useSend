import { describe, expect, it, vi } from "vitest";

vi.mock("~/server/billing/payments", () => ({
  getStripe: vi.fn(() => ({ webhooks: { constructEvent: vi.fn() } })),
  syncStripeData: vi.fn(),
}));

vi.mock("~/env", () => ({
  env: { STRIPE_WEBHOOK_SECRET: undefined },
}));

import { handleStripeWebhook } from "~/server/billing/stripe-webhook";

/**
 * Moved from `app/api/webhook/stripe/route.api.test.ts` with the handler (#9).
 * It no longer mocks `next/headers`: the signature comes off the `Request`,
 * which is what let the same handler serve both frameworks.
 */
describe("stripe webhook", () => {
  it("refuses a request with no signature", async () => {
    const response = await handleStripeWebhook(
      new Request("http://localhost", { method: "POST" }),
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("No signature");
  });

  it("refuses when the webhook secret is not configured", async () => {
    const response = await handleStripeWebhook(
      new Request("http://localhost", {
        method: "POST",
        body: "{}",
        headers: { "Stripe-Signature": "test-signature" },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("No webhook secret");
  });
});
