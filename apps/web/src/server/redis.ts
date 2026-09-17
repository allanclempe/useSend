import IORedis from "ioredis";
import { env } from "~/env";

/**
 * Redis, under Node only.
 *
 * **Nothing outside a driver may import this module.** The connection below is
 * cached in module scope, and Workers ties an I/O object to the request that
 * opened it — so inside a Worker isolate this object serves exactly one
 * invocation and then hangs every one after it, with no error. That is not a
 * bug to be fixed here; it is why the seams exist. Reach Redis through
 * `server/cache`, `server/rate-limit`, `server/idempotency` or
 * `server/queue/bullmq-driver`, each of which the runtime swaps for a
 * Cloudflare primitive.
 *
 * Phase 10 (#12) deletes this file along with `ioredis` and `bullmq`.
 */
export let connection: IORedis | null = null;

/**
 * Key prefix derived from REDIS_KEY_PREFIX env var.
 * When set (e.g. "usesend"), all cache keys become "usesend:team:1", etc.
 * When empty, keys are unprefixed (backwards compatible).
 */
export const REDIS_PREFIX = env.REDIS_KEY_PREFIX
  ? `${env.REDIS_KEY_PREFIX}:`
  : "";

/**
 * BullMQ prefix (no trailing colon — BullMQ adds its own separator).
 * When REDIS_KEY_PREFIX is empty, falls back to BullMQ's default "bull".
 */
export const BULL_PREFIX = env.REDIS_KEY_PREFIX || "bull";

/** Prefix a cache key with REDIS_KEY_PREFIX. */
export function redisKey(key: string): string {
  return `${REDIS_PREFIX}${key}`;
}

export const getRedis = () => {
  if (!connection || connection.status === "end") {
    connection = new IORedis(`${env.REDIS_URL}?family=0`, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }
  return connection;
};
