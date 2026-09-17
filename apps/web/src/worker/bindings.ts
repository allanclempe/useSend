import type { KVNamespace, R2Bucket } from "@cloudflare/workers-types";

/**
 * The bindings declared in `apps/web/wrangler.jsonc`.
 *
 * Imported as types rather than pulled in globally with a `/// <reference />`:
 * `@cloudflare/workers-types` redeclares `Request`, `Response` and friends, and
 * `apps/web` is a Next.js app that wants the DOM versions of those.
 */
export type WorkerBindings = {
  /** Pooled Postgres. `connectionString` is only readable inside a handler. */
  HYPERDRIVE: { connectionString: string };
  /** Attachments and campaign assets — replaces the S3/MinIO client. */
  STORAGE: R2Bucket;
  /** Team and usage cache only. Never idempotency or rate limits (§1). */
  CACHE: KVNamespace;
};
