import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2 } from "lucide-react";
import { z } from "zod";

import { H1 } from "@usesend/ui";
import { Button } from "@usesend/ui/src/button";
import Spinner from "@usesend/ui/src/spinner";

import { teamQueries } from "~/queries/team";
import { useTeam } from "./-team-context";

/**
 * `/payments` — where Stripe sends people back to.
 *
 * Stripe appends `?success=true` or `?canceled=true`, so the two are plain
 * booleans in the route's search rather than `useSearchParams().get(...)`.
 * Neither is trusted for anything: the success branch waits to see the plan
 * change in our own database before it says the upgrade worked.
 */
const searchSchema = z.object({
  success: z.coerce.boolean().optional().catch(undefined),
  canceled: z.coerce.boolean().optional().catch(undefined),
});

export const Route = createFileRoute("/_dashboard/payments")({
  validateSearch: searchSchema,
  component: PaymentsPage,
});

function PaymentsPage() {
  const { success, canceled } = Route.useSearch();

  return (
    <div className="container mx-auto py-10">
      <H1>Payment {success ? "Success" : canceled ? "Canceled" : "Unknown"}</H1>
      {canceled ? (
        <Link to="/settings/billing">
          <Button>Go to billing</Button>
        </Link>
      ) : null}
      {success ? <VerifySuccess /> : null}
    </div>
  );
}

/**
 * Waits for Stripe's webhook to reach us.
 *
 * The plan changes when `POST /api/stripe/webhook` lands, not when the browser
 * comes back, so this polls until it sees it. Two corrections to the Next.js
 * version:
 *
 * - **It asks about the team you are in.** That one read `teams[0]`, so
 *   somebody who belonged to two teams could be told their upgrade had worked
 *   because a *different* team of theirs was already on a paid plan.
 * - **It stops.** The old `refetchInterval: 3000` had no exit, so a tab left
 *   open on this page asked for the team list every three seconds for as long
 *   as it stayed open.
 */
function VerifySuccess() {
  const { currentTeam } = useTeam();

  const teamsQuery = useQuery({
    ...teamQueries.list(),
    refetchInterval: (query) =>
      query.state.data?.some(
        (team) => team.id === currentTeam?.id && team.plan !== "FREE",
      )
        ? false
        : 3000,
  });

  const upgraded = teamsQuery.data?.some(
    (team) => team.id === currentTeam?.id && team.plan !== "FREE",
  );

  if (!upgraded) {
    return (
      <div className="flex items-center gap-2">
        <Spinner
          className="h-5 w-5 stroke-muted-foreground"
          innerSvgClass="stroke-muted-foreground"
        />
        <p className="text-muted-foreground">Verifying payment</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-green" />
        <p>Your account has been upgraded to the paid plan.</p>
      </div>
      <Link to="/settings/billing">
        <Button className="mt-8">Go to billing</Button>
      </Link>
    </div>
  );
}
