import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * The CPU benchmark (`src/bench/*.bench.ts`), run with `pnpm bench:cpu`.
 *
 * Deliberately does not extend `vitest.config.ts`: its `clearMocks` /
 * `restoreMocks` / `mockReset` and the `afterEach` in `setup-tests.ts` run
 * around every test, and none of that should sit between `process.cpuUsage()`
 * and the code being measured. A single fork with no parallelism keeps the
 * process quiet, because `process.cpuUsage()` is process-wide and would
 * otherwise pick up another worker's work.
 *
 * `setup-env.ts` is the one shared setup file this does need. It seeds
 * `process.env` once at load and installs no hooks, so it stays out of the
 * measured window — but without it `~/env` fails validation, and
 * `server/crypto.ts` imports it (issue #48), so the benchmark cannot even
 * collect.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    globals: true,
    include: ["src/bench/**/*.bench.ts"],
    setupFiles: ["./src/test/setup/setup-env.ts"],
    fileParallelism: false,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
