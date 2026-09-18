import { AsyncLocalStorage } from "node:async_hooks";
import type {
  KVNamespace,
  Queue as CfQueue,
  R2Bucket,
} from "@cloudflare/workers-types";

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
  /** Campaign and template images — replaces the S3/MinIO client. */
  STORAGE: R2Bucket;
  /** Team and usage cache only. Never idempotency or rate limits (§1). */
  CACHE: KVNamespace;
} & {
  /**
   * Queue producers, one per entry in `server/queue/queue-registry.ts`.
   *
   * An index signature rather than a name per queue because the set is data:
   * §4.1 pre-declares a queue pair per supported SES region, so the names are
   * derived from a list, not written out. `getQueueBinding` is the only thing
   * that should index this, and it validates what it finds.
   */
  readonly [binding: string]: unknown;
};

/** The producer half of a queue binding, narrowed to what the driver uses. */
export type QueueProducer = CfQueue<unknown>;

/**
 * Bindings are only readable inside a request handler, so they cannot live in a
 * module-level `const` the way an environment variable can. The Worker entry
 * point publishes them here for the duration of each request; `AsyncLocalStorage`
 * is the same mechanism `withLogger` and the Drizzle client already use.
 *
 * Returns `undefined` outside a handler — which is how `isStorageConfigured()`
 * reports that image upload is unavailable — unless a test has set the ambient
 * bindings below.
 */
const scope = new AsyncLocalStorage<WorkerBindings>();

export function withWorkerBindings<T>(bindings: WorkerBindings, fn: () => T): T {
  return scope.run(bindings, fn);
}

/**
 * Bindings for code that is not inside a request, which is only ever a test.
 *
 * The integration suite runs under Node and drives services directly, so there
 * is no handler to open a scope — but the drivers below the seams are the
 * Worker ones now that the Redis half is gone (#12), and they need something to
 * reach for. `src/test/integration/bindings.ts` sets this once per run and
 * explains what it puts there. The Worker never calls it.
 *
 * Same shape as the Drizzle client in `server/drizzle/index.ts`: a request
 * scope first, a process-wide fallback second.
 */
let ambient: WorkerBindings | undefined;

export function setAmbientWorkerBindings(bindings: WorkerBindings | undefined) {
  ambient = bindings;
}

export function getWorkerBindings(): WorkerBindings | undefined {
  return scope.getStore() ?? ambient;
}
