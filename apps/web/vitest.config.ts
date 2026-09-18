import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

import { workspaceAliases } from "./workspace-aliases";

/**
 * `cloudflare:workers` is a runtime built-in with no Node resolution, so any
 * test that reaches a Durable Object class fails to load without this. The
 * shim declares the one export those classes use — see the file for what it
 * does and does not reproduce.
 */
const cloudflareWorkersShim = fileURLToPath(
  new URL("./src/test/setup/cloudflare-workers-shim.ts", import.meta.url),
);

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: { ...workspaceAliases, "cloudflare:workers": cloudflareWorkersShim },
  },
  test: {
    environment: "node",
    globals: true,
    setupFiles: [
      "./src/test/setup/setup-env.ts",
      "./src/test/setup/setup-tests.ts",
    ],
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/*.spec.{ts,tsx}",
        "src/test/**",
        "src/bench/**",
        "src/env.js",
      ],
    },
  },
});
