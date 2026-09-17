/**
 * Every KV namespace and Durable Object binding this Worker depends on.
 *
 * Same job, and the same hazard, as `server/queue/queue-registry.ts`: bindings
 * are deploy-time configuration, so one that the code reaches for and
 * `wrangler.jsonc` does not declare is simply absent from `env` at runtime —
 * a 500 on whatever path first touched it, in production, long after the commit
 * that caused it. `binding-registry.unit.test.ts` turns that into a red suite.
 *
 * Queue producer bindings are *not* here. They are derived from the list of SES
 * regions rather than written down (§4.1), so they have their own registry.
 *
 * See references/serverless-migration.md §1 and §3.
 */

/**
 * The one KV namespace.
 *
 * Team rows, usage rollups, notification cooldowns and domain verification
 * bookkeeping — everything in §1 item 5, and nothing else. Idempotency keys and
 * rate limit counters are Durable Objects below, because KV is eventually
 * consistent and both of those need read-after-write.
 */
export const CACHE_BINDING = "CACHE";

export const KV_BINDINGS = [CACHE_BINDING] as const;

/**
 * Durable Object bindings, and the class each one is bound to.
 *
 * The class names matter twice over: `wrangler.jsonc` binds by class name, and
 * every class also has to appear in a `migrations` entry — an unmigrated class
 * is a deploy-time error rather than a runtime one, which is the friendlier of
 * the two, but only if someone remembers. The test checks both halves.
 */
export const DURABLE_OBJECT_BINDINGS = {
  /** One object per `webhookId`. Replaces the Redis ordering lock (§3). */
  WEBHOOK_DISPATCHER: "WebhookDispatcher",
  /** A singleton on one object id. The 30s tick (§4.2). */
  CAMPAIGN_SCHEDULER: "CampaignScheduler",
  /**
   * One object per rate limit bucket: a team for the public API, an IP for the
   * auth email limit, a user for the waitlist. Exact counts, which is why this
   * is not Cloudflare's Rate Limiting binding — see `server/rate-limit/types.ts`.
   */
  RATE_LIMITER: "RateLimiter",
  /**
   * One object per `teamId` + `Idempotency-Key`. A dedup guard needs
   * read-after-write and KV has none — see `server/idempotency/types.ts`.
   */
  IDEMPOTENCY_KEEPER: "IdempotencyKeeper",
} as const satisfies Record<string, string>;

export type DurableObjectBindingName = keyof typeof DURABLE_OBJECT_BINDINGS;

/** Every Durable Object class, which is what `migrations` has to cover. */
export const DURABLE_OBJECT_CLASSES: readonly string[] = Object.values(
  DURABLE_OBJECT_BINDINGS,
);
