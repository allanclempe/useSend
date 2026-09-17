import { QueryClient } from "@tanstack/react-query";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";

import { DefaultCatchBoundary } from "~/components/DefaultCatchBoundary";
import { NotFound } from "~/components/NotFound";
import { routeTree } from "./routeTree.gen";

/**
 * The router, built per request on the server and once in the browser.
 *
 * One `QueryClient` is created here rather than in a provider component
 * because the router owns it: `setupRouterSsrQueryIntegration` dehydrates it
 * into the SSR payload and rehydrates it on the client, so a query resolved
 * during the server render is not refetched on mount. That is the same job
 * `TRPCReactProvider` was doing with `useState(() => new QueryClient())`,
 * except it now also works for anything a route loader fetched.
 */
export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // The dashboard is a long-lived tab. Refetching everything because the
        // window regained focus is what made the old tRPC client chatty.
        refetchOnWindowFocus: false,
        staleTime: 30_000,
      },
    },
  });

  const router = createTanStackRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    // Staleness is Query's job, not the router's; leaving the router with its
    // own window means two caches disagreeing about the same data.
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: DefaultCatchBoundary,
    defaultNotFoundComponent: NotFound,
    scrollRestoration: true,
  });

  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
