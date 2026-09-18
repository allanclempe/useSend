import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { z } from "zod";

import { Card } from "@usesend/ui/src/card";

import { billingQueries } from "~/queries/billing";

/**
 * The card on file and the next billing date.
 *
 * `Subscription.paymentMethod` is a `text` column holding whatever Stripe last
 * sent, so it is parsed defensively: the Next.js version did a bare
 * `JSON.parse` on it, typed the result `any`, and reached four levels into it —
 * a malformed value there took the whole billing page down with a syntax
 * error. Anything that does not match is treated as "no payment method",
 * which is what the page shows when the column is null anyway.
 *
 * The literal string `"null"` is checked for because that is what the column
 * has actually contained.
 */
const cardSchema = z.object({
  card: z
    .object({
      brand: z.string().optional(),
      last4: z.string().optional(),
      exp_month: z.number().optional(),
      exp_year: z.number().optional(),
    })
    .optional(),
});

function parseCard(paymentMethod: string | null | undefined) {
  if (!paymentMethod || paymentMethod === "null") {
    return null;
  }

  try {
    return cardSchema.parse(JSON.parse(paymentMethod)).card ?? null;
  } catch {
    return null;
  }
}

export function PaymentMethod() {
  const subscriptionQuery = useQuery(billingQueries.subscription());
  const subscription = subscriptionQuery.data;
  const card = parseCard(subscription?.paymentMethod);

  return (
    <Card className="p-6">
      <div className="text-sm text-muted-foreground">Payment Method</div>
      {subscription ? (
        <div className="mt-2">
          <div className="flex items-center gap-2 font-mono text-lg uppercase">
            {card ? (
              <>
                <span>💳</span>
                <span className="capitalize">
                  {card.brand ?? ""} •••• {card.last4 ?? ""}
                </span>
                {card.exp_month && card.exp_year ? (
                  <span className="text-sm lowercase text-muted-foreground">
                    (Expires: {card.exp_month}/{card.exp_year})
                  </span>
                ) : null}
              </>
            ) : (
              "No Payment Method"
            )}
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            Next billing date:{" "}
            {subscription.currentPeriodEnd
              ? format(new Date(subscription.currentPeriodEnd), "MMM dd, yyyy")
              : "N/A"}
          </div>
        </div>
      ) : (
        <div className="mt-2 text-sm text-muted-foreground">
          No active subscription
        </div>
      )}
    </Card>
  );
}

export default PaymentMethod;
