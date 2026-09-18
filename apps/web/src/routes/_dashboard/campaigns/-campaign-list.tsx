import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useDebouncedCallback } from "use-debounce";

import { Button } from "@usesend/ui/src/button";
import { Input } from "@usesend/ui/src/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@usesend/ui/src/select";
import Spinner from "@usesend/ui/src/spinner";

import { campaignQueries } from "~/queries/campaign";
import { CampaignStatus } from "~/types/db";
import CampaignCard from "./-campaign-card";
import { campaignListFilters, FILTERABLE_STATUSES } from "./-campaign-filters";

const route = getRouteApi("/_dashboard/campaigns/");

/**
 * The campaign list, filtered from the URL.
 *
 * **The search box actually debounces now.** The Next.js version called
 * `useUrlState("search")` twice and used one copy as the "typed" value and the
 * other as the "committed" one -- but they are the same URL key, so the
 * immediate setter wrote it on every keystroke and the debounced one wrote it
 * again a second later. Every character was a history entry and a refetch. The
 * typed value is component state here and only the debounce touches the URL.
 *
 * A list with anything in flight polls every five seconds; one without does
 * not poll at all. `SCHEDULED` counts as in flight because the scheduler will
 * start it without anyone reloading the page.
 */
export default function CampaignList() {
  const search = route.useSearch();
  const navigate = useNavigate();

  const filters = campaignListFilters(search);

  const campaignsQuery = useQuery({
    ...campaignQueries.list(filters),
    refetchInterval: (query) => {
      const campaigns = query.state.data?.campaigns;

      if (!campaigns) {
        return false;
      }

      return campaigns.some(
        (campaign) =>
          campaign.status === CampaignStatus.RUNNING ||
          campaign.status === CampaignStatus.SCHEDULED,
      )
        ? 5000
        : false;
    },
  });

  // Typing is a filter change, so it replaces the history entry rather than
  // leaving one per keystroke behind for the back button.
  const debouncedSearch = useDebouncedCallback((value: string) => {
    void navigate({
      to: "/campaigns",
      search: (previous) => ({
        ...previous,
        search: value || undefined,
        page: 1,
      }),
      replace: true,
    });
  }, 1000);

  function handleStatus(value: string) {
    void navigate({
      to: "/campaigns",
      search: (previous) => ({
        ...previous,
        status: value === "all" ? undefined : (value as CampaignStatus),
        page: 1,
      }),
      replace: true,
    });
  }

  // Paging, unlike filtering, is a place you can want to go back to.
  function goToPage(page: number) {
    void navigate({
      to: "/campaigns",
      search: (previous) => ({ ...previous, page }),
    });
  }

  return (
    <div className="mt-10 flex flex-col gap-4">
      <div className="flex flex-col justify-between gap-4 sm:flex-row">
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search campaigns..."
            defaultValue={search.search ?? ""}
            onChange={(e) => debouncedSearch(e.target.value)}
            className="pl-10"
          />
        </div>

        <Select value={search.status ?? "all"} onValueChange={handleStatus}>
          <SelectTrigger className="w-[180px] capitalize">
            {search.status ? search.status.toLowerCase() : "All statuses"}
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="capitalize">
              All statuses
            </SelectItem>
            {FILTERABLE_STATUSES.map((status) => (
              <SelectItem key={status} value={status} className="capitalize">
                {status.toLowerCase()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-8">
        {campaignsQuery.isLoading ? (
          <div className="flex justify-center py-12">
            <Spinner className="h-6 w-6" innerSvgClass="stroke-primary" />
          </div>
        ) : campaignsQuery.data?.campaigns.length ? (
          campaignsQuery.data.campaigns.map((campaign) => (
            <CampaignCard key={campaign.id} campaign={campaign} />
          ))
        ) : (
          <div className="py-12 text-center text-muted-foreground">
            No campaigns found
            {search.search || search.status ? (
              <div className="mt-2 text-sm">
                Try adjusting your search or filters
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="flex justify-end gap-4">
        <Button
          size="sm"
          onClick={() => goToPage(search.page - 1)}
          disabled={search.page === 1}
        >
          Previous
        </Button>
        <Button
          size="sm"
          onClick={() => goToPage(search.page + 1)}
          disabled={search.page >= (campaignsQuery.data?.totalPage ?? 0)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
