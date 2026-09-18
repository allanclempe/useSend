import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { Button } from "@usesend/ui/src/button";
import { Card } from "@usesend/ui/src/card";
import Spinner from "@usesend/ui/src/spinner";
import { toast } from "@usesend/ui/src/toaster";

import { billingQueries } from "~/queries/billing";
import { getManageSessionUrl } from "~/server/functions/billing";
import { useTeam } from "../-team-context";
import { BillingEmail } from "./-billing-email";
import { PaymentMethod } from "./-payment-method";
import { PlanDetails } from "./-plan-details";
import { UpgradeButton } from "./-upgrade-button";

/**
 * `/settings/billing`.
 *
 * `getManageSessionUrl` and `createCheckoutSession` are both admin-only on the
 * server, and the tab strip only offers this page to an admin, so the gate
 * here is belt and braces rather than the boundary.
 *
 * The Next.js page returned `null` for a non-admin — a blank panel with a
 * heading above it and no explanation. It says why now.
 */
export const Route = createFileRoute("/_dashboard/settings/billing")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(billingQueries.subscription()),
  component: BillingPage,
});

function BillingPage() {
  const { currentTeam, currentIsAdmin } = useTeam();

  const manageSession = useMutation({
    mutationFn: getManageSessionUrl,
    onSuccess: (url) => {
      if (url) {
        window.location.href = url;
      }
    },
    onError: (error) => toast.error(error.message),
  });

  if (!currentIsAdmin) {
    return (
      <Card className="p-6 text-sm text-muted-foreground">
        Only a team admin can see billing.
      </Card>
    );
  }

  if (!currentTeam?.plan) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-4 w-4" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <Card className="mt-10 rounded-xl p-8">
        <PlanDetails />
        <div className="mt-4">
          {currentTeam.plan === "FREE" ? (
            <UpgradeButton />
          ) : (
            <Button
              onClick={() => manageSession.mutate(undefined)}
              className="mt-4 w-[120px]"
              disabled={manageSession.isPending}
            >
              {manageSession.isPending ? (
                <Spinner className="h-4 w-4" />
              ) : (
                "Manage"
              )}
            </Button>
          )}
        </div>
      </Card>
      <div className="mt-8 grid grid-cols-1 gap-8 md:grid-cols-2">
        <PaymentMethod />
        <BillingEmail />
      </div>
    </div>
  );
}
