import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

import { getSessionState } from "~/server/functions/session";

/**
 * `/join-team` — the target of the link in a team invitation email.
 *
 * The gate is here; the invitation list is not. It reads through the
 * `invitation` router, which has not moved yet, and arrives with that area.
 * The route exists now because the URL is already sitting in delivered inboxes
 * and because sign-in redirects to it with `?inviteId=`.
 */
export const Route = createFileRoute("/join-team")({
  validateSearch: z.object({ inviteId: z.string().optional() }),
  beforeLoad: async ({ search }) => {
    if (!(await getSessionState()).signedIn) {
      throw redirect({ to: "/login", search: { inviteId: search.inviteId } });
    }
  },
  component: JoinTeam,
});

function JoinTeam() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-lg rounded-lg border border-dashed p-8 text-center">
        <p className="font-medium">Invitations have not moved yet</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Accepting a team invitation still goes through the Next.js app.
        </p>
      </div>
    </div>
  );
}
