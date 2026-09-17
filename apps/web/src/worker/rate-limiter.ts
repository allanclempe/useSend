import { DurableObject } from "cloudflare:workers";

import type { RateLimitResult } from "~/server/rate-limit/types";
import type { WorkerBindings } from "~/server/worker-bindings";

/**
 * One fixed window, counted exactly, for one bucket.
 *
 * The object id is the bucket name (`server/rate-limit/durable-object-driver.ts`),
 * so this class holds exactly one counter and never has to namespace anything.
 *
 * Exactness is the whole reason this is a Durable Object rather than
 * Cloudflare's Rate Limiting binding — see `server/rate-limit/types.ts` for the
 * arithmetic that rules the approximate one out.
 */

/** The only storage key. One counter per object. */
const WINDOW_KEY = "window";

type StoredWindow = {
  count: number;
  /** Epoch ms. Read on every call, because storage has no TTL of its own. */
  expiresAt: number;
};

export class RateLimiter extends DurableObject<WorkerBindings> {
  async consume(
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    /**
     * `blockConcurrencyWhile` rather than a bare read-modify-write.
     *
     * Input gating already makes this atomic today — the runtime delivers no
     * new event while a storage operation is outstanding — but that is a
     * property of the runtime rather than of this code, and the whole reason to
     * be here instead of on KV is that the count is exact. Saying so costs
     * nothing and cannot be undone by a refactor that adds an await.
     */
    return await this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const stored = await this.ctx.storage.get<StoredWindow>(WINDOW_KEY);

      // An expired window is the same as no window. Fixed, not sliding: the
      // expiry is set when the window opens and a later request never moves it,
      // which is exactly what `INCR` + `EXPIRE`-on-first did.
      const window =
        stored && stored.expiresAt > now
          ? stored
          : { count: 0, expiresAt: now + windowSeconds * 1000 };

      const next: StoredWindow = {
        count: window.count + 1,
        expiresAt: window.expiresAt,
      };

      await this.ctx.storage.put(WINDOW_KEY, next);

      return {
        count: next.count,
        limit,
        remaining: Math.max(0, limit - next.count),
        // Floored at one so `Retry-After: 0` is unreachable.
        resetSeconds: Math.max(1, Math.ceil((next.expiresAt - now) / 1000)),
        limited: next.count > limit,
      };
    });
  }
}

/**
 * **There is deliberately no alarm here, and no `deleteAll`.**
 *
 * An abandoned bucket — an IP seen once — leaves one small row behind forever,
 * and the obvious fix is an alarm at the window's expiry that deletes it. That
 * fix costs one extra Durable Object request per window per bucket, and the
 * hottest bucket in the system has a one-second window, so it would roughly
 * double the request count on the busiest path in the API to reclaim tens of
 * bytes. Storage is the cheaper of the two by orders of magnitude (§12).
 */
