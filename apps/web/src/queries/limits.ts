import { queryOptions } from "@tanstack/react-query";

import type { LimitReason } from "~/lib/constants/plans";
import { get } from "~/server/functions/limits";

/**
 * Query keys and options for plan limits (#9).
 *
 * Keyed by reason, because each dialog asks about one resource and a stale
 * answer for a different one would let through the create it was meant to
 * block. Anything that creates a limited resource invalidates `limitKeys.all`.
 */

export const limitKeys = {
  all: ["limits"] as const,
  detail: (type: LimitReason) => [...limitKeys.all, type] as const,
};

export const limitQueries = {
  detail: (type: LimitReason) =>
    queryOptions({
      queryKey: limitKeys.detail(type),
      queryFn: () => get({ data: { type } }),
    }),
};
