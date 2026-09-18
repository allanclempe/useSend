import { createFileRoute } from "@tanstack/react-router";

import { H1 } from "@usesend/ui";

import { campaignQueries } from "~/queries/campaign";
import CampaignList from "./-campaign-list";
import { campaignListFilters, campaignSearchSchema } from "./-campaign-filters";
import CreateCampaign from "./-create-campaign";

/**
 * `/campaigns`.
 *
 * The loader warms the page the URL asks for, keyed on the same filters the
 * list builds its query key from, so a bookmarked `?status=SENT&page=2`
 * arrives with its cards rather than a spinner.
 */
export const Route = createFileRoute("/_dashboard/campaigns/")({
  validateSearch: campaignSearchSchema,
  loaderDeps: ({ search }) => campaignListFilters(search),
  loader: ({ context, deps }) =>
    context.queryClient.ensureQueryData(campaignQueries.list(deps)),
  component: CampaignsPage,
});

function CampaignsPage() {
  return (
    <div>
      <div className="flex items-center justify-between">
        <H1>Campaigns</H1>
        <CreateCampaign />
      </div>
      <CampaignList />
    </div>
  );
}
