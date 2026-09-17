import { createFileRoute } from "@tanstack/react-router";

import { NotPortedYet } from "~/components/NotPortedYet";

export const Route = createFileRoute("/_dashboard/webhooks/$webhookId")({
  component: () => <NotPortedYet area="Webhook" />,
});
