import { queryOptions } from "@tanstack/react-query";

import {
  emailTimeSeries,
  reputationMetricsData,
} from "~/server/functions/dashboard";

/**
 * Query keys and options for the dashboard charts (#9).
 *
 * Both take an optional domain filter, and it is part of the key: switching
 * the filter is a different question, not a stale answer to the same one.
 */

export const dashboardKeys = {
  all: ["dashboard"] as const,
  timeSeries: (days?: number, domain?: number) =>
    [...dashboardKeys.all, "timeSeries", { days, domain }] as const,
  reputation: (domain?: number) =>
    [...dashboardKeys.all, "reputation", { domain }] as const,
};

export const dashboardQueries = {
  timeSeries: (days?: number, domain?: number) =>
    queryOptions({
      queryKey: dashboardKeys.timeSeries(days, domain),
      queryFn: () => emailTimeSeries({ data: { days, domain } }),
    }),
  reputation: (domain?: number) =>
    queryOptions({
      queryKey: dashboardKeys.reputation(domain),
      queryFn: () => reputationMetricsData({ data: { domain } }),
    }),
};
