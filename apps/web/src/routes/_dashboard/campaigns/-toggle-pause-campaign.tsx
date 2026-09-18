import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pause, Play } from "lucide-react";

import { Button } from "@usesend/ui/src/button";
import { toast } from "@usesend/ui/src/toaster";

import { campaignKeys } from "~/queries/campaign";
import { pauseCampaign, resumeCampaign } from "~/server/functions/campaign";
import { CampaignStatus } from "~/types/db";

/**
 * Pause a running campaign, or resume a paused one.
 *
 * Renders nothing for any other status, which is what lets the card and the
 * detail page both drop it in unconditionally.
 *
 * It invalidates `campaignKeys.all`, which covers both the list it may have
 * been clicked from and any detail view that is open. `queries/campaign.ts`
 * explains why `details()` has to stay a usable prefix of `detail(id)` for
 * that to work.
 */
export const TogglePauseCampaign: React.FC<{
  campaign: { id: string; status: CampaignStatus };
  mode?: "icon" | "full";
}> = ({ campaign, mode = "icon" }) => {
  const queryClient = useQueryClient();
  const isPaused = campaign.status === CampaignStatus.PAUSED;

  const settle = async (message: string) => {
    await queryClient.invalidateQueries({ queryKey: campaignKeys.all });
    toast.success(message);
  };

  const pause = useMutation({
    mutationFn: pauseCampaign,
    onSuccess: () => settle("Campaign paused"),
    onError: (error) => toast.error(error.message),
  });

  const resume = useMutation({
    mutationFn: resumeCampaign,
    onSuccess: () => settle("Campaign resumed"),
    onError: (error) => toast.error(error.message),
  });

  if (
    campaign.status !== CampaignStatus.PAUSED &&
    campaign.status !== CampaignStatus.RUNNING
  ) {
    return null;
  }

  const pending = pause.isPending || resume.isPending;
  const onToggle = () => {
    const data = { data: { campaignId: campaign.id } };
    return isPaused ? resume.mutate(data) : pause.mutate(data);
  };

  if (mode === "full") {
    return (
      <Button
        className="gap-2 border-primary"
        onClick={onToggle}
        disabled={pending}
        title={isPaused ? "Resume" : "Pause"}
      >
        {isPaused ? (
          <Play className="h-[18px] w-[18px]" />
        ) : (
          <Pause className="h-[18px] w-[18px]" />
        )}
        <span>{isPaused ? "Resume" : "Pause"}</span>
      </Button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="p-0 hover:bg-transparent"
      onClick={onToggle}
      disabled={pending}
      title={isPaused ? "Resume" : "Pause"}
    >
      {isPaused ? (
        <Play className="h-[18px] w-[18px] text-green/80" />
      ) : (
        <Pause className="h-[18px] w-[18px] text-orange/80" />
      )}
    </Button>
  );
};

export default TogglePauseCampaign;
