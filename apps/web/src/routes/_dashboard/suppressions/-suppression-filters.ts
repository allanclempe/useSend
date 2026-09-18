import { z } from "zod";

import type { SuppressionListFilters } from "~/queries/suppression";
import { SuppressionReason } from "~/types/db";

/**
 * What the suppression page's URL means (#9).
 *
 * `search`, `reason` and `page` keep the names `useUrlState` gave them —
 * filtered lists get bookmarked and shared, and a rename here would quietly
 * drop the filter rather than fail. `page` was a string in the URL and parsed
 * with `parseInt` at four call sites; it is coerced once, here.
 *
 * Every field `.catch`es, so a hand-edited or stale URL falls back to the
 * default instead of throwing: a bad `?reason=` should show the unfiltered
 * list, not an error boundary where the table was.
 *
 * The loader and the component both build the query's filters from
 * `listFilters`, because the filters object *is* the react-query key — two
 * places constructing it differently is a loader that warms a cache entry the
 * page never reads.
 */
export const suppressionSearchSchema = z.object({
  search: z.string().optional().catch(undefined),
  reason: z.nativeEnum(SuppressionReason).optional().catch(undefined),
  page: z.coerce.number().int().min(1).default(1).catch(1),
});

export type SuppressionSearch = z.infer<typeof suppressionSearchSchema>;

/** One screenful. Never came from the URL, and still does not. */
export const SUPPRESSION_PAGE_SIZE = 20;

export function listFilters(search: SuppressionSearch): SuppressionListFilters {
  return {
    page: search.page,
    limit: SUPPRESSION_PAGE_SIZE,
    search: search.search || undefined,
    reason: search.reason,
    sortBy: "createdAt",
    sortOrder: "desc",
  };
}
