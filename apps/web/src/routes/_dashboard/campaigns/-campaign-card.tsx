import { Link } from "@tanstack/react-router";
import { format } from "date-fns";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@usesend/ui/src/tooltip";

import { CampaignStatus } from "~/types/db";
import CampaignStatusBadge from "./-campaign-status-badge";
import { DeleteCampaign } from "./-delete-campaign";
import { DuplicateCampaign } from "./-duplicate-campaign";
import { TogglePauseCampaign } from "./-toggle-pause-campaign";

export type CampaignCardData = {
  id: string;
  name: string;
  status: CampaignStatus;
  scheduledAt?: Date | null;
  total: number;
  sent: number;
  delivered: number;
  unsubscribed: number;
};

/**
 * One campaign in the list.
 *
 * The name links to the editor while a campaign is still a draft or scheduled,
 * and to the report once it is not -- there is nothing to edit about a campaign
 * that has gone out, and the editor would refuse anyway.
 *
 * Which counts are shown follows from the same thing: a scheduled campaign has
 * a date and no numbers, a sent one has outcomes, and one in flight has
 * progress.
 */
export default function CampaignCard({
  campaign,
}: {
  campaign: CampaignCardData;
}) {
  const isEditable =
    campaign.status === CampaignStatus.DRAFT ||
    campaign.status === CampaignStatus.SCHEDULED;
  const pendingCount = campaign.total - campaign.sent;

  return (
    <div className="rounded-xl border border-border p-4 shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-center justify-between">
        <div className="w-1/3">
          <Link
            to={
              isEditable
                ? "/campaigns/$campaignId/edit"
                : "/campaigns/$campaignId"
            }
            params={{ campaignId: campaign.id }}
          >
            <div className="text-ellipsis text-sm font-medium underline decoration-dashed underline-offset-2">
              {campaign.name}
            </div>
          </Link>

          <div className="mt-2 font-mono text-sm text-muted-foreground">
            {campaign.status === CampaignStatus.SCHEDULED ? (
              campaign.scheduledAt ? (
                <div>
                  At{" "}
                  <strong>
                    {format(new Date(campaign.scheduledAt), "MMM do, hh:mm a")}
                  </strong>
                </div>
              ) : null
            ) : campaign.status === CampaignStatus.SENT ? (
              <div className="flex items-center gap-2">
                <span>
                  Delivered <strong>{campaign.delivered},</strong>
                </span>
                <span>
                  Unsubscribed <strong>{campaign.unsubscribed}</strong>
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span>
                  Sent <strong>{campaign.sent},</strong>
                </span>
                {pendingCount > 0 ? (
                  <span>
                    Pending <strong>{pendingCount}</strong>
                  </span>
                ) : null}
              </div>
            )}
          </div>
        </div>

        <CampaignStatusBadge status={campaign.status} />

        <TooltipProvider>
          <div className="flex w-[150px] items-center justify-end gap-4">
            {campaign.status === CampaignStatus.RUNNING ||
            campaign.status === CampaignStatus.PAUSED ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <TogglePauseCampaign campaign={campaign} />
                  </span>
                </TooltipTrigger>
                <TooltipContent className="text-xs">
                  {campaign.status === CampaignStatus.PAUSED
                    ? "Resume campaign"
                    : "Pause campaign"}
                </TooltipContent>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <DuplicateCampaign campaign={campaign} />
                </span>
              </TooltipTrigger>
              <TooltipContent className="text-xs">
                Duplicate campaign
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <DeleteCampaign campaign={campaign} />
                </span>
              </TooltipTrigger>
              <TooltipContent className="text-xs">
                Delete campaign
              </TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      </div>
    </div>
  );
}
