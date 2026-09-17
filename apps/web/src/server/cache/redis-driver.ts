import { getRedis, redisKey } from "../redis";
import type { CacheStore } from "./types";

/**
 * The Node cache driver: Redis, exactly as every one of these call sites used
 * it before the seam existed.
 *
 * `redisKey` is applied here rather than at the call sites. The prefix exists so
 * several installs can share one Redis instance; a KV namespace is already a
 * namespace, so the KV driver has nothing to apply and the call sites pass
 * logical keys to both.
 *
 * Deleted by Phase 10 (#12) along with the rest of `ioredis`.
 */
export const redisCacheStore: CacheStore = {
  name: "redis",

  async get(key) {
    return await getRedis().get(redisKey(key));
  },

  async put(key, value, options) {
    const ttlSeconds = options?.ttlSeconds;
    const redis = getRedis();

    if (ttlSeconds === undefined) {
      await redis.set(redisKey(key), value);
      return;
    }

    await redis.setex(redisKey(key), Math.ceil(ttlSeconds), value);
  },

  async add(key, value, options) {
    const result = await getRedis().set(
      redisKey(key),
      value,
      "EX",
      Math.ceil(options.ttlSeconds),
      "NX",
    );

    return result === "OK";
  },

  async delete(...keys) {
    if (keys.length === 0) {
      return;
    }
    await getRedis().del(...keys.map(redisKey));
  },
};
