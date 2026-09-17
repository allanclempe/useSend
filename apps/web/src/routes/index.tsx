import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { publicEnv } from "~/env.public";
import { runtimeFacts } from "~/server/functions/runtime";

/**
 * Placeholder for `/`, and the scaffold's proof of life (#9).
 *
 * `loader` runs during SSR, so the numbers below are in the first HTML
 * response; the button re-runs the same server function from the browser over
 * the `/_serverFn` transport. One page therefore exercises SSR, hydration, a
 * server function called both ways, the Hyperdrive binding and a real query
 * against Postgres.
 *
 * `app/page.tsx`'s redirect to `/login` / `/wait-list` / `/dashboard` replaces
 * this once the auth gate is ported.
 */
export const Route = createFileRoute("/")({
  component: RuntimeCheck,
  loader: () => runtimeFacts(),
});

function RuntimeCheck() {
  const ssr = Route.useLoaderData();
  const live = useQuery({
    queryKey: ["runtime-facts"],
    queryFn: () => runtimeFacts(),
    enabled: false,
  });

  const facts = live.data ?? ssr;

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 p-8">
      <h1 className="text-2xl font-semibold">useSend</h1>
      <p className="text-sm text-muted-foreground">
        TanStack Start is serving this page. The dashboard routes land here one
        area at a time; until then, Next.js still serves them.
      </p>
      <dl className="grid grid-cols-2 gap-2 rounded-lg border p-4 text-sm">
        <dt className="text-muted-foreground">Runtime</dt>
        <dd className="font-mono">{facts.runtime}</dd>
        <dt className="text-muted-foreground">Bindings</dt>
        <dd className="font-mono">{facts.bindings.join(", ") || "none"}</dd>
        <dt className="text-muted-foreground">Database</dt>
        <dd className="font-mono">{facts.database}</dd>
        <dt className="text-muted-foreground">Rendered at</dt>
        <dd className="font-mono">{facts.at}</dd>
        {/* Read in the component, not the loader, so it is the *client*
            bundle's copy of `~/env.public` being proved — the one Vite has to
            inline from `import.meta.env`. */}
        <dt className="text-muted-foreground">Deployment</dt>
        <dd className="font-mono">
          {publicEnv.NEXT_PUBLIC_IS_CLOUD ? "cloud" : "self-hosted"}
        </dd>
      </dl>
      <button
        type="button"
        className="self-start rounded-md border px-3 py-1.5 text-sm"
        onClick={() => void live.refetch()}
      >
        Call the server function again
      </button>
    </div>
  );
}
