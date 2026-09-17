import type Stripe from "stripe";

import { env } from "~/env";
import { getStripe, syncStripeData } from "~/server/billing/payments";
import { logger } from "~/server/logger/log";

/**
 * `POST /api/webhook/stripe`.
 *
 * Framework-free, like `service/ses-callback.ts` and `server/auth-route.ts`:
 * Stripe is subscribed to exactly one URL and both frameworks serve it while
 * `src/app` is still in the tree (#9). A signature check that exists on one of
 * them and not the other would be worse than none.
 *
 * `console.error` became `logger.error` on the way across, per `AGENTS.md`.
 */
const allowedEvents: Stripe.Event.Type[] = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.pending_update_applied",
  "customer.subscription.pending_update_expired",
  "customer.subscription.trial_will_end",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.upcoming",
  "invoice.marked_uncollectible",
  "invoice.payment_succeeded",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
];

export async function handleStripeWebhook(
  request: Request,
): Promise<Response> {
  const body = await request.text();
  const signature = request.headers.get("Stripe-Signature");

  if (!signature) {
    logger.error("Stripe webhook rejected: no signature");
    return new Response("No signature", { status: 400 });
  }

  if (!env.STRIPE_WEBHOOK_SECRET) {
    logger.error("Stripe webhook rejected: STRIPE_WEBHOOK_SECRET is not set");
    return new Response("No webhook secret", { status: 400 });
  }

  const stripe = getStripe();

  try {
    // Still the synchronous one. It needs a synchronous HMAC, which is the
    // kind of thing that works on Node and quietly does not on Workers — so
    // `src/worker/compat-check.ts` runs exactly this call in a real isolate,
    // and it passes. `constructEventAsync` is the alternative if that ever
    // stops being true.
    const event = stripe.webhooks.constructEvent(
      body,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
    );

    if (!allowedEvents.includes(event.type)) {
      return new Response("OK", { status: 200 });
    }

    // Every event tracked here carries a customer id.
    const { customer: customerId } = event.data.object as { customer: string };

    // Typed as a string above on an assumption; this is where a wrong
    // assumption becomes visible rather than a silently skipped sync.
    if (typeof customerId !== "string") {
      throw new Error(
        `Stripe event ${event.type} had no string customer id`,
      );
    }

    await syncStripeData(customerId);

    return new Response("OK", { status: 200 });
  } catch (err) {
    logger.error({ err }, "Stripe webhook failed");
    return new Response("Webhook error", { status: 400 });
  }
}
