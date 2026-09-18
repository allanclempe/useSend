import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { pickPublicEnv } from "~/env.public";

/**
 * The regression this file exists for (#9).
 *
 * `env.public.ts` used to choose its source by asking which runtime it was in —
 * `typeof process === "undefined" ? import.meta.env : process.env` — on the
 * belief that a Vite client bundle has no `process`. TanStack Start injects a
 * `process.env` shim into the browser for its own `TSS_*` flags, so that test
 * said "Node" in the browser, the browser read an empty `process.env`, and
 * `NEXT_PUBLIC_IS_CLOUD` was `false` there no matter how the installation was
 * configured. The Worker rendering the same page read the real value, so a
 * cloud dashboard hydrated into the self-hosted branch of its own layout: a
 * hydration mismatch, a `getSesSettings` call the server refuses, and seconds
 * of full-screen loading on every page load.
 *
 * `THE_BROWSER_SHIM` is the real thing, copied out of a `vite dev` page.
 */
const THE_BROWSER_SHIM = {
  TSS_DEV_SERVER: "true",
  TSS_SERVER_FN_BASE: "/_serverFn/",
  TSS_SHELL: "false",
};

describe("pickPublicEnv", () => {
  it("reads the bundler's value in a browser whose process.env is a shim", () => {
    const picked = pickPublicEnv(
      { NEXT_PUBLIC_IS_CLOUD: "true" },
      THE_BROWSER_SHIM,
    );

    expect(picked.NEXT_PUBLIC_IS_CLOUD).toBe("true");
  });

  it("falls back to process.env where there is no bundler value", () => {
    const picked = pickPublicEnv({}, { NEXT_PUBLIC_IS_CLOUD: "true" });

    expect(picked.NEXT_PUBLIC_IS_CLOUD).toBe("true");
  });

  it("prefers the baked value, so a server and its browser cannot disagree", () => {
    const picked = pickPublicEnv(
      { NEXT_PUBLIC_IS_CLOUD: "true" },
      { NEXT_PUBLIC_IS_CLOUD: "false" },
    );

    expect(picked.NEXT_PUBLIC_IS_CLOUD).toBe("true");
  });

  it("treats an empty string as unset, like `~/env` does", () => {
    const picked = pickPublicEnv(
      { NEXT_PUBLIC_IS_CLOUD: "" },
      { NEXT_PUBLIC_IS_CLOUD: "true" },
    );

    expect(picked.NEXT_PUBLIC_IS_CLOUD).toBe("true");
  });

  it("leaves a variable no source carries absent, for the schema to default", () => {
    const picked = pickPublicEnv({}, THE_BROWSER_SHIM);

    expect("NEXT_PUBLIC_IS_CLOUD" in picked).toBe(false);
  });
});

/**
 * The other half of it, and the reason nobody could reproduce cloud mode
 * locally: `.dev.vars.example` offered `NEXT_PUBLIC_IS_CLOUD`, so that is where
 * it got set. `wrangler` reads that file at runtime inside the Worker, and no
 * bundler reads it at all — so the server half went to cloud mode and the
 * browser half stayed on the default. Same rule as `queue-registry` and
 * `binding-registry`: the test fails when two configuration files disagree
 * about who owns a value.
 */
describe(".dev.vars.example", () => {
  it("does not offer a variable that has to be inlined into the browser", () => {
    const devVarsExample = readFileSync(
      fileURLToPath(new URL("../.dev.vars.example", import.meta.url)),
      "utf8",
    );

    const declared = devVarsExample
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .map((line) => line.split("=")[0]?.trim())
      .filter((key): key is string => Boolean(key));

    expect(
      declared.filter(
        (key) => key.startsWith("NEXT_PUBLIC_") || key.startsWith("PUBLIC_"),
      ),
    ).toEqual([]);
  });
});
