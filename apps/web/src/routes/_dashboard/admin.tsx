import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { getSessionState } from "~/server/functions/session";
import { isCloud } from "~/utils/common";
import { SettingsNavButton } from "./-settings-nav-button";

/**
 * The instance-admin area (#9).
 *
 * **The gate moved from the data to the door.** Next.js rendered these pages
 * to anyone who typed the URL and let each tRPC procedure refuse — so a
 * non-admin got the heading, the tab strip and four failing queries rather
 * than an answer. `beforeLoad` runs on the server, so `/admin` is a 307 to the
 * dashboard for everyone else before any HTML is rendered.
 *
 * That is a defence in depth, not the defence: `instanceAdminMiddleware` on
 * every function in `server/functions/admin.ts` is still what makes the data
 * safe. This only stops the app claiming the page exists for you -- and it
 * asks `isInstanceAdmin`, the same predicate that middleware enforces, so the
 * gate and the refusal cannot drift apart. On a self-hosted install that is
 * every signed-in user; on cloud it is `ADMIN_EMAIL`.
 *
 * Three of the four tabs are cloud-only, because teams, the waitlist and
 * cross-team analytics are things only a hosted installation has more than one
 * of.
 */
export const Route = createFileRoute("/_dashboard/admin")({
  beforeLoad: async () => {
    const { mayAdminister } = await getSessionState();

    if (!mayAdminister) {
      throw redirect({ to: "/dashboard" });
    }
  },
  component: AdminLayout,
});

function AdminLayout() {
  return (
    <div>
      <h1 className="text-lg font-bold">Admin</h1>
      <div className="mt-4 flex gap-4">
        <SettingsNavButton to="/admin">SES Configurations</SettingsNavButton>
        {isCloud() ? (
          <>
            <SettingsNavButton to="/admin/teams">Teams</SettingsNavButton>
            <SettingsNavButton to="/admin/email-analytics">
              Email analytics
            </SettingsNavButton>
            <SettingsNavButton to="/admin/waitlist">Waitlist</SettingsNavButton>
          </>
        ) : null}
      </div>
      <div className="mt-8">
        <Outlet />
      </div>
    </div>
  );
}
