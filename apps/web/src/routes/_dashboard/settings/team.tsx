import { createFileRoute } from "@tanstack/react-router";

import { teamQueries } from "~/queries/team";
import InviteTeamMember from "./-invite-team-member";
import TeamMembersList from "./-team-members-list";

/**
 * `/settings/team`.
 *
 * Both halves of the table are warmed in the loader, so the page arrives with
 * its rows instead of showing a spinner and then asking twice.
 */
export const Route = createFileRoute("/_dashboard/settings/team")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(teamQueries.users()),
      context.queryClient.ensureQueryData(teamQueries.invites()),
    ]),
  component: TeamSettingsPage,
});

function TeamSettingsPage() {
  return (
    <div>
      <div className="flex justify-end">
        <InviteTeamMember />
      </div>
      <TeamMembersList />
    </div>
  );
}
