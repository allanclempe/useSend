import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Reads `apps/web/wrangler.jsonc` so tests can assert that the Worker's
 * deploy-time configuration matches the code that depends on it.
 *
 * JSONC by hand rather than a parser dependency. A regex would be wrong —
 * `localConnectionString` contains `postgresql://`, which a naive `//` strip
 * eats — so this walks the string and only treats `//` and `/*` as comments
 * outside of string literals.
 */
export function parseJsonc(source: string): unknown {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;

    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
      continue;
    }

    if (char === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/"))
        i++;
      i++;
      continue;
    }

    out += char;
  }

  // Trailing commas are legal in JSONC and not in JSON.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export type WranglerConfig = {
  triggers?: { crons?: string[] };
  queues?: {
    producers?: Array<{ queue: string; binding: string }>;
    consumers?: Array<{
      queue: string;
      max_batch_size?: number;
      max_batch_timeout?: number;
      max_retries?: number;
      max_concurrency?: number;
      dead_letter_queue?: string;
    }>;
  };
};

export function readWranglerConfig(): WranglerConfig {
  return parseJsonc(
    readFileSync(
      fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)),
      "utf8",
    ),
  ) as WranglerConfig;
}
