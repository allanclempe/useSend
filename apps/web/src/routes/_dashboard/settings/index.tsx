import { createFileRoute, redirect } from "@tanstack/react-router";

import { billingQueries } from "~/queries/billing";
import { isCloud } from "~/utils/common";
import Usage from "./-usage";

/**
 * `/settings` — usage on cloud, and nothing of its own self-hosted.
 *
 * Next.js rendered the team members list here when `isCloud()` was false, so
 * the same table lived at two URLs and the tab strip — which shows only the
 * Team tab on a self-hosted installation — linked to neither of them from
 * here. `/settings` now redirects to the page that owns that table, the same
 * way `/dev-settings` redirects to its first tab, so every reachable URL has a
 * tab lit.
 *
 * The redirect is in `beforeLoad`, which runs on the server during SSR, so it
 * is a real 307 on a cold load rather than a flash of the wrong page.
 */
export const Route = createFileRoute("/_dashboard/settings/")({
  beforeLoad: () => {
    if (!isCloud()) {
      throw redirect({ to: "/settings/team" });
    }
  },
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(billingQueries.usage()),
  component: UsageSettingsPage,
});

function UsageSettingsPage() {
  return (
    <div>
      <Usage />
    </div>
  );
}
