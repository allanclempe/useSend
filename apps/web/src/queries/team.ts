import { queryOptions } from "@tanstack/react-query";

import { getTeamInvites, getTeams, getTeamUsers } from "~/server/functions/team";

/**
 * Query keys and options for the team area (#9).
 *
 * The shape every ported area follows. tRPC generated three things per
 * procedure — a key, a fetcher and `useUtils().<router>.<proc>.invalidate()` —
 * and this is the hand-written equivalent:
 *
 * - `teamKeys.all` is the prefix, so `invalidateQueries({ queryKey:
 *   teamKeys.all })` is what `utils.team.invalidate()` was.
 * - each factory returns `queryOptions(...)`, so a component writes
 *   `useQuery(teamQueries.list())` and a route loader writes
 *   `queryClient.ensureQueryData(teamQueries.list())` against the same key.
 *
 * Keeping the keys in one module per area rather than inline at the call sites
 * is the whole reason invalidation stays correct: there were 49
 * `api.useUtils()` invalidations to port, and a key typed at the call site is a
 * key that will eventually disagree with the one that wrote the cache entry.
 */
export const teamKeys = {
  all: ["team"] as const,
  list: () => [...teamKeys.all, "list"] as const,
  users: () => [...teamKeys.all, "users"] as const,
  invites: () => [...teamKeys.all, "invites"] as const,
};

export const teamQueries = {
  list: () =>
    queryOptions({
      queryKey: teamKeys.list(),
      queryFn: () => getTeams(),
    }),

  users: () =>
    queryOptions({
      queryKey: teamKeys.users(),
      queryFn: () => getTeamUsers(),
    }),

  invites: () =>
    queryOptions({
      queryKey: teamKeys.invites(),
      queryFn: () => getTeamInvites(),
    }),
};
