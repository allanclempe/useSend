import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { z } from "zod";

import { Button } from "@usesend/ui/src/button";
import { toast } from "@usesend/ui/src/toaster";

import { DeleteResource } from "~/components/DeleteResource";
import { webhookKeys } from "~/queries/webhook";
import { deleteWebhook } from "~/server/functions/webhook";
import type { Webhook } from "~/types/db";

export const DeleteWebhook: React.FC<{ webhook: Webhook }> = ({ webhook }) => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const remove = useMutation({
    mutationFn: deleteWebhook,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: webhookKeys.all });
      toast.success("Webhook deleted");
      // This menu lives on both the list and the detail page, and the tRPC
      // version left the detail page sitting on a webhook that no longer
      // exists. Going to the list is right from either place: from the list
      // itself it is a navigation to where we already are.
      await navigate({ to: "/webhooks", replace: true });
    },
    onError: (error) => toast.error(error.message),
  });

  const schema = z
    .object({
      confirmation: z.string().min(1, "Please type the webhook URL to confirm"),
    })
    .refine((data) => data.confirmation === webhook.url, {
      message: "Webhook URL does not match",
      path: ["confirmation"],
    });

  return (
    <DeleteResource
      title="Delete webhook"
      resourceName={webhook.url}
      schema={schema}
      isLoading={remove.isPending}
      onConfirm={() => remove.mutate({ data: { id: webhook.id } })}
      confirmLabel="Delete webhook"
      trigger={
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start rounded-lg text-red/80 hover:bg-accent hover:text-red"
        >
          <Trash2 className="mr-2 h-4 w-4" />
          Delete
        </Button>
      }
    />
  );
};

export default DeleteWebhook;
