import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { z } from "zod";

import { Button } from "@usesend/ui/src/button";
import { toast } from "@usesend/ui/src/toaster";

import { DeleteResource } from "~/components/DeleteResource";
import { apiKeyKeys } from "~/queries/api-key";
import { deleteApiKey } from "~/server/functions/api-key";
import type { ApiKeyRow } from "./-api-key-row";

export const DeleteApiKey: React.FC<{ apiKey: ApiKeyRow }> = ({ apiKey }) => {
  const queryClient = useQueryClient();

  const remove = useMutation({
    mutationFn: deleteApiKey,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: apiKeyKeys.all });
      toast.success("API key deleted");
    },
    onError: (error) => toast.error(error.message),
  });

  const apiKeySchema = z
    .object({
      confirmation: z.string().min(1, "Please type the API key name to confirm"),
    })
    .refine((data) => data.confirmation === apiKey.name, {
      message: "API key name does not match",
      path: ["confirmation"],
    });

  return (
    <DeleteResource
      title="Delete API key"
      resourceName={apiKey.name}
      schema={apiKeySchema}
      isLoading={remove.isPending}
      onConfirm={() => remove.mutate({ data: { id: apiKey.id } })}
      trigger={
        <Button variant="ghost" size="sm">
          <Trash2 className="h-4 w-4 text-red/80" />
        </Button>
      }
      confirmLabel="Delete API key"
    />
  );
};

export default DeleteApiKey;
