import { fileURLToPath } from "node:url";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

import { workspaceAliases } from "./workspace-aliases";

/**
 * The dashboard, as a TanStack Start app on Cloudflare Workers (#9).
 *
 * `@cloudflare/vite-plugin` is what makes `vite dev` run the server half of
 * this app inside a real `workerd` isolate with the bindings from
 * `wrangler.jsonc` — the same runtime `wrangler dev` gives the public API, and
 * the reason there is no separate "now run it on Workers" step to remember. A
 * server function that reaches for `HYPERDRIVE`, `CACHE` or a queue producer
 * fails here exactly the way it would fail deployed.
 *
 * `server.entry` points at `src/server.ts`, which is also `main` in
 * `wrangler.jsonc`: one Worker, one bundle, carrying the Start handler, the
 * Hono public API, the queue consumer, the cron handler and the four Durable
 * Object classes. See `src/server.ts` for why they share an entry.
 */
export default defineConfig({
  resolve: { alias: workspaceAliases },
  plugins: [
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    // Before `tanstackStart()`, and `viteEnvironment.name` must be `ssr`:
    // that is what merges the Worker into Start's SSR environment instead of
    // building it as a second, separate one.
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart({
      server: { entry: "server.ts" },
    }),
    viteReact(),
  ],
  // The repo-root `.env`, which is what `pnpm dev`, `pnpm dx` and Next.js
  // already read. Vite's default is this package, which would have made a
  // second place to set `NEXT_PUBLIC_IS_CLOUD` and a second chance for the
  // browser and the Worker to disagree about it. `.dev.vars` is not a
  // candidate: `wrangler` reads it at runtime inside the Worker, and a value
  // that has to be inlined into a browser bundle is not a runtime value.
  envDir: fileURLToPath(new URL("../../", import.meta.url)),
  // Vite only inlines prefixed variables into the client bundle, which is the
  // property that keeps `DATABASE_URL` out of it even though the file it is
  // reading has one. `NEXT_PUBLIC_` is here while Next.js is still in the
  // tree; the env rename adds `PUBLIC_` and takes it away again.
  envPrefix: ["NEXT_PUBLIC_", "PUBLIC_"],
});
