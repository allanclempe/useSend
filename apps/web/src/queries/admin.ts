import { queryOptions } from "@tanstack/react-query";

import {
  getDefaultSesRegion,
  getEmailAnalytics,
  getQuotaForRegion,
  getSesSettings,
  getSetting,
} from "~/server/functions/admin";

/**
 * Query keys and options for the admin area (#9).
 *
 * Only the reads are here. The two lookups — `findTeam` and `findUserByEmail` —
 * and everything that writes are called directly through `useMutation`; a
 * lookup that answers about one team or one person at a time has nothing to
 * cache and nothing to invalidate.
 *
 * `adminKeys.all` is the prefix of every key, which is what
 * `utils.admin.invalidate()` used to be: adding or editing an SES region
 * invalidates the whole area, because the region list feeds the add-domain
 * dialog as well as the table it was edited in.
 */

export type EmailAnalyticsFilters = {
  timeframe: "today" | "thisMonth";
  paidOnly: boolean;
};

export const adminKeys = {
  all: ["admin"] as const,
  sesSettings: () => [...adminKeys.all, "ses-settings"] as const,
  defaultSesRegion: () => [...adminKeys.all, "default-ses-region"] as const,
  sesSetting: (region?: string | null) =>
    [...adminKeys.all, "ses-setting", region ?? null] as const,
  quotas: () => [...adminKeys.all, "quota"] as const,
  quota: (region: string) => [...adminKeys.quotas(), region] as const,
  emailAnalytics: (filters: EmailAnalyticsFilters) =>
    [...adminKeys.all, "email-analytics", filters] as const,
};

export const adminQueries = {
  /**
   * `enabled` is the caller's business, not this factory's: the dashboard only
   * asks when the signed-in user could possibly be allowed an answer, because
   * `instanceAdminMiddleware` refuses everyone else and a refusal on every
   * page load is a retry loop with a red console.
   */
  sesSettings: () =>
    queryOptions({
      queryKey: adminKeys.sesSettings(),
      queryFn: () => getSesSettings(),
    }),

  defaultSesRegion: () =>
    queryOptions({
      queryKey: adminKeys.defaultSesRegion(),
      queryFn: () => getDefaultSesRegion(),
    }),

  sesSetting: (region?: string | null) =>
    queryOptions({
      queryKey: adminKeys.sesSetting(region),
      queryFn: () => getSetting({ data: { region } }),
    }),

  /**
   * Asked imperatively, with `queryClient.fetchQuery`, when the region field
   * loses focus — the same shape `utils.admin.getQuotaForRegion.fetch()` had.
   * It is a factory rather than a bare call so the answer lands under a key
   * the next region change can reuse instead of paying SES twice.
   */
  quota: (region: string) =>
    queryOptions({
      queryKey: adminKeys.quota(region),
      queryFn: () => getQuotaForRegion({ data: { region } }),
    }),

  emailAnalytics: (filters: EmailAnalyticsFilters) =>
    queryOptions({
      queryKey: adminKeys.emailAnalytics(filters),
      queryFn: () => getEmailAnalytics({ data: filters }),
    }),
};
