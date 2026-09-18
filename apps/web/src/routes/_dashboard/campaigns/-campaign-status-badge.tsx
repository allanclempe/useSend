import { CampaignStatus } from "~/types/db";

const statusClasses: Record<CampaignStatus, string> = {
  [CampaignStatus.DRAFT]: "bg-gray/15 text-gray border border-gray/20",
  [CampaignStatus.SCHEDULED]: "bg-gray/15 text-gray border border-gray/20",
  [CampaignStatus.RUNNING]: "bg-blue/15 text-blue border border-blue/20",
  [CampaignStatus.PAUSED]: "bg-yellow/15 text-yellow border border-yellow/20",
  [CampaignStatus.SENT]: "bg-green/15 text-green border border-green/20",
};

export default function CampaignStatusBadge({
  status,
}: {
  status: CampaignStatus;
}) {
  return (
    <div
      className={`min-w-[110px] rounded px-3 py-1 text-center text-xs capitalize ${statusClasses[status]}`}
    >
      {status.toLowerCase()}
    </div>
  );
}
