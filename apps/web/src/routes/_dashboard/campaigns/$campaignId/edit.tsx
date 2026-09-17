import { createFileRoute } from "@tanstack/react-router";

import { NotPortedYet } from "~/components/NotPortedYet";

export const Route = createFileRoute("/_dashboard/campaigns/$campaignId/edit")({
  component: () => <NotPortedYet area="Edit campaign" />,
});
