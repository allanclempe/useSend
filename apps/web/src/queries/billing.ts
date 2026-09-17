import { queryOptions } from "@tanstack/react-query";

import {
  getSubscriptionDetails,
  getThisMonthUsage,
} from "~/server/functions/billing";

/**
 * Query keys and options for billing (#9).
 *
 * The two Stripe redirects are mutations and are called directly; only the
 * two reads are here. Both are team-scoped without taking a team id — the
 * server takes it from the session — so a team switch has to invalidate
 * `billingKeys.all` rather than a narrower key.
 */

export const billingKeys = {
  all: ["billing"] as const,
  usage: () => [...billingKeys.all, "usage"] as const,
  subscription: () => [...billingKeys.all, "subscription"] as const,
};

export const billingQueries = {
  usage: () =>
    queryOptions({
      queryKey: billingKeys.usage(),
      queryFn: () => getThisMonthUsage(),
    }),
  subscription: () =>
    queryOptions({
      queryKey: billingKeys.subscription(),
      queryFn: () => getSubscriptionDetails(),
    }),
};
