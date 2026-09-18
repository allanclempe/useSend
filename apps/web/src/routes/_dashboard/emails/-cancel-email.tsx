import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import React, { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@usesend/ui/src/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@usesend/ui/src/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@usesend/ui/src/form";
import { Input } from "@usesend/ui/src/input";
import { toast } from "@usesend/ui/src/toaster";

import { emailKeys } from "~/queries/email";
import type { emails } from "~/server/functions/email";
import { cancelEmail } from "~/server/functions/email";
import { EmailStatus } from "~/types/db";

type EmailListPage = Awaited<ReturnType<typeof emails>>;

const cancelSchema = z.object({
  confirmation: z.string(),
});

export const CancelEmail: React.FC<{ emailId: string }> = ({ emailId }) => {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const cancel = useMutation({
    mutationFn: cancelEmail,
    onSuccess: async () => {
      // The row behind this dialog is in a list keyed by whatever filters the
      // user has set, and refetching every page of a log that goes back to the
      // team's first email to change one cell is not worth it. Writing the new
      // status into the cached pages says the same thing for free; the detail
      // view is refetched because the cancellation also adds an event to it.
      queryClient.setQueriesData<EmailListPage>(
        { queryKey: emailKeys.lists() },
        (page) =>
          page
            ? {
                ...page,
                emails: page.emails.map((email) =>
                  email.id === emailId
                    ? { ...email, latestStatus: EmailStatus.CANCELLED }
                    : email,
                ),
              }
            : page,
      );
      await queryClient.invalidateQueries({
        queryKey: emailKeys.detail(emailId),
      });
      setOpen(false);
      toast.success("Email cancelled");
    },
    onError: (error) => toast.error(`Error cancelling email: ${error.message}`),
  });

  const cancelForm = useForm<z.infer<typeof cancelSchema>>({
    resolver: zodResolver(cancelSchema),
  });

  function onEmailCancel(values: z.infer<typeof cancelSchema>) {
    if (values.confirmation !== "cancel") {
      cancelForm.setError("confirmation", {
        message: "Confirmation does not match",
      });
      return;
    }

    cancel.mutate({ data: { id: emailId } });
  }

  const confirmation = cancelForm.watch("confirmation");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next !== open ? setOpen(next) : null)}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <Trash2 className="h-4 w-4 text-red" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel Email</DialogTitle>
          <DialogDescription>
            Are you sure you want to cancel this email? This action cannot be
            undone.
          </DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <Form {...cancelForm}>
            <form
              onSubmit={cancelForm.handleSubmit(onEmailCancel)}
              className="space-y-4"
            >
              <FormField
                control={cancelForm.control}
                name="confirmation"
                render={({ field, formState }) => (
                  <FormItem>
                    <FormLabel>Type &quot;cancel&quot; to confirm</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    {formState.errors.confirmation ? (
                      <FormMessage />
                    ) : (
                      <FormDescription className="text-transparent">
                        .
                      </FormDescription>
                    )}
                  </FormItem>
                )}
              />
              <div className="flex justify-end">
                <Button
                  type="submit"
                  variant="destructive"
                  disabled={cancel.isPending || confirmation !== "cancel"}
                >
                  {cancel.isPending ? "Cancelling..." : "Cancel Email"}
                </Button>
              </div>
            </form>
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default CancelEmail;
