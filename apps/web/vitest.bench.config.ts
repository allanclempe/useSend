import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * The CPU benchmark (`src/bench/*.bench.ts`), run with `pnpm bench:cpu`.
 *
 * Deliberately does not extend `vitest.config.ts`: the shared setup files stub
 * env and reset mocks around every test, and none of that should sit between
 * `process.cpuUsage()` and the code being measured. A single fork with no
 * parallelism keeps the process quiet, because `process.cpuUsage()` is
 * process-wide and would otherwise pick up another worker's work.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    globals: true,
    include: ["src/bench/**/*.bench.ts"],
    fileParallelism: false,
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
