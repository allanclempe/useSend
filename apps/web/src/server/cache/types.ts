/* eslint-disable no-unused-vars -- parameter names in type signatures */

/**
 * The cache seam: the half of Redis that is genuinely cache-shaped.
 *
 * §1 of references/serverless-migration.md splits Redis's five jobs by what
 * they actually need. This interface is for the ones that tolerate eventual
 * consistency and want a TTL — team rows, usage rollups, notification cooldowns
 * and domain verification bookkeeping. It is deliberately *not* for idempotency
 * or rate limiting: both need read-after-write, Workers KV does not offer it,
 * and those two live behind `server/idempotency` and `server/rate-limit`
 * instead, on Durable Objects.
 *
 * Values are strings. Callers that want objects go through `withCache` or do
 * their own `JSON.parse`, which keeps the drivers free of any opinion about
 * encoding — KV and Redis both store bytes.
 */
export type CacheStore = {
  /** Which backend this is, for log lines and error messages. */
  readonly name: string;

  get(key: string): Promise<string | null>;

  put(
    key: string,
    value: string,
    options?: { ttlSeconds?: number },
  ): Promise<void>;

  /**
   * Writes `key` only if it is absent, and reports whether this caller was the
   * one that created it. Redis's `SET NX`.
   *
   * **Exact on Redis, best-effort on KV.** Workers KV has no conditional write,
   * so the KV driver reads and then writes, and two callers racing inside the
   * read window both win. Every caller of this is a notification cooldown,
   * where losing the race costs one duplicate email — that is the whole reason
   * it is allowed to be approximate here and nowhere else. Anything that needs
   * a real mutex needs a Durable Object.
   */
  add(
    key: string,
    value: string,
    options: { ttlSeconds: number },
  ): Promise<boolean>;

  delete(...keys: string[]): Promise<void>;
};
