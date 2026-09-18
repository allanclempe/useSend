import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Edit } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@usesend/ui/src/button";
import {
  Dialog,
  DialogContent,
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
import Spinner from "@usesend/ui/src/spinner";
import { toast } from "@usesend/ui/src/toaster";

import { adminKeys } from "~/queries/admin";
import { updateSesSettings } from "~/server/functions/admin";
import type { SesSetting } from "~/types/db";

const formSchema = z.object({
  sendRate: z.coerce.number(),
  transactionalQuota: z.coerce.number().min(0).max(100),
});

type EditSesFormValues = z.infer<typeof formSchema>;

/**
 * Change a region's send rate and transactional quota.
 *
 * The region and the callback URL are not editable and never were: both are
 * part of the SNS subscription SES was told about when the region was added.
 */
export default function EditSesConfiguration({
  setting,
}: {
  setting: SesSetting;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const form = useForm<EditSesFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      sendRate: setting.sesEmailRateLimit,
      transactionalQuota: setting.transactionalQuota,
    },
  });

  const update = useMutation({
    mutationFn: updateSesSettings,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: adminKeys.all });
      setOpen(false);
    },
    onError: (error) =>
      toast.error("Failed to update", { description: error.message }),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next !== open ? setOpen(next) : null)}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <Edit className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit SES configuration</DialogTitle>
        </DialogHeader>
        <div className="py-2">
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit((values) =>
                update.mutate({ data: { ...values, settingsId: setting.id } }),
              )}
              className="flex w-full flex-col gap-8"
            >
              <FormField
                control={form.control}
                name="sendRate"
                render={({ field, formState }) => (
                  <FormItem>
                    <FormLabel>Send Rate</FormLabel>
                    <FormControl>
                      <Input placeholder="1" className="w-full" {...field} />
                    </FormControl>
                    {formState.errors.sendRate ? (
                      <FormMessage />
                    ) : (
                      <FormDescription>
                        The number of emails to send per second. Saved
                        immediately, but the send workers are only resized on
                        the next deploy — queue concurrency is deploy-time
                        configuration.
                      </FormDescription>
                    )}
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="transactionalQuota"
                render={({ field, formState }) => (
                  <FormItem>
                    <FormLabel>Transactional Quota</FormLabel>
                    <FormControl>
                      <Input placeholder="0" className="w-full" {...field} />
                    </FormControl>
                    {formState.errors.transactionalQuota ? (
                      <FormMessage />
                    ) : (
                      <FormDescription>
                        The percentage of the quota to be used for transactional
                        emails (0-100%). Takes effect on the next deploy, for
                        the same reason as the send rate.
                      </FormDescription>
                    )}
                  </FormItem>
                )}
              />
              <Button
                type="submit"
                disabled={update.isPending}
                className="mx-auto w-[200px]"
              >
                {update.isPending ? <Spinner className="h-5 w-5" /> : "Update"}
              </Button>
            </form>
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
