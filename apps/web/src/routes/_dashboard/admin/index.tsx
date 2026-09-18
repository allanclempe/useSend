import { createFileRoute } from "@tanstack/react-router";

import { adminQueries } from "~/queries/admin";
import AddSesConfiguration from "./-add-ses-configuration";
import SesConfigurations from "./-ses-configurations";

/**
 * `/admin` — the sending regions.
 *
 * The only tab a self-hosted installation has, and the one that has to work
 * before anything else does: with no region configured the app cannot send an
 * email at all, which is why `_dashboard.tsx` shows this area's form instead
 * of the dashboard when the list comes back empty.
 */
export const Route = createFileRoute("/_dashboard/admin/")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(adminQueries.sesSettings()),
  component: AdminSesPage,
});

function AdminSesPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">SES Configurations</h2>
        <AddSesConfiguration />
      </div>
      <SesConfigurations />
    </div>
  );
}
