import { fileURLToPath } from "node:url";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

import { workspaceAliases } from "./workspace-aliases";

/**
 * Points every `@aws-sdk/client-*` at its browser runtime config.
 *
 * Each client chooses between a Node and a browser runtime config through the
 * legacy `browser` *field* — a relative mapping, `./dist-es/runtimeConfig` to
 * `./dist-es/runtimeConfig.browser`, that only a bundler targeting the web
 * applies. The Worker environment is not that: `@cloudflare/vite-plugin` runs
 * it as SSR, so the field is ignored and the Node config wins. The clients'
 * shared dependency `@aws-sdk/core/client` is chosen by export *condition*
 * instead, and `browser` is among this environment's conditions, so that half
 * does resolve to the browser build — where `emitWarningIfUnsupportedVersion`
 * is a `Symbol.for("node-only")` placeholder rather than a function.
 *
 * The Node runtime config calls it at construction, so `new SESv2Client()` and
 * `new SNSClient()` threw `emitWarningIfUnsupportedVersion is not a function`
 * before issuing a single request — every SES and SNS call in the app (#126).
 * Nothing caught it: the tests mock `~/server/aws/ses` wholesale, and the local
 * simulator had been unreachable since the dev port moved, so no AWS client had
 * ever been constructed under `vite dev`.
 *
 * The browser runtime config is the right one for a Worker anyway. It uses the
 * fetch handler rather than `node:http`, and skips the filesystem credential
 * chain, which cannot work here — `server/aws/credentials.ts` passes the
 * credentials in explicitly.
 */
function awsSdkBrowserRuntimeConfig(): Plugin {
  return {
    name: "usesend:aws-sdk-browser-runtime-config",
    enforce: "pre",
    async resolveId(source, importer) {
      if (source !== "./runtimeConfig" || !importer) {
        return null;
      }

      if (!/@aws-sdk[\\/]client-[^\\/]+[\\/]/.test(importer)) {
        return null;
      }

      return this.resolve("./runtimeConfig.browser", importer, {
        skipSelf: true,
      });
    },
  };
}

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
    awsSdkBrowserRuntimeConfig(),
  ],
  environments: {
    ssr: {
      // Keeps the AWS SDK out of dependency pre-bundling, so that
      // `awsSdkBrowserRuntimeConfig` above is what resolves `./runtimeConfig`.
      // esbuild resolves a package's own relative imports itself and does not
      // consult Vite's plugins, so a pre-bundled client would already have the
      // Node runtime config baked in before the plugin was asked.
      optimizeDeps: {
        exclude: [
          "@aws-sdk/client-sesv2",
          "@aws-sdk/client-sns",
          "@aws-sdk/client-sts",
        ],
      },
    },
  },
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
