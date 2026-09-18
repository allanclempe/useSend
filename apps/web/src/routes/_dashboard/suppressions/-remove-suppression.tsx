import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@usesend/ui/src/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@usesend/ui/src/dialog";
import { toast } from "@usesend/ui/src/toaster";

import { suppressionKeys } from "~/queries/suppression";
import { removeSuppression } from "~/server/functions/suppression";

/**
 * Take one address off the suppression list.
 *
 * Self-contained, like `-delete-domain.tsx`: it owns its trigger, its open
 * state and its mutation. The Next.js version lifted all three into the table
 * — one `emailToRemove` string, one dialog and one shared mutation for the
 * whole page — which meant every row's delete button was disabled while any
 * row was being removed.
 */
export default function RemoveSuppression({ email }: { email: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const remove = useMutation({
    mutationFn: removeSuppression,
    onSuccess: async () => {
      // One invalidation for the table and the counters above it: both keys
      // hang off `suppressionKeys.all`.
      await queryClient.invalidateQueries({ queryKey: suppressionKeys.all });
      setOpen(false);
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <Trash2 className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove Suppression</DialogTitle>
          <DialogDescription>
            Are you sure you want to remove <strong>{email}</strong> from the
            suppression list? This email address will be able to receive emails
            again.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={remove.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => remove.mutate({ data: { email } })}
            disabled={remove.isPending}
          >
            {remove.isPending ? "Removing..." : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
