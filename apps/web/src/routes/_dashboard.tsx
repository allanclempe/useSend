import { useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Outlet,
  redirect,
  useLocation,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@usesend/ui/src/sidebar";
import { useIsMobile } from "@usesend/ui/src/hooks/use-mobile";

import { FullScreenLoading } from "~/components/FullScreenLoading";
import { publicEnv } from "~/env.public";
import { useSession } from "~/lib/auth-client";
import { adminQueries } from "~/queries/admin";
import { teamQueries } from "~/queries/team";
import { getSessionState } from "~/server/functions/session";
import { SesSettingsScreen } from "./_dashboard/admin/-ses-settings-form";
import { AppSidebar } from "./_dashboard/-app-sidebar";
import { CreateTeam } from "./_dashboard/-create-team";
import { TeamProvider } from "./_dashboard/-team-context";
import { UpgradeModal } from "./_dashboard/-upgrade-modal";

/**
 * Everything behind the sign-in gate (#9).
 *
 * A pathless layout route, so `/dashboard`, `/domains`, `/emails` and the rest
 * keep the URLs they have. It replaces three Next.js pieces at once:
 * `app/(dashboard)/layout.tsx`, `providers/auth.tsx` and
 * `app/(dashboard)/dasboard-layout.tsx`.
 *
 * **The gate is a redirect now, not a render.** `providers/auth.tsx` rendered
 * the login form in place at whatever URL the user had asked for, so an
 * unauthenticated visit to `/domains` showed a sign-in screen at `/domains`,
 * and signing in dropped you at `/dashboard` rather than where you were going.
 * `beforeLoad` runs on the server during SSR, so the redirect is a real HTTP
 * redirect on the first request — the URL and the state agree, and the browser
 * never downloads the dashboard to find out it cannot have it.
 */
export const Route = createFileRoute("/_dashboard")({
  beforeLoad: async ({ context }) => {
    const { signedIn, isWaitlisted } = await getSessionState();

    if (!signedIn) {
      throw redirect({ to: "/login" });
    }

    if (isWaitlisted) {
      throw redirect({ to: "/wait-list" });
    }

    // Warm the team list here rather than in every page: `TeamProvider` reads
    // it with `useSuspenseQuery`, and a loader that has already resolved it is
    // the difference between one request and one per navigation.
    await context.queryClient.ensureQueryData(teamQueries.list());
  },
  component: DashboardLayout,
});

function DashboardLayout() {
  const { data: session } = useSession();

  // Only ever asked when the answer could be yes: `instanceAdminMiddleware`
  // refuses everyone else, and a refusal on every page load is a retry loop
  // with a red console.
  const mayConfigureSes =
    !publicEnv.NEXT_PUBLIC_IS_CLOUD || Boolean(session?.user.isAdmin);

  const sesSettings = useQuery({
    ...adminQueries.sesSettings(),
    enabled: mayConfigureSes,
  });

  const teams = useQuery(teamQueries.list());

  if (teams.isPending || (mayConfigureSes && sesSettings.isPending)) {
    return <FullScreenLoading />;
  }

  if (mayConfigureSes && sesSettings.data?.length === 0) {
    return <SesSettingsScreen />;
  }

  if (!teams.data || teams.data.length === 0) {
    return <CreateTeam />;
  }

  return (
    <TeamProvider>
      <DashboardChrome />
    </TeamProvider>
  );
}

function DashboardChrome() {
  const isMobile = useIsMobile();
  const pathname = useLocation({ select: (location) => location.pathname });
  const mainRef = useRef<HTMLElement>(null);

  // Horizontal scroll is per-page state that the browser has no reason to
  // carry across a navigation; the tables in here are wide enough that it
  // does.
  useEffect(() => {
    if (mainRef.current) {
      mainRef.current.scrollLeft = 0;
    }

    window.scrollTo({ left: 0 });
    document.documentElement.scrollLeft = 0;
    document.body.scrollLeft = 0;
  }, [pathname]);

  return (
    <div className="h-full bg-sidebar-background">
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <main
            ref={mainRef}
            className="h-full flex-1 overflow-y-auto overflow-x-hidden p-4 xl:px-40"
          >
            {isMobile ? (
              <SidebarTrigger className="h-5 w-5 text-muted-foreground" />
            ) : null}
            <Outlet />
          </main>
        </SidebarInset>
      </SidebarProvider>
      <UpgradeModal />
    </div>
  );
}
