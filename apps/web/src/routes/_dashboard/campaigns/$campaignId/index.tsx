import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { H2 } from "@usesend/ui";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@usesend/ui/src/breadcrumb";
import { Button } from "@usesend/ui/src/button";
import Spinner from "@usesend/ui/src/spinner";

import { campaignQueries } from "~/queries/campaign";
import { CampaignStatus } from "~/types/db";
import CampaignStatusBadge from "../-campaign-status-badge";
import { TogglePauseCampaign } from "../-toggle-pause-campaign";
import { CampaignStatistics } from "./-campaign-statistics";
import { LiveActivity } from "./-live-activity";

/**
 * `/campaigns/$campaignId` — the report for a campaign that has been sent, or
 * is being sent.
 *
 * The campaign polls only while it is in flight; the activity list beside it
 * polls always. A campaign that does not exist, or belongs to another team,
 * fails the loader with `NOT_FOUND` and reaches the catch boundary — the
 * Next.js page rendered the words "Campaign not found" in place.
 */
export const Route = createFileRoute("/_dashboard/campaigns/$campaignId/")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(
      campaignQueries.detail(params.campaignId),
    ),
  pendingComponent: () => (
    <div className="flex h-screen items-center justify-center">
      <Spinner className="h-5 w-5 text-foreground" />
    </div>
  ),
  component: CampaignDetailsPage,
});

function CampaignDetailsPage() {
  const { campaignId } = Route.useParams();

  const campaignQuery = useQuery({
    ...campaignQueries.detail(campaignId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;

      return status === CampaignStatus.RUNNING ||
        status === CampaignStatus.PAUSED
        ? 5000
        : false;
    },
  });

  const campaign = campaignQuery.data;

  if (!campaign) {
    return null;
  }

  return (
    <div className="container mx-auto">
      <div className="flex items-center justify-between">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to="/campaigns" className="text-lg">
                  Campaigns
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="text-lg" />
            <BreadcrumbItem>
              <BreadcrumbPage className="text-lg">
                <div className="flex items-center gap-2">
                  <div className="max-w-[300px] truncate">{campaign.name}</div>
                  <CampaignStatusBadge status={campaign.status} />
                </div>
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        {campaign.status === CampaignStatus.SCHEDULED ? (
          <Link
            to="/campaigns/$campaignId/edit"
            params={{ campaignId: campaign.id }}
          >
            <Button>Edit</Button>
          </Link>
        ) : (
          <TogglePauseCampaign campaign={campaign} mode="full" />
        )}
      </div>

      <div className="mt-10 grid gap-6 lg:grid-cols-2">
        <CampaignStatistics
          total={campaign.total ?? 0}
          processed={campaign.sent ?? 0}
          delivered={campaign.delivered ?? 0}
          opened={campaign.opened ?? 0}
          clicked={campaign.clicked ?? 0}
          unsubscribed={campaign.unsubscribed ?? 0}
        />
        <LiveActivity campaignId={campaignId} />
      </div>

      {campaign.html ? (
        <div className="mt-16 rounded-lg">
          <H2 className="mb-4">Email</H2>

          <div className="flex w-full flex-col gap-4 rounded-lg border p-2 shadow">
            <div className="flex flex-col gap-3 px-4 py-1">
              <div className="flex text-sm">
                <div className="w-[70px] text-muted-foreground">Subject</div>
                <div>{campaign.subject}</div>
              </div>
              <div className="flex text-sm">
                <div className="w-[70px] text-muted-foreground">From</div>
                <div>{campaign.from}</div>
              </div>
              {campaign.contactBookId ? (
                <div className="flex items-center text-sm">
                  <div className="w-[70px] text-muted-foreground">Contact</div>
                  <Link
                    to="/contacts/$contactBookId"
                    params={{ contactBookId: campaign.contactBookId }}
                    target="_blank"
                  >
                    <div className="rounded-md bg-secondary p-0.5 px-2">
                      {campaign.contactBook?.emoji} &nbsp;
                      {campaign.contactBook?.name}
                    </div>
                  </Link>
                </div>
              ) : null}
            </div>
            {/*
              `sandbox="allow-same-origin"` without `allow-scripts`: the HTML is
              whatever the campaign's author put in the editor, and it is being
              shown to their colleagues. Same-origin is needed for the frame to
              size itself; scripts are not needed at all.
            */}
            <div className="overflow-auto rounded border-t text-black dark:bg-slate-50">
              <iframe
                className="min-h-[600px] w-full"
                srcDoc={campaign.html}
                sandbox="allow-same-origin"
                title="Campaign email preview"
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
