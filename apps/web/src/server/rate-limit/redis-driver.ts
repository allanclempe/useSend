import { getRedis, redisKey } from "../redis";
import type { RateLimiter } from "./types";

/**
 * `INCR` plus `EXPIRE` on first use, which is what all three call sites did
 * inline before the seam existed.
 *
 * The `TTL` read is the third round trip and it is not optional: `Retry-After`
 * and `X-RateLimit-Reset` are derived from it, and Redis is the only thing that
 * knows when the window opened.
 *
 * Deleted by Phase 10 (#12).
 */
export const redisRateLimiter: RateLimiter = {
  name: "redis",

  async consume(bucket, window) {
    const redis = getRedis();
    const key = redisKey(`ratelimit:${bucket}`);

    const count = await redis.incr(key);

    if (count === 1) {
      await redis.expire(key, window.windowSeconds);
    }

    const ttl = await redis.ttl(key);
    const resetSeconds = ttl > 0 ? ttl : window.windowSeconds;

    return {
      count,
      limit: window.limit,
      remaining: Math.max(0, window.limit - count),
      resetSeconds,
      limited: count > window.limit,
    };
  },
};
