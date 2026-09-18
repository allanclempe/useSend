import { z } from "zod";

import type { CampaignListFilters } from "~/queries/campaign";
import { CampaignStatus } from "~/types/db";

/**
 * What `/campaigns`'s URL means.
 *
 * `page`, `status` and `search` keep the names `useUrlState` wrote, because
 * filtered lists get bookmarked. Every field `.catch`es: these values come
 * from a URL bar, and a stale `?status=` should show the unfiltered list rather
 * than an error boundary where the cards were.
 */
export const campaignSearchSchema = z.object({
  page: z.coerce.number().int().positive().catch(1),
  status: z.nativeEnum(CampaignStatus).optional().catch(undefined),
  search: z.string().optional().catch(undefined),
});

export type CampaignSearch = z.infer<typeof campaignSearchSchema>;

/**
 * The list query's filters, derived in one place because the route loader and
 * the list component both key the cache with it.
 */
export function campaignListFilters(
  search: CampaignSearch,
): CampaignListFilters {
  return {
    page: search.page,
    status: search.status,
    search: search.search,
  };
}

/** The statuses the dropdown offers, in the order a campaign moves through. */
export const FILTERABLE_STATUSES: Array<CampaignStatus> = [
  CampaignStatus.DRAFT,
  CampaignStatus.SCHEDULED,
  CampaignStatus.RUNNING,
  CampaignStatus.PAUSED,
  CampaignStatus.SENT,
];
