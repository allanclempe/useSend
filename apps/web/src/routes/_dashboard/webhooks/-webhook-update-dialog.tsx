import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button } from "@usesend/ui/src/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
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
import {
  WebhookEvents,
  type WebhookEventType,
} from "@usesend/lib/src/webhook/webhook-events";

import { webhookKeys } from "~/queries/webhook";
import { update as updateWebhook } from "~/server/functions/webhook";
import type { Webhook } from "~/types/db";
import { DomainsPicker, EventTypesPicker } from "./-webhook-form-fields";

const editWebhookSchema = z.object({
  url: z
    .string({ required_error: "URL is required" })
    .url("Please enter a valid URL"),
  eventTypes: z.array(z.enum(WebhookEvents), {
    required_error: "Select at least one event",
  }),
  domainIds: z.array(z.number().int().positive()),
});

type EditWebhookFormValues = z.infer<typeof editWebhookSchema>;

export function EditWebhookDialog({
  webhook,
  open,
  onOpenChange,
}: {
  webhook: Webhook;
  open: boolean;
  // `no-unused-vars` here is the base ESLint rule, not the TypeScript one:
  // it reads the parameter name in a function *type* as a declaration. The
  // config fix belongs in #87, not in every file that declares a callback.
  // eslint-disable-next-line no-unused-vars
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const initialHasAllEvents = webhook.eventTypes.length === 0;
  const [allEventsSelected, setAllEventsSelected] =
    useState(initialHasAllEvents);

  const form = useForm<EditWebhookFormValues>({
    resolver: zodResolver(editWebhookSchema),
    defaultValues: {
      url: webhook.url,
      eventTypes: initialHasAllEvents
        ? []
        : (webhook.eventTypes as WebhookEventType[]),
      domainIds: webhook.domainIds,
    },
  });

  // The dialog stays mounted between openings in the list, so the form has to
  // be put back to the row's own values each time it opens — otherwise the
  // second webhook you edit shows the first one's settings.
  useEffect(() => {
    if (open) {
      const hasAllEvents = webhook.eventTypes.length === 0;
      form.reset({
        url: webhook.url,
        eventTypes: hasAllEvents
          ? []
          : (webhook.eventTypes as WebhookEventType[]),
        domainIds: webhook.domainIds,
      });
      setAllEventsSelected(hasAllEvents);
    }
  }, [open, webhook, form]);

  const save = useMutation({
    mutationFn: updateWebhook,
    onSuccess: async () => {
      // A change of URL, events or domains shows in the list and on the detail
      // page, so the whole area goes.
      await queryClient.invalidateQueries({ queryKey: webhookKeys.all });
      toast.success("Webhook updated");
      onOpenChange(false);
    },
    onError: (error) => toast.error(error.message),
  });

  function handleSubmit(values: EditWebhookFormValues) {
    if (!allEventsSelected && values.eventTypes.length === 0) {
      toast.error("Select at least one event or all events");
      return;
    }

    save.mutate({
      data: {
        id: webhook.id,
        url: values.url,
        eventTypes: allEventsSelected ? [] : values.eventTypes,
        domainIds: values.domainIds,
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit webhook</DialogTitle>
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
                  disabled={save.isPending}
                >
                  {save.isPending ? "Saving..." : "Save changes"}
                </Button>
              </div>
            </form>
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default EditWebhookDialog;
