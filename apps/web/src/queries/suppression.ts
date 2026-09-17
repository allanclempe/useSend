import { queryOptions } from "@tanstack/react-query";

import {
  checkMultipleSuppressions,
  checkSuppression,
  exportSuppressions,
  getSuppressions,
  getSuppressionStats,
} from "~/server/functions/suppression";
import type { SuppressionReason } from "~/types/db";

/**
 * Query keys and options for the suppression list (#9).
 *
 * Every write in this area invalidates the list *and* the stats together, and
 * they are separate keys rather than one combined query because the stats sit
 * above the table and the table is paginated — sharing a key would refetch
 * every page of a 10,000-row list to update four counters.
 */

export type SuppressionListFilters = {
  page?: number;
  limit?: number;
  search?: string;
  reason?: SuppressionReason | null;
  sortBy?: "email" | "reason" | "createdAt";
  sortOrder?: "asc" | "desc";
};

export type SuppressionExportFilters = {
  search?: string;
  reason?: SuppressionReason | null;
};

export const suppressionKeys = {
  all: ["suppression"] as const,
  lists: () => [...suppressionKeys.all, "list"] as const,
  list: (filters: SuppressionListFilters) =>
    [...suppressionKeys.lists(), filters] as const,
  stats: () => [...suppressionKeys.all, "stats"] as const,
  exports: () => [...suppressionKeys.all, "export"] as const,
  exportList: (filters: SuppressionExportFilters) =>
    [...suppressionKeys.exports(), filters] as const,
  checks: () => [...suppressionKeys.all, "check"] as const,
  check: (email: string) => [...suppressionKeys.checks(), email] as const,
  checkMany: (emails: Array<string>) =>
    [...suppressionKeys.checks(), "many", emails] as const,
};

export const suppressionQueries = {
  list: (filters: SuppressionListFilters = {}) =>
    queryOptions({
      queryKey: suppressionKeys.list(filters),
      queryFn: () => getSuppressions({ data: filters }),
    }),
  stats: () =>
    queryOptions({
      queryKey: suppressionKeys.stats(),
      queryFn: () => getSuppressionStats(),
    }),
  exportList: (filters: SuppressionExportFilters = {}) =>
    queryOptions({
      queryKey: suppressionKeys.exportList(filters),
      queryFn: () => exportSuppressions({ data: filters }),
    }),
  check: (email: string) =>
    queryOptions({
      queryKey: suppressionKeys.check(email),
      queryFn: () => checkSuppression({ data: { email } }),
    }),
  checkMany: (emails: Array<string>) =>
    queryOptions({
      queryKey: suppressionKeys.checkMany(emails),
      queryFn: () => checkMultipleSuppressions({ data: { emails } }),
    }),
};
