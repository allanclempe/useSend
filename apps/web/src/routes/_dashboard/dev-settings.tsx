import { createFileRoute, Outlet } from "@tanstack/react-router";

import { H1 } from "@usesend/ui";

import { SettingsNavButton } from "./dev-settings/-settings-nav-button";

/**
 * The chrome shared by every developer-settings page (#9).
 *
 * `app/(dashboard)/dev-settings/layout.tsx` became a layout route: a file
 * sitting beside the `dev-settings/` directory wraps everything inside it, so
 * the heading and the tab strip render once and the pages below are just the
 * `<Outlet />`. The URLs are unchanged by it.
 *
 * `export const dynamic = "force-static"` is gone with no replacement. It was
 * telling Next.js it could prerender the layout; TanStack renders it per
 * request like everything else, and there is nothing in it to prerender.
 */
export const Route = createFileRoute("/_dashboard/dev-settings")({
  component: DevSettingsLayout,
});

function DevSettingsLayout() {
  return (
    <div>
      <H1>Developer Settings</H1>
      <div className="mt-4 flex gap-4">
        <SettingsNavButton to="/dev-settings/api-keys">
          API Keys
        </SettingsNavButton>
        <SettingsNavButton to="/dev-settings/smtp">SMTP</SettingsNavButton>
      </div>
      <div className="mt-8">
        <Outlet />
      </div>
    </div>
  );
}
