/// <reference types="vite/client" />
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { ThemeProvider } from "@usesend/ui";
import { Toaster } from "@usesend/ui/src/toaster";

import { DefaultCatchBoundary } from "~/components/DefaultCatchBoundary";
import { NotFound } from "~/components/NotFound";
import appCss from "~/styles.css?url";

/**
 * The document.
 *
 * This is `app/layout.tsx` with the Next-specific pieces replaced: `metadata`
 * becomes `head()`, `next/font`'s injected CSS variables become a stylesheet
 * link, and `TRPCReactProvider` is gone — the `QueryClient` now belongs to the
 * router (see `src/router.tsx`) so that anything a loader fetched during SSR
 * arrives hydrated instead of being fetched again on mount.
 *
 * `ThemeProvider` and `Toaster` keep their place above everything, because
 * both are read by components at every depth.
 */
export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "useSend" },
      { name: "description", content: "Open source email platform" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico" },
    ],
  }),
  errorComponent: DefaultCatchBoundary,
  notFoundComponent: () => <NotFound />,
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className="bg-sidebar-background">
      <head>
        <HeadContent />
      </head>
      <body className="app bg-sidebar-background font-sans">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <Toaster />
          {children}
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  );
}
