/* eslint-disable no-unused-vars -- parameter names in type signatures */

/**
 * The rate limit seam: a fixed window, counted exactly.
 *
 * **Why not Workers KV.** A counter needs read-after-write and KV has none;
 * §1 says so and this is one of the two things it says it about.
 *
 * **Why not Cloudflare's Rate Limiting binding.** It is per-colo and
 * approximate by design. The public API's default is two requests per second
 * (`Team.apiRateLimit`), so a customer spread over ten colos would be granted
 * twenty — an over-grant of the same order as the limit itself, which is not a
 * rate limit. It also reports no count, no remaining and no reset, and the API
 * returns all three as headers.
 *
 * So: a Durable Object per bucket, which is single-threaded per object id and
 * therefore exact. What that costs is latency — an object lives in one place,
 * and a request from a colo far from it pays the round trip on every call. That
 * is the price of the word "exact", and it is the price Redis was already
 * charging, except that Redis was one hop from one deployment and this is one
 * hop from anywhere.
 */

/** The window, as the caller sees it. Both halves are per-call, not per-bucket. */
export type RateLimitWindow = {
  /** Requests allowed in a window. Exceeding it is `limited`, not an error. */
  limit: number;
  /** How long the window lasts, from the first request counted into it. */
  windowSeconds: number;
};

export type RateLimitResult = {
  /** Requests counted into the current window, including this one. */
  count: number;
  limit: number;
  /** `limit - count`, floored at zero. */
  remaining: number;
  /** Seconds until the window resets, floored at one. */
  resetSeconds: number;
  /** `count > limit`. */
  limited: boolean;
};

export type RateLimiter = {
  readonly name: string;
  /**
   * Counts one request into `bucket`'s window and reports where that leaves it.
   *
   * A request that is over the limit is still counted — as it was under Redis,
   * where the `INCR` came before the comparison. It does not extend the window:
   * the expiry is set once, when the window opens.
   */
  consume(bucket: string, window: RateLimitWindow): Promise<RateLimitResult>;
};

/**
 * The Durable Object's RPC surface, described structurally.
 *
 * The class extends `DurableObject` from `cloudflare:workers`, which must never
 * reach a module Next.js bundles — and `hono.ts` and the auth route are exactly
 * that. A structural type needs no import. Same move the webhook dispatcher and
 * the campaign scheduler already make.
 */
export type RateLimiterNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): {
    consume(limit: number, windowSeconds: number): Promise<RateLimitResult>;
  };
};

/** Bucket names. One function per limit so the namespaces cannot collide. */
export const rateLimitBucket = {
  /** The public API, per team. `Team.apiRateLimit` requests per second. */
  api: (teamId: number) => `api:team:${teamId}`,
  /** better-auth's send-OTP endpoint, per client IP. */
  authEmail: (ip: string) => `auth:ip:${ip}`,
  /** Waitlist submissions, per user. */
  waitlist: (userId: number) => `waitlist:user:${userId}`,
};
