import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "@usesend/ui/src/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@usesend/ui/src/dialog";
import { Spinner } from "@usesend/ui/src/spinner";
import { toast } from "@usesend/ui/src/toaster";

import { invitationKeys, invitationQueries } from "~/queries/invitation";
import { teamKeys } from "~/queries/team";
import {
  acceptTeamInvite,
  type getUserInvites,
} from "~/server/functions/invitation";

/**
 * The invitations a signed-in user can accept.
 *
 * Lives outside `routes/_dashboard` because it is used on both sides of the
 * team gate: `/join-team` for someone following a link from an invitation
 * email, and the create-team screen for someone who has no team yet. Neither
 * can be behind `teamMiddleware`, which is why the server functions it calls
 * are `protectedMiddleware`.
 */
type Invite = Awaited<ReturnType<typeof getUserInvites>>[number];

export function JoinTeam({
  inviteId,
  showCreateTeam = false,
}: {
  inviteId?: string | null;
  showCreateTeam?: boolean;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();

  const { data: invites } = useQuery(invitationQueries.userInvites(inviteId));

  const [selectedInvite, setSelectedInvite] = useState<Invite | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const join = useMutation({
    mutationFn: acceptTeamInvite,
    onSuccess: async () => {
      toast.success(`Successfully joined ${selectedInvite?.team.name}`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: invitationKeys.all }),
        queryClient.invalidateQueries({ queryKey: teamKeys.all }),
      ]);
      setDialogOpen(false);
      await router.navigate({ to: "/dashboard", replace: true });
    },
    onError: (error) => {
      toast.error(`Failed to join team: ${error.message}`);
      setDialogOpen(false);
    },
  });

  if (!invites?.length) {
    return !showCreateTeam ? (
      <div className="text-center text-xl">No invites found</div>
    ) : null;
  }

  return (
    <div>
      <div>You have been invited to join team</div>
      <div className="mt-4 space-y-2">
        {invites.map((invite) => (
          <div
            key={invite.id}
            className="flex items-center justify-between gap-2 rounded-lg border p-2 px-4 shadow"
          >
            <div>
              <div className="text-sm">{invite.team.name}</div>
              <div className="flex items-center gap-2">
                <div className="text-xs capitalize text-muted-foreground">
                  {invite.role.toLowerCase()}
                </div>
                <div className="text-xs text-muted-foreground">
                  {new Date(invite.createdAt).toLocaleDateString()}
                </div>
              </div>
            </div>
            <Button
              onClick={() => {
                setSelectedInvite(invite);
                setDialogOpen(true);
              }}
              disabled={join.isPending}
              size="sm"
              variant="ghost"
            >
              {join.isPending ? <Spinner className="h-5 w-5" /> : "Accept"}
            </Button>
          </div>
        ))}
      </div>
      {showCreateTeam ? (
        <div className="mt-8 text-center font-mono text-sm text-muted-foreground">
          OR
        </div>
      ) : null}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Accept Team Invitation</DialogTitle>
            <DialogDescription>
              Are you sure you want to join{" "}
              <span className="font-semibold text-foreground">
                {selectedInvite?.team.name}
              </span>
              ? You will be added as a{" "}
              <span className="font-semibold lowercase text-foreground">
                {selectedInvite?.role.toLowerCase()}
              </span>
              .
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-3">
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={join.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() =>
                selectedInvite &&
                join.mutate({ data: { inviteId: selectedInvite.id } })
              }
              disabled={join.isPending}
            >
              {join.isPending ? (
                <Spinner className="h-5 w-5" />
              ) : (
                "Accept Invitation"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default JoinTeam;
