import { queryOptions } from "@tanstack/react-query";

import {
  getCampaign,
  getCampaigns,
  latestEmails,
} from "~/server/functions/campaign";
import type { CampaignStatus } from "~/types/db";

/**
 * Query keys and options for campaigns (#9).
 *
 * The key hierarchy is two levels deep on purpose. The dashboard invalidates
 * `getCampaign` both with a campaign id (after scheduling one) and without
 * (after pausing, from a list row that does not know which detail views are
 * open), so `details()` has to be a usable prefix of `detail(id)` — collapsing
 * them into a single key would silently drop the second case.
 */

export type CampaignListFilters = {
  page?: number;
  status?: CampaignStatus | null;
  search?: string | null;
};

export const campaignKeys = {
  all: ["campaign"] as const,
  lists: () => [...campaignKeys.all, "list"] as const,
  list: (filters: CampaignListFilters) =>
    [...campaignKeys.lists(), filters] as const,
  details: () => [...campaignKeys.all, "detail"] as const,
  detail: (campaignId: string) =>
    [...campaignKeys.details(), campaignId] as const,
  latestEmails: (campaignId: string) =>
    [...campaignKeys.all, "latestEmails", campaignId] as const,
};

export const campaignQueries = {
  list: (filters: CampaignListFilters = {}) =>
    queryOptions({
      queryKey: campaignKeys.list(filters),
      queryFn: () => getCampaigns({ data: filters }),
    }),
  detail: (campaignId: string) =>
    queryOptions({
      queryKey: campaignKeys.detail(campaignId),
      queryFn: () => getCampaign({ data: { campaignId } }),
    }),
  latestEmails: (campaignId: string) =>
    queryOptions({
      queryKey: campaignKeys.latestEmails(campaignId),
      queryFn: () => latestEmails({ data: { campaignId } }),
    }),
};
