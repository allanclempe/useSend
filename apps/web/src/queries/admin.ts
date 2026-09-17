import { queryOptions } from "@tanstack/react-query";

import { getSesSettings } from "~/server/functions/admin";

export const adminKeys = {
  all: ["admin"] as const,
  sesSettings: () => [...adminKeys.all, "ses-settings"] as const,
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
};
