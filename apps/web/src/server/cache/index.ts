import { isWorkersRuntime } from "../runtime";
import { kvCacheStore } from "./kv-driver";
import { redisCacheStore } from "./redis-driver";
import type { CacheStore } from "./types";

export * from "./types";

/**
 * The active cache backend, picked the same way and for the same reason as the
 * queue driver in `server/queue/index.ts`: Workers KV inside a Worker isolate,
 * Redis under Node, and nothing above this line knows which.
 *
 * Phase 10 (#12) deletes the Redis half.
 */
const store: CacheStore = isWorkersRuntime() ? kvCacheStore : redisCacheStore;

export function cacheStore(): CacheStore {
  return store;
}

export function cacheGet(key: string): Promise<string | null> {
  return store.get(key);
}

export function cachePut(
  key: string,
  value: string,
  options?: { ttlSeconds?: number },
): Promise<void> {
  return store.put(key, value, options);
}

export function cacheAdd(
  key: string,
  value: string,
  options: { ttlSeconds: number },
): Promise<boolean> {
  return store.add(key, value, options);
}

export function cacheDelete(...keys: string[]): Promise<void> {
  return store.delete(...keys);
}

/**
 * Read-through JSON cache. Stores `fetcher`'s result under `key` for
 * `ttlSeconds` and returns the cached copy next time.
 *
 * Moved here from `server/redis.ts` unchanged in shape, including its two
 * swallowed failure modes: unparseable JSON falls through to a refresh, and a
 * write that fails is ignored. A cache that throws is worse than a cache that
 * misses.
 *
 * The TTL floor is the one real difference between the backends — KV cannot
 * express anything below 60 seconds, so `{ ttlSeconds: 30 }` is 60 on Workers
 * and 30 under Node. See `kv-driver.ts`.
 */
export async function withCache<T>(
  key: string,
  fetcher: () => Promise<T>,
  options?: { ttlSeconds?: number; disable?: boolean },
): Promise<T> {
  const { ttlSeconds = 120, disable = false } = options ?? {};

  if (!disable) {
    const cached = await store.get(key);
    if (cached) {
      try {
        return JSON.parse(cached) as T;
      } catch {
        // fallthrough to refresh cache
      }
    }
  }

  const value = await fetcher();

  if (!disable) {
    try {
      await store.put(key, JSON.stringify(value), { ttlSeconds });
    } catch {
      // ignore cache set errors
    }
  }

  return value;
}
