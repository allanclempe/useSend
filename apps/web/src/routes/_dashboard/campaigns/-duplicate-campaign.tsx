import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
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

import { campaignKeys } from "~/queries/campaign";
import { duplicateCampaign } from "~/server/functions/campaign";

export const DuplicateCampaign: React.FC<{
  campaign: { id: string; name: string };
}> = ({ campaign }) => {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const duplicate = useMutation({
    mutationFn: duplicateCampaign,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: campaignKeys.all });
      setOpen(false);
      toast.success("Campaign duplicated");
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="p-0 hover:bg-transparent">
          <Copy className="h-[18px] w-[18px] text-blue/80" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Duplicate Campaign</DialogTitle>
          <DialogDescription>
            Are you sure you want to duplicate{" "}
            <span className="font-semibold text-foreground">
              {campaign.name}
            </span>
            ?
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end py-2">
          <Button
            onClick={() =>
              duplicate.mutate({ data: { campaignId: campaign.id } })
            }
            disabled={duplicate.isPending}
          >
            {duplicate.isPending ? "Duplicating..." : "Duplicate"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default DuplicateCampaign;
