import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * `/dev-settings` — the first tab, by redirect.
 *
 * Next.js served the API keys page from two URLs: `dev-settings/page.tsx` and
 * `dev-settings/api-keys/page.tsx` were the same four lines rendering the same
 * two components, and the tab strip linked to the first one. That left
 * `/dev-settings/api-keys` reachable with no tab highlighted, because the nav
 * compared the path to `/dev-settings` and got a miss.
 *
 * One page, at the URL named after it, and the bare `/dev-settings` sends you
 * there — so both addresses still work and the tab is right at both.
 */
export const Route = createFileRoute("/_dashboard/dev-settings/")({
  beforeLoad: () => {
    throw redirect({ to: "/dev-settings/api-keys" });
  },
});
