import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
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
import Spinner from "@usesend/ui/src/spinner";
import { toast } from "@usesend/ui/src/toaster";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@usesend/ui/src/tooltip";

import { contactKeys } from "~/queries/contacts";
import { resendDoubleOptInConfirmation } from "~/server/functions/contacts";

/**
 * Send the confirmation email again to a contact who has not confirmed.
 *
 * Only rendered for a pending contact, but the server refuses a confirmed one
 * anyway — `resendDoubleOptInConfirmation` turns that refusal into
 * `BAD_REQUEST`, which arrives here as a toast.
 */
export function ResendDoubleOptInConfirmation({
  contactBookId,
  contactId,
  email,
}: {
  contactBookId: string;
  contactId: string;
  email: string;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const resend = useMutation({
    mutationFn: resendDoubleOptInConfirmation,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: contactKeys.all });
      toast.success(`Confirmation email resent to ${email}`);
      setOpen(false);
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button variant="ghost" size="sm" disabled={resend.isPending}>
              {resend.isPending ? (
                <Spinner className="h-4 w-4" innerSvgClass="stroke-primary" />
              ) : (
                <Send className="h-4 w-4 text-muted-foreground" />
              )}
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p>Resend confirmation email</p>
        </TooltipContent>
      </Tooltip>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resend Confirmation Email</DialogTitle>
          <DialogDescription>
            Send a new double opt-in confirmation email to{" "}
            <strong>{email}</strong>?
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={resend.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() =>
              resend.mutate({ data: { contactBookId, contactId } })
            }
            disabled={resend.isPending}
          >
            {resend.isPending ? "Resending..." : "Resend"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ResendDoubleOptInConfirmation;
