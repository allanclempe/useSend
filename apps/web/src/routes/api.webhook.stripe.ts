import { createFileRoute } from "@tanstack/react-router";

import { handleStripeWebhook } from "~/server/billing/stripe-webhook";

export const Route = createFileRoute("/api/webhook/stripe")({
  server: {
    handlers: {
      POST: ({ request }) => handleStripeWebhook(request),
    },
  },
});
