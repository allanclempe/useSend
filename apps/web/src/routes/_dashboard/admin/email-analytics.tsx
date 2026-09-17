import { createFileRoute } from "@tanstack/react-router";

import { NotPortedYet } from "~/components/NotPortedYet";

export const Route = createFileRoute("/_dashboard/admin/email-analytics")({
  component: () => <NotPortedYet area="Email analytics" />,
});
