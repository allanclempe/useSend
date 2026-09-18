import { fileURLToPath } from "node:url";

/**
 * Workspace packages that have to resolve to source rather than to `dist`.
 *
 * `usesend-js` is the published SDK, and its `main` points at a `dist/` that
 * only exists after `pnpm --filter=usesend-js build` has run it. Back when the
 * app was Next.js, Turborepo's `dependsOn: ["^build"]` ordered that for the
 * build; a dev server and a test run never had such ordering, which is why
 * several integration tests carry a `vi.mock("usesend-js")` whose comment says
 * exactly this. Resolving it to its entry file instead takes a build step out
 * of every loop — and is why dropping Turborepo cost nothing here — and
 * matches how `@usesend/ui` is already consumed.
 *
 * Shared by `vite.config.ts` and `vitest.config.ts` so the two cannot disagree
 * about what a bare import means.
 */
export const workspaceAliases = {
  "usesend-js": fileURLToPath(
    new URL("../../packages/sdk/index.ts", import.meta.url),
  ),
};
