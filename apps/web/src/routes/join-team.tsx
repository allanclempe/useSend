import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

import { getSessionState } from "~/server/functions/session";
import { JoinTeam } from "./-join-team";

/**
 * `/join-team` — the target of the link in a team invitation email.
 *
 * `?inviteId=` is carried through sign-in, so someone who follows the link
 * without a session gets sent to `/login` and back here afterwards with the
 * parameter intact. That is why `/login` declares `inviteId` too.
 */
export const Route = createFileRoute("/join-team")({
  validateSearch: z.object({ inviteId: z.string().optional() }),
  beforeLoad: async ({ search }) => {
    if (!(await getSessionState()).signedIn) {
      throw redirect({ to: "/login", search: { inviteId: search.inviteId } });
    }
  },
  component: JoinTeamPage,
});

function JoinTeamPage() {
  const { inviteId } = Route.useSearch();

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="flex w-[300px] flex-col gap-8">
        <JoinTeam inviteId={inviteId} />
      </div>
    </div>
  );
}
