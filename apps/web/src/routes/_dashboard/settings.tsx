import { createFileRoute, Link, Outlet } from "@tanstack/react-router";

import { isCloud } from "~/utils/common";
import { useTeam } from "./-team-context";

/**
 * The `/settings` chrome — a heading and a tab strip above whichever settings
 * page is showing (#9).
 *
 * A layout route with a path, not a pathless one: the URLs underneath it are
 * already `/settings/...`, so the segment belongs in the tree rather than in
 * each child's filename.
 *
 * "Which tab am I on" comes from the router now. `usePathname() === href` was
 * the Next.js version and it had to be exact, which is why `/settings` and
 * `/settings/team` never both lit up; `activeProps` defaults to prefix
 * matching, so the Usage tab — whose path is a prefix of every other tab's —
 * asks for `exact` explicitly.
 */
export const Route = createFileRoute("/_dashboard/settings")({
  component: SettingsLayout,
});

const navLinkClass =
  "mt-1 flex items-center gap-3 rounded px-2 py-1 text-sm transition-all hover:text-foreground";

const navActiveProps = { className: "bg-accent" };
const navInactiveProps = { className: "text-muted-foreground" };

function SettingsLayout() {
  const { currentIsAdmin } = useTeam();

  return (
    <div>
      <h1 className="text-lg font-bold">Settings</h1>
      <div className="mt-4 flex gap-4">
        {isCloud() ? (
          <Link
            to="/settings"
            activeOptions={{ exact: true }}
            className={navLinkClass}
            activeProps={navActiveProps}
            inactiveProps={navInactiveProps}
          >
            Usage
          </Link>
        ) : null}
        {currentIsAdmin && isCloud() ? (
          <Link
            to="/settings/billing"
            className={navLinkClass}
            activeProps={navActiveProps}
            inactiveProps={navInactiveProps}
          >
            Billing
          </Link>
        ) : null}
        <Link
          to="/settings/team"
          className={navLinkClass}
          activeProps={navActiveProps}
          inactiveProps={navInactiveProps}
        >
          Team
        </Link>
      </div>
      <div className="mt-8">
        <Outlet />
      </div>
    </div>
  );
}
