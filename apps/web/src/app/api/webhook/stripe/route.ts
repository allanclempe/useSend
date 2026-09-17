import { handleStripeWebhook } from "~/server/billing/stripe-webhook";

/**
 * Next.js's entry into the Stripe webhook. The handler is in
 * `~/server/billing/stripe-webhook` so the TanStack Start route at
 * `routes/api.webhook.stripe.ts` cannot drift from it (#9).
 */
export const POST = handleStripeWebhook;
