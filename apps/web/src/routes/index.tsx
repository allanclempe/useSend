import { createFileRoute, redirect } from "@tanstack/react-router";

import { getSessionState } from "~/server/functions/session";

/**
 * `/` — the front door, and nothing else.
 *
 * `beforeLoad` runs during SSR, so the redirect is a real HTTP redirect on the
 * first request and a client-side navigation afterwards; one code path covers
 * both, which is what `app/page.tsx` needed `redirect()` from
 * `next/navigation` plus a server component for.
 */
export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const { signedIn, isWaitlisted } = await getSessionState();

    if (!signedIn) {
      throw redirect({ to: "/login" });
    }

    throw redirect({ to: isWaitlisted ? "/wait-list" : "/dashboard" });
  },
});
