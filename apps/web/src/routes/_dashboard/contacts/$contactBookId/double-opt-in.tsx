import { createFileRoute } from "@tanstack/react-router";

import { NotPortedYet } from "~/components/NotPortedYet";

export const Route = createFileRoute("/_dashboard/contacts/$contactBookId/double-opt-in")({
  component: () => <NotPortedYet area="Double opt-in" />,
});
