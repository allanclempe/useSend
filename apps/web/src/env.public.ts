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
 * `import.meta.env.<prefix>*` and leaves `process.env` empty, so one client
 * component importing `~/env` reads `undefined` for everything. The fix is not
 * a shim — it is to stop importing server configuration into the browser,
 * which is what this module makes possible.
 *
 * **These values are baked in at build time, in both frameworks.** Vite
 * inlines `import.meta.env.NEXT_PUBLIC_*` exactly the way Next.js inlines
 * `process.env.NEXT_PUBLIC_*`; changing one on a deployed Worker without
 * rebuilding changes nothing in the browser. Nothing secret goes here, and
 * nothing here belongs in `.dev.vars` — that file is read by `wrangler` at
 * runtime, inside the Worker, where the browser cannot see it. The public
 * variables come from the repo-root `.env` (see `vite.config.ts`'s `envDir`),
 * which is the one file both bundlers read.
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

type PublicEnvSource = Record<string, string | undefined>;

/**
 * Takes each variable from the first source that actually carries it.
 *
 * **The question is "did this variable arrive", not "which runtime is this".**
 * This module used to ask the second one — `typeof process === "undefined" ?
 * import.meta.env : process.env` — on the belief that a Vite client bundle has
 * no `process`. It has one: TanStack Start injects a `process.env` shim into
 * the browser carrying its own `TSS_*` flags, so `typeof process` is
 * `"object"` there too. The browser therefore read an empty `process.env`,
 * fell through to the schema defaults, and concluded every installation was
 * self-hosted — while the Worker rendering that very page read the real value
 * and concluded the opposite. `NEXT_PUBLIC_*` could not reach the browser at
 * all, however it was configured (#9).
 *
 * An empty string counts as absent, matching `emptyStringAsUndefined` in
 * `~/env`: an unset variable in a `.env` file and a variable set to `""` mean
 * the same thing to everyone who writes one.
 *
 * Exported for `env.public.unit.test.ts`, which pins the browser case.
 */
export function pickPublicEnv(
  ...sources: PublicEnvSource[]
): PublicEnvSource {
  const picked: PublicEnvSource = {};

  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (picked[key] === undefined && value !== undefined && value !== "") {
        picked[key] = value;
      }
    }
  }

  return picked;
}

/**
 * What Vite baked in, or nothing at all under webpack.
 *
 * Written out one member expression per variable rather than spreading a
 * source object, because the inliner works on the literal text — Vite
 * substitutes `import.meta.env.NEXT_PUBLIC_IS_CLOUD` and cannot see through an
 * indirection, not even `import.meta.env` assigned to a local.
 *
 * `import.meta.env` is not a thing in a Next.js client bundle, where reading a
 * property off it throws. That is what the `catch` is for: webpack has already
 * inlined its half into `readProcessEnv` below, so there is nothing to lose.
 */
function readImportMetaEnv(): PublicEnvSource {
  try {
    return {
      NEXT_PUBLIC_IS_CLOUD: import.meta.env.NEXT_PUBLIC_IS_CLOUD,
      NEXT_PUBLIC_APP_VERSION: import.meta.env.NEXT_PUBLIC_APP_VERSION,
      NEXT_PUBLIC_GIT_SHA: import.meta.env.NEXT_PUBLIC_GIT_SHA,
    };
  } catch {
    return {};
  }
}

/**
 * What the runtime has: a Next.js client bundle (webpack inlines each literal),
 * Node, vitest, or a Worker under `nodejs_compat`.
 *
 * Same rule about literal text, for the same reason.
 */
function readProcessEnv(): PublicEnvSource {
  if (typeof process === "undefined" || !process.env) {
    return {};
  }

  return {
    NEXT_PUBLIC_IS_CLOUD: process.env.NEXT_PUBLIC_IS_CLOUD,
    NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION,
    NEXT_PUBLIC_GIT_SHA: process.env.NEXT_PUBLIC_GIT_SHA,
  };
}

/**
 * Baked before runtime, on purpose.
 *
 * Vite compiles the Worker and the browser bundle from one build, so taking
 * `import.meta.env` first is what makes it impossible for the server rendering
 * a page and the client hydrating it to disagree about which installation this
 * is. `process.env` is the fallback for the runtimes Vite never compiled —
 * Next.js, Node and vitest — where it is the only source there is.
 */
export const publicEnv = schema.parse(
  pickPublicEnv(readImportMetaEnv(), readProcessEnv()),
);
