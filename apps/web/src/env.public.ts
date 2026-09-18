import { z } from "zod";

/**
 * The environment variables that are allowed to reach a browser.
 *
 * Separate from `~/env` because the two are read by different runtimes in
 * different ways, and conflating them is a build error waiting to happen.
 *
 * `~/env`'s `runtimeEnv` is an object literal that touches `process.env` once
 * per declared variable, evaluated at module load. Next.js got away with
 * shipping that to the browser because webpack rewrites *every*
 * `process.env.X` in a client bundle to a literal. Vite does not: it rewrites
 * `import.meta.env.<prefix>*` and leaves `process` undefined, so one client
 * component importing `~/env` is a `ReferenceError` on the first paint. The
 * fix is not a shim — it is to stop importing server configuration into the
 * browser, which is what this module makes possible.
 *
 * **These values are baked in at build time, in both frameworks.** Vite
 * inlines `import.meta.env.NEXT_PUBLIC_*` exactly the way Next.js inlines
 * `process.env.NEXT_PUBLIC_*`; changing one on a deployed Worker without
 * rebuilding changes nothing in the browser. Nothing secret goes here.
 *
 * The `NEXT_PUBLIC_` prefix outlives its framework for one more stack: Next.js
 * only inlines variables carrying it, so renaming while both frameworks are in
 * the tree would break the half still running. It goes when `src/app` does.
 */
const schema = z.object({
  NEXT_PUBLIC_IS_CLOUD: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  NEXT_PUBLIC_APP_VERSION: z.string().optional(),
  NEXT_PUBLIC_GIT_SHA: z.string().optional(),
});

/**
 * Reads one variable from whichever of the two build systems is compiling
 * this file.
 *
 * Written out per variable rather than spreading a source object, because
 * both inliners work on the literal text: webpack substitutes
 * `process.env.NEXT_PUBLIC_IS_CLOUD`, Vite substitutes
 * `import.meta.env.NEXT_PUBLIC_IS_CLOUD`, and neither can see through an
 * indirection. `typeof process` picks the branch — it is `"object"` under
 * Node, under `nodejs_compat` on Workers, and in a Next.js client bundle
 * (webpack shims it), and `"undefined"` in a Vite client bundle.
 */
const raw = {
  NEXT_PUBLIC_IS_CLOUD:
    typeof process === "undefined"
      ? import.meta.env.NEXT_PUBLIC_IS_CLOUD
      : process.env.NEXT_PUBLIC_IS_CLOUD,
  NEXT_PUBLIC_APP_VERSION:
    typeof process === "undefined"
      ? import.meta.env.NEXT_PUBLIC_APP_VERSION
      : process.env.NEXT_PUBLIC_APP_VERSION,
  NEXT_PUBLIC_GIT_SHA:
    typeof process === "undefined"
      ? import.meta.env.NEXT_PUBLIC_GIT_SHA
      : process.env.NEXT_PUBLIC_GIT_SHA,
};

/**
 * Empty strings are `undefined`, matching `emptyStringAsUndefined` in `~/env`:
 * an unset variable in a `.env` file and a variable set to `""` mean the same
 * thing to everyone who writes one.
 */
export const publicEnv = schema.parse(
  Object.fromEntries(
    Object.entries(raw).filter(([, value]) => value !== undefined && value !== ""),
  ),
);
