import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";

import Spinner from "@usesend/ui/src/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@usesend/ui/src/table";

import { useSession } from "~/lib/auth-client";
import { teamQueries } from "~/queries/team";
import { useTeam } from "../-team-context";
import { DeleteTeamInvite } from "./-delete-team-invite";
import { DeleteTeamMember } from "./-delete-team-member";
import { EditTeamMember } from "./-edit-team-member";
import { ResendTeamInvite } from "./-resend-team-invite";

/**
 * Members and pending invites in one table.
 *
 * Two queries rather than one, because they are two server functions and two
 * things that change independently — inviting someone adds a row to the second
 * and nothing to the first until they accept. They share `teamKeys.all` as a
 * prefix, so every write in this area invalidates both with one call.
 *
 * Who may do what is decided on the server; the checks here only hide buttons
 * that would be refused. The one that is not about admin rights is the delete
 * on your own row: a MEMBER can remove themselves, which is how you leave a
 * team.
 */
export default function TeamMembersList() {
  const { currentIsAdmin } = useTeam();
  const { data: session } = useSession();

  const membersQuery = useQuery(teamQueries.users());
  const invitesQuery = useQuery(teamQueries.invites());

  const members = membersQuery.data ?? [];
  const invites = invitesQuery.data ?? [];
  const isLoading = membersQuery.isLoading || invitesQuery.isLoading;

  return (
    <div className="mt-10 flex flex-col gap-4">
      <div className="flex flex-col rounded-xl border border-border shadow">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30">
              <TableHead className="rounded-tl-xl">User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="rounded-tr-xl">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow className="h-32">
                <TableCell colSpan={5} className="py-4 text-center">
                  <Spinner
                    className="mx-auto h-6 w-6"
                    innerSvgClass="stroke-primary"
                  />
                </TableCell>
              </TableRow>
            ) : members.length > 0 ? (
              members.map((member) => {
                const isSelf = session?.user.id === String(member.userId);

                return (
                  <TableRow key={member.userId}>
                    <TableCell className="font-medium">
                      {member.user?.email ?? "Unknown user"}
                    </TableCell>
                    <TableCell>
                      <div className="rounded py-1 text-xs capitalize">
                        {member.role.toLowerCase()}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="w-[100px] rounded border border-green/25 bg-green/15 py-1 text-center text-xs capitalize text-green">
                        Active
                      </div>
                    </TableCell>
                    <TableCell>
                      {formatDistanceToNow(new Date(member.user.createdAt), {
                        addSuffix: true,
                      })}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        {currentIsAdmin ? (
                          <EditTeamMember
                            teamUser={{
                              ...member,
                              userId: String(member.userId),
                            }}
                          />
                        ) : null}
                        {currentIsAdmin || isSelf ? (
                          <DeleteTeamMember
                            teamUser={{
                              userId: String(member.userId),
                              role: member.role,
                              email: member.user?.email ?? "Unknown user",
                            }}
                            self={isSelf}
                          />
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            ) : (
              <TableRow className="h-32">
                <TableCell colSpan={5} className="py-4 text-center">
                  No team members found
                </TableCell>
              </TableRow>
            )}

            {invites.map((invite) => (
              <TableRow key={invite.id}>
                <TableCell className="font-medium">{invite.email}</TableCell>
                <TableCell>
                  <div className="w-[100px] rounded py-1 text-xs capitalize">
                    {invite.role.toLowerCase()}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="w-[100px] rounded border border-yellow/25 bg-yellow/15 py-1 text-center text-xs capitalize text-yellow">
                    Pending
                  </div>
                </TableCell>
                <TableCell>
                  {formatDistanceToNow(new Date(invite.createdAt), {
                    addSuffix: true,
                  })}
                </TableCell>
                <TableCell>
                  <div className="flex gap-2">
                    {currentIsAdmin ? (
                      <>
                        <ResendTeamInvite invite={invite} />
                        <DeleteTeamInvite invite={invite} />
                      </>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
