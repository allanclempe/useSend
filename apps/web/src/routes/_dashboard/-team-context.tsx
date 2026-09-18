import { useSuspenseQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";

import { teamQueries } from "~/queries/team";
import type { getTeams } from "~/server/functions/team";

/**
 * The team the dashboard is looking at.
 *
 * `useSuspenseQuery` rather than `useQuery`, because the layout route already
 * waited for this list in its loader — so by the time any of this renders the
 * data is in the cache and there is no loading state left to model. The tRPC
 * version returned `isLoading` from a context that every consumer then had to
 * branch on; none of them did anything useful with it.
 *
 * `teams[0]` is still the answer. A user belongs to one team in practice, and
 * `requireTeam` on the server makes the same assumption — if that ever changes
 * these two have to change together, because the server ignoring a team
 * selected here is how one team's data ends up on another team's screen.
 */
type Teams = Awaited<ReturnType<typeof getTeams>>;
type Team = Teams[number];

type TeamContextValue = {
  currentTeam: Team | null;
  teams: Teams;
  currentRole: "ADMIN" | "MEMBER";
  currentIsAdmin: boolean;
};

const TeamContext = createContext<TeamContextValue | undefined>(undefined);

export function TeamProvider({ children }: { children: React.ReactNode }) {
  const { data: teams } = useSuspenseQuery(teamQueries.list());

  const currentTeam = teams[0] ?? null;

  return (
    <TeamContext.Provider
      value={{
        currentTeam,
        teams,
        currentRole: currentTeam?.teamUsers[0]?.role ?? "MEMBER",
        currentIsAdmin: currentTeam?.teamUsers[0]?.role === "ADMIN",
      }}
    >
      {children}
    </TeamContext.Provider>
  );
}

export function useTeam() {
  const context = useContext(TeamContext);

  if (context === undefined) {
    throw new Error("useTeam must be used within a TeamProvider");
  }

  return context;
}
