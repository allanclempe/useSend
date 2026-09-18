import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@usesend/ui/src/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@usesend/ui/src/dialog";
import { toast } from "@usesend/ui/src/toaster";

import { limitKeys } from "~/queries/limits";
import { teamKeys } from "~/queries/team";
import { deleteTeamInvite } from "~/server/functions/team";

/**
 * Cancel a pending invite.
 *
 * Invalidates the plan limits as well as the team: a pending invite counts
 * against the member limit, so cancelling one frees a seat and the invite
 * dialog must not still be holding the old answer.
 */
export const DeleteTeamInvite: React.FC<{
  invite: { id: string; email: string };
}> = ({ invite }) => {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const remove = useMutation({
    mutationFn: deleteTeamInvite,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: teamKeys.all });
      await queryClient.invalidateQueries({ queryKey: limitKeys.all });
      setOpen(false);
      toast.success("Invite cancelled successfully");
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next !== open ? setOpen(next) : null)}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <Trash2 className="h-4 w-4 text-red/80" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel Invite</DialogTitle>
          <DialogDescription>
            Are you sure you want to cancel the invite for{" "}
            <span className="font-semibold text-foreground">
              {invite.email}
            </span>
            ?
          </DialogDescription>
        </DialogHeader>
        <div className="mt-6 flex justify-end gap-4">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            isLoading={remove.isPending}
            onClick={() => remove.mutate({ data: { inviteId: invite.id } })}
            className="w-[150px]"
          >
            Delete Invite
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default DeleteTeamInvite;
