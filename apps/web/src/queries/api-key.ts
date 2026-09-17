import { queryOptions } from "@tanstack/react-query";

import { getApiKeys } from "~/server/functions/api-key";

/**
 * Query keys and options for API keys (#9).
 *
 * `apiKeyKeys.all` is the prefix of every other key in this module, which is
 * what makes a single `invalidateQueries({ queryKey: apiKeyKeys.all })` do
 * what `api.useUtils().apiKey.invalidate()` did — and that is the only
 * invalidation the settings page ever performs.
 */

export const apiKeyKeys = {
  all: ["apiKey"] as const,
  list: () => [...apiKeyKeys.all, "list"] as const,
};

export const apiKeyQueries = {
  list: () =>
    queryOptions({
      queryKey: apiKeyKeys.list(),
      queryFn: () => getApiKeys(),
    }),
};
