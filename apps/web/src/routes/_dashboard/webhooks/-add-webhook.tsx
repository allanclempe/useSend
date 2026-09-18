import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
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
import { toast } from "@usesend/ui/src/toaster";
import { WebhookEvents } from "@usesend/lib/src/webhook/webhook-events";

import { LimitReason } from "~/lib/constants/plans";
import { limitKeys, limitQueries } from "~/queries/limits";
import { webhookKeys } from "~/queries/webhook";
import { create as createWebhook } from "~/server/functions/webhook";
import { useUpgradeModalStore } from "~/store/upgradeModalStore";
import { DomainsPicker, EventTypesPicker } from "./-webhook-form-fields";

const webhookSchema = z.object({
  url: z
    .string({ required_error: "URL is required" })
    .url("Please enter a valid URL"),
  eventTypes: z.array(z.enum(WebhookEvents), {
    required_error: "Select at least one event",
  }),
  domainIds: z.array(z.number().int().positive()),
});

type WebhookFormValues = z.infer<typeof webhookSchema>;

export function AddWebhook() {
  const [open, setOpen] = useState(false);
  const [allEventsSelected, setAllEventsSelected] = useState(false);

  const queryClient = useQueryClient();
  const limitsQuery = useQuery(limitQueries.detail(LimitReason.WEBHOOK));
  const { openModal } = useUpgradeModalStore((s) => s.action);

  const form = useForm<WebhookFormValues>({
    resolver: zodResolver(webhookSchema),
    defaultValues: { url: "", eventTypes: [], domainIds: [] },
  });

  const addWebhook = useMutation({
    mutationFn: createWebhook,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: webhookKeys.all });
      // The new webhook counts against the plan, so the next dialog must not
      // be told the old answer. The tRPC version forgot this and only the
      // page reload corrected it.
      await queryClient.invalidateQueries({ queryKey: limitKeys.all });
      form.reset({ url: "", eventTypes: [], domainIds: [] });
      setAllEventsSelected(false);
      setOpen(false);
      toast.success("Webhook created successfully");
    },
    onError: (error) => toast.error(error.message),
  });

  function onOpenChange(nextOpen: boolean) {
    if (nextOpen && limitsQuery.data?.isLimitReached) {
      openModal(limitsQuery.data.reason);
      return;
    }

    setOpen(nextOpen);
  }

  function handleSubmit(values: WebhookFormValues) {
    if (limitsQuery.data?.isLimitReached) {
      openModal(limitsQuery.data.reason);
      return;
    }

    if (!allEventsSelected && values.eventTypes.length === 0) {
      toast.error("Select at least one event or all events");
      return;
    }

    addWebhook.mutate({
      data: {
        url: values.url,
        eventTypes: allEventsSelected ? [] : values.eventTypes,
        domainIds: values.domainIds,
      },
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) =>
        nextOpen !== open ? onOpenChange(nextOpen) : null
      }
    >
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-1 h-4 w-4" />
          Add webhook
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create a new webhook</DialogTitle>
        </DialogHeader>
        <div className="py-2">
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(handleSubmit)}
              className="space-y-6"
            >
              <FormField
                control={form.control}
                name="url"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Endpoint URL</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="https://example.com/webhooks/usesend"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="eventTypes"
                render={({ field, formState }) => (
                  <FormItem>
                    <FormLabel>Events</FormLabel>
                    <FormControl>
                      <EventTypesPicker
                        selectedEvents={field.value ?? []}
                        allEventsSelected={allEventsSelected}
                        onChange={(events, allEvents) => {
                          setAllEventsSelected(allEvents);
                          field.onChange(events);
                        }}
                      />
                    </FormControl>
                    {formState.errors.eventTypes ? <FormMessage /> : null}
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="domainIds"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Domains</FormLabel>
                    <FormControl>
                      <DomainsPicker
                        selectedDomainIds={field.value ?? []}
                        onChange={field.onChange}
                      />
                    </FormControl>
                    <FormDescription>
                      Leave this as all domains to receive events from every
                      domain.
                    </FormDescription>
                  </FormItem>
                )}
              />
              <div className="flex justify-end">
                <Button
                  className="w-[120px]"
                  type="submit"
                  disabled={addWebhook.isPending}
                >
                  {addWebhook.isPending ? "Creating..." : "Create"}
                </Button>
              </div>
            </form>
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default AddWebhook;
