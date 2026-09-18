import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LogOut, Trash2 } from "lucide-react";
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

import { teamKeys } from "~/queries/team";
import { deleteTeamUser } from "~/server/functions/team";
import type { Role } from "~/types/db";

/**
 * Removes a member, or leaves the team when it is the signed-in user's own
 * row. Which of the two it is only changes the wording and the icon: the
 * server decides whether it is allowed, from the caller's role and id.
 */
export const DeleteTeamMember: React.FC<{
  teamUser: { userId: string; role: Role; email: string };
  self: boolean;
}> = ({ teamUser, self }) => {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const remove = useMutation({
    mutationFn: deleteTeamUser,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: teamKeys.all });
      setOpen(false);
      toast.success("Team member removed successfully");
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
          {self ? (
            <LogOut className="h-4 w-4 text-red/80" />
          ) : (
            <Trash2 className="h-4 w-4 text-red/80" />
          )}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {self ? "Leave Team" : "Remove Team Member"}
          </DialogTitle>
          <DialogDescription>
            {self
              ? "Are you sure you want to leave the team? This action cannot be undone."
              : `Are you sure you want to remove ${teamUser.email} from the team? This action cannot be undone.`}
          </DialogDescription>
        </DialogHeader>
        <div className="mt-6 flex justify-end gap-4">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => remove.mutate({ data: { userId: teamUser.userId } })}
            isLoading={remove.isPending}
            className="w-[150px]"
          >
            {self ? "Leave" : "Remove"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default DeleteTeamMember;
