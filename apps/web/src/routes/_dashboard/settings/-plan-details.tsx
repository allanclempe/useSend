import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { CheckCircle2 } from "lucide-react";

import { Badge } from "@usesend/ui/src/badge";

import { PLAN_PERKS } from "~/lib/constants/payments";
import { isEntitledSubscriptionStatus } from "~/lib/subscription-status";
import { billingQueries } from "~/queries/billing";
import { useTeam } from "../-team-context";

/**
 * The current plan and what it includes.
 *
 * Both settings pages show it — usage puts it under the month's numbers,
 * billing puts it above the payment method — so it sits beside them rather
 * than inside either.
 */
export const PlanDetails = () => {
  const subscriptionQuery = useQuery(billingQueries.subscription());
  const { currentTeam } = useTeam();

  if (subscriptionQuery.isLoading || !currentTeam) {
    return null;
  }

  const planKey = currentTeam.plan as keyof typeof PLAN_PERKS;
  const perks = PLAN_PERKS[planKey] || [];
  const isEntitled = isEntitledSubscriptionStatus(
    subscriptionQuery.data?.status,
  );

  return (
    <div>
      <div className="text-lg capitalize">
        {isEntitled ? planKey.toLowerCase() : "free"}
      </div>
      <div className="flex items-center gap-2">
        <div className="text-sm text-muted-foreground">Current plan</div>
        {subscriptionQuery.data?.cancelAtPeriodEnd && (
          <Badge variant="secondary">
            Cancels {format(subscriptionQuery.data.cancelAtPeriodEnd, "MMM dd")}
          </Badge>
        )}
      </div>
      <ul className="mt-4 space-y-3">
        {perks.map((perk, index) => (
          <li key={index} className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-green" />
            <span className="text-sm">{perk}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};
