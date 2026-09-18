import { Link, type LinkProps } from "@tanstack/react-router";
import React from "react";

/**
 * One tab in a settings tab strip -- developer settings and admin both have
 * one (#9).
 *
 * The Next.js version compared `usePathname()` to its own `href` to decide
 * whether it was the current tab. `Link` already knows — it is the thing that
 * resolves the target — so the answer comes from `activeProps` instead, and
 * the component no longer has to be told twice where it points. `exact`
 * because `/dev-settings` is a prefix of both tabs and a prefix match would
 * light up every one of them.
 *
 * `to` is typed as the router's own link target rather than `string`, so a tab
 * pointing at a URL that does not exist is a type error here rather than a
 * dead link in the UI.
 *
 * The `comingSoon` variant the Next.js component carried is not here: nothing
 * ever passed it.
 */
export const SettingsNavButton: React.FC<{
  to: LinkProps["to"];
  children: React.ReactNode;
}> = ({ to, children }) => (
  <Link
    to={to}
    activeOptions={{ exact: true }}
    className="mt-1 flex items-center gap-3 rounded px-2 py-1 text-sm transition-all hover:text-foreground"
    activeProps={{ className: "bg-accent" }}
    inactiveProps={{ className: "text-muted-foreground" }}
  >
    {children}
  </Link>
);
