/* eslint-disable no-unused-vars -- parameter names in type signatures */

/**
 * The idempotency seam: remember what an `Idempotency-Key` produced, and let
 * exactly one caller produce it.
 *
 * **Why not Workers KV.** A dedup guard is the one thing eventual consistency
 * destroys completely. Two identical sends arriving within KV's propagation
 * window would both read "no record", both send, and the header that was
 * supposed to prevent a duplicate would have caused one. §1 says KV is for the
 * cache and dedup-with-a-TTL cases only, and this is neither — a notification
 * cooldown losing a race costs a duplicate email, this losing a race costs a
 * duplicate *campaign*.
 *
 * So: a Durable Object per `teamId` + key, which is single-threaded per object
 * id. The lock is not a lock any more — it is a state transition inside an
 * object that only one caller can be inside at a time.
 */

export type IdempotencyRecord = {
  bodyHash: string;
  emailIds: string[];
};

/**
 * What `begin` found. One round trip where the Redis version needed up to
 * three, because the object can decide with the state in front of it.
 */
export type IdempotencyBegin =
  /** Nobody has this key. The caller owns it and must `complete` or `abandon`. */
  | { status: "acquired" }
  /** Same key, same payload, already done. Replay the stored result. */
  | { status: "hit"; emailIds: string[] }
  /** Same key, different payload. A client bug, and a 4xx either way. */
  | { status: "conflict" }
  /** Same key, same payload, still running somewhere. Retry later. */
  | { status: "in-progress" };

export type IdempotencyStore = {
  readonly name: string;

  /**
   * Claims `key` for `bodyHash`, or reports why it could not be claimed.
   *
   * Atomic: between deciding that no record exists and writing the claim, no
   * other caller may do the same. That is the whole contract, and it is why
   * this cannot be KV.
   */
  begin(
    teamId: number,
    key: string,
    bodyHash: string,
  ): Promise<IdempotencyBegin>;

  /** Records the result, for `RESULT_TTL_SECONDS`, and releases the claim. */
  complete(
    teamId: number,
    key: string,
    bodyHash: string,
    emailIds: string[],
  ): Promise<void>;

  /**
   * Releases a claim that produced nothing, so a retry is not blocked for the
   * full lock TTL. Never removes a completed record.
   */
  abandon(teamId: number, key: string): Promise<void>;
};

/**
 * The Durable Object's RPC surface, described structurally — the class imports
 * `cloudflare:workers`, and this module is reachable from code Next.js bundles.
 * Same move as the webhook dispatcher and the rate limiter.
 */
export type IdempotencyKeeperNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): {
    begin(bodyHash: string): Promise<IdempotencyBegin>;
    complete(bodyHash: string, emailIds: string[]): Promise<void>;
    abandon(): Promise<void>;
  };
};

/** 24 hours. How long a completed result can be replayed. */
export const RESULT_TTL_SECONDS = 24 * 60 * 60;

/**
 * 60 seconds. How long a claim survives a caller that never came back.
 *
 * It is a timeout rather than a lease anyone renews: a send that takes longer
 * than a minute has almost certainly failed, and the cost of being wrong is a
 * second attempt at an operation whose own guard is the claim-UPDATE in
 * `email-queue-service.ts` (§4.4).
 */
export const LOCK_TTL_SECONDS = 60;

/** The object id, and the Redis key suffix. One per team per key. */
export function idempotencyScope(teamId: number, key: string) {
  return `${teamId}:${key}`;
}
