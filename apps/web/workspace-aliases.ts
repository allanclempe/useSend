import { fileURLToPath } from "node:url";

/**
 * Workspace packages that have to resolve to source rather than to `dist`.
 *
 * `usesend-js` is the published SDK, and its `main` points at a `dist/` that
 * only exists after `turbo build` has run it. Next.js got away with that
 * because the `build` task declares `dependsOn: ["^build"]`; a dev server and
 * a test run have no such ordering, which is why several integration tests
 * carry a `vi.mock("usesend-js")` whose comment says exactly this. Resolving
 * it to its entry file instead takes a build step out of both loops, and
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
