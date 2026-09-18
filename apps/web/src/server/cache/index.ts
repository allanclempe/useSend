import { kvCacheStore } from "./kv-driver";
import type { CacheStore } from "./types";

export * from "./types";

/**
 * The cache backend: Workers KV, and nothing above this line knows that.
 *
 * There was a Redis driver beside it and a runtime check to choose between
 * them, for as long as the same code had to run under Node too. Phase 10 (#12)
 * deleted both — there is one runtime now, so a seam with one driver is just
 * an interface, which is the point.
 */
const store: CacheStore = kvCacheStore;

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
 * Came from `server/redis.ts` unchanged in shape, including its two swallowed
 * failure modes: unparseable JSON falls through to a refresh, and a write that
 * fails is ignored. A cache that throws is worse than a cache that misses.
 *
 * `ttlSeconds` has a floor of 60 — KV cannot express anything shorter, so a
 * caller asking for 30 gets 60. See `kv-driver.ts`.
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
