import { queryOptions } from "@tanstack/react-query";

import {
  domains,
  getAvailableRegions,
  getDomain,
} from "~/server/functions/domain";

/**
 * Query keys and options for sending domains (#9).
 *
 * The domain detail page invalidates the whole area after verification and
 * after a settings change, because both can move a domain between the
 * "verifying" and "verified" buckets the list renders from. `domainKeys.all`
 * is the prefix of every key here so that keeps working.
 *
 * `regions` sits under the same prefix even though it is a property of the
 * installation rather than of any team. It changes only when an admin adds SES
 * credentials, so over-invalidating it costs one cheap query.
 */

export const domainKeys = {
  all: ["domain"] as const,
  regions: () => [...domainKeys.all, "regions"] as const,
  list: () => [...domainKeys.all, "list"] as const,
  details: () => [...domainKeys.all, "detail"] as const,
  detail: (id: number) => [...domainKeys.details(), id] as const,
};

export const domainQueries = {
  regions: () =>
    queryOptions({
      queryKey: domainKeys.regions(),
      queryFn: () => getAvailableRegions(),
    }),
  list: () =>
    queryOptions({
      queryKey: domainKeys.list(),
      queryFn: () => domains(),
    }),
  detail: (id: number) =>
    queryOptions({
      queryKey: domainKeys.detail(id),
      queryFn: () => getDomain({ data: { id } }),
    }),
};
