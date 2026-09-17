import { createFileRoute } from "@tanstack/react-router";

import { NotPortedYet } from "~/components/NotPortedYet";

export const Route = createFileRoute("/_dashboard/payments")({
  component: () => <NotPortedYet area="Payments" />,
});
