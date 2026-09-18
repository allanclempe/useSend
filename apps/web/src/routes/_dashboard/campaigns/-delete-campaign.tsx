import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { z } from "zod";

import { Button } from "@usesend/ui/src/button";
import { toast } from "@usesend/ui/src/toaster";

import { DeleteResource } from "~/components/DeleteResource";
import { campaignKeys } from "~/queries/campaign";
import { deleteCampaign } from "~/server/functions/campaign";

/**
 * Delete a campaign, after typing its name back.
 *
 * The Next.js version had no `onError`, so a refused delete closed the dialog
 * and said nothing at all.
 */
export const DeleteCampaign: React.FC<{
  campaign: { id: string; name: string };
}> = ({ campaign }) => {
  const queryClient = useQueryClient();

  const remove = useMutation({
    mutationFn: deleteCampaign,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: campaignKeys.all });
      toast.success("Campaign deleted");
    },
    onError: (error) => toast.error(error.message),
  });

  const confirmationSchema = z
    .object({
      confirmation: z
        .string()
        .min(1, "Please type the campaign name to confirm"),
    })
    .refine((values) => values.confirmation === campaign.name, {
      message: "Campaign name does not match",
      path: ["confirmation"],
    });

  return (
    <DeleteResource
      title="Delete Campaign"
      resourceName={campaign.name}
      schema={confirmationSchema}
      isLoading={remove.isPending}
      onConfirm={() => remove.mutate({ data: { campaignId: campaign.id } })}
      trigger={
        <Button variant="ghost" size="sm" className="p-0 hover:bg-transparent">
          <Trash2 className="h-[18px] w-[18px] text-red/80" />
        </Button>
      }
      confirmLabel="Delete Campaign"
    />
  );
};

export default DeleteCampaign;
