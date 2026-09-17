import { cacheAdd, cacheDelete, cacheGet, cachePut } from "~/server/cache";
import { idempotencyStore } from "~/server/idempotency";
import { consumeRateLimit } from "~/server/rate-limit";
import { IdempotencyService } from "~/server/service/idempotency-service";
import {
  withWorkerBindings,
  type WorkerBindings,
} from "~/server/worker-bindings";

export { IdempotencyKeeper } from "./idempotency-keeper";
export { RateLimiter } from "./rate-limiter";

/**
 * A fixture Worker, never deployed. Sibling of `compat-check.ts` and
 * `queue-check.ts`.
 *
 * Phase 9 moves Redis's remaining four jobs onto Workers KV and Durable
 * Objects, and the claims worth checking against the real runtime rather than
 * the documentation are the ones the split was made on:
 *
 * - the cache seam reaches a real KV binding, and `add` behaves;
 * - **a rate limit counted in a Durable Object is exact under concurrency** —
 *   which is the entire reason it is not Cloudflare's per-colo Rate Limiting
 *   binding, and not something a unit test with a fake can demonstrate;
 * - **concurrent duplicate requests carrying one `Idempotency-Key` run the
 *   operation once** — the acceptance criterion on #11, and the thing KV's
 *   eventual consistency would quietly break.
 *
 *   pnpm --filter=web bindings:check
 *   curl -s http://localhost:8792/ | jq
 *
 * One thing this deliberately does **not** prove: KV's eventual consistency.
 * `wrangler dev` simulates KV on local disk, where a read after a write is
 * always fresh. The 60-second propagation window is a property of the real
 * network, so every place that depends on it is reasoned about at the call site
 * instead — see `CacheStore.add` and `TeamService`.
 */

type Check = {
  name: string;
  passed: boolean;
  detail: string;
};

async function cacheChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  const key = `binding-check:${crypto.randomUUID()}`;

  await cachePut(key, "first", { ttlSeconds: 120 });
  checks.push({
    name: "cache: put then get",
    passed: (await cacheGet(key)) === "first",
    detail: String(await cacheGet(key)),
  });

  const firstAdd = await cacheAdd(`${key}:add`, "1", { ttlSeconds: 60 });
  const secondAdd = await cacheAdd(`${key}:add`, "1", { ttlSeconds: 60 });
  checks.push({
    name: "cache: add creates once",
    passed: firstAdd && !secondAdd,
    detail: `first=${firstAdd} second=${secondAdd}`,
  });

  // The KV driver raises this to KV's 60-second floor. The failure this is here
  // to catch is a TTL that reaches KV unraised and is rejected outright.
  const shortTtlKey = `${key}:short`;
  let shortTtlError: string | null = null;
  try {
    await cachePut(shortTtlKey, "short", { ttlSeconds: 5 });
  } catch (error) {
    shortTtlError = String(error);
  }
  checks.push({
    name: "cache: sub-minute TTL is raised, not rejected",
    passed: shortTtlError === null && (await cacheGet(shortTtlKey)) === "short",
    detail: shortTtlError ?? "accepted",
  });

  await cacheDelete(key);
  checks.push({
    name: "cache: delete",
    passed: (await cacheGet(key)) === null,
    detail: String(await cacheGet(key)),
  });

  return checks;
}

async function rateLimitChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  const bucket = `binding-check:${crypto.randomUUID()}`;

  /**
   * The headline check.
   *
   * Twenty concurrent calls at a limit of five. Exact means every call gets a
   * distinct count in 1..20 — no two callers may read the same number — and
   * exactly five of them come back under the limit. A per-colo approximate
   * limiter cannot promise either.
   */
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      consumeRateLimit(bucket, { limit: 5, windowSeconds: 60 }),
    ),
  );

  const counts = results.map((result) => result.count).sort((a, b) => a - b);
  const allowed = results.filter((result) => !result.limited).length;

  checks.push({
    name: "rate limit: 20 concurrent calls get 20 distinct counts",
    passed:
      counts.join(",") ===
      Array.from({ length: 20 }, (_, i) => i + 1).join(","),
    detail: counts.join(","),
  });

  checks.push({
    name: "rate limit: exactly `limit` calls are allowed",
    passed: allowed === 5,
    detail: `allowed=${allowed} expected=5`,
  });

  const other = await consumeRateLimit(`${bucket}:other`, {
    limit: 5,
    windowSeconds: 60,
  });
  checks.push({
    name: "rate limit: a different bucket is a different counter",
    passed: other.count === 1 && !other.limited,
    detail: `count=${other.count}`,
  });

  // A fixed window, not a sliding one: once it expires the count starts over.
  const shortBucket = `${bucket}:short`;
  await consumeRateLimit(shortBucket, { limit: 1, windowSeconds: 1 });
  const overLimit = await consumeRateLimit(shortBucket, {
    limit: 1,
    windowSeconds: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const afterReset = await consumeRateLimit(shortBucket, {
    limit: 1,
    windowSeconds: 1,
  });

  checks.push({
    name: "rate limit: the window expires and the count restarts",
    passed: overLimit.limited && afterReset.count === 1 && !afterReset.limited,
    detail: `overLimit=${overLimit.count} afterReset=${afterReset.count}`,
  });

  return checks;
}

async function idempotencyChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  const teamId = 4242;

  /**
   * The headline check, and the acceptance criterion on #11.
   *
   * Ten concurrent `withIdempotency` calls with one key and one payload. The
   * operation must run exactly once; the other nine must either replay its
   * result or be told it is in progress, and none of them may run it.
   *
   * The operation yields before returning, which is what makes this a real
   * test: without it the whole thing could complete inside one microtask and
   * never overlap.
   */
  const key = `concurrent-${crypto.randomUUID()}`;
  let ran = 0;

  const outcomes = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      IdempotencyService.withIdempotency({
        teamId,
        idemKey: key,
        payload: { to: "a@b.com", subject: "hello" },
        operation: async () => {
          ran += 1;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { emailIds: ["em_1"] };
        },
        extractEmailIds: (result: { emailIds: string[] }) => result.emailIds,
        formatCachedResponse: (emailIds: string[]) => ({ emailIds }),
        logContext: "binding-check",
      }),
    ),
  );

  const fulfilled = outcomes.filter(
    (outcome) => outcome.status === "fulfilled",
  ).length;

  checks.push({
    name: "idempotency: 10 concurrent duplicates run the operation once",
    passed: ran === 1,
    detail: `ran=${ran} fulfilled=${fulfilled}/10`,
  });

  // Every caller that did not get the result was refused, not silently given a
  // different one.
  checks.push({
    name: "idempotency: no concurrent duplicate produced a second result",
    passed: outcomes.every(
      (outcome) =>
        outcome.status === "rejected" ||
        JSON.stringify(outcome.value) ===
          JSON.stringify({ emailIds: ["em_1"] }),
    ),
    detail: outcomes
      .map((outcome) => (outcome.status === "fulfilled" ? "hit" : "refused"))
      .join(","),
  });

  // And once it has settled, a later identical request replays rather than runs.
  const replay = await IdempotencyService.withIdempotency({
    teamId,
    idemKey: key,
    payload: { to: "a@b.com", subject: "hello" },
    operation: async () => {
      ran += 1;
      return { emailIds: ["em_2"] };
    },
    extractEmailIds: (result: { emailIds: string[] }) => result.emailIds,
    formatCachedResponse: (emailIds: string[]) => ({ emailIds }),
    logContext: "binding-check",
  });

  checks.push({
    name: "idempotency: a later duplicate replays the stored result",
    passed: ran === 1 && replay.emailIds[0] === "em_1",
    detail: `ran=${ran} emailIds=${replay.emailIds.join(",")}`,
  });

  // A different payload under the same key is a conflict, not a second send.
  const conflictKey = `conflict-${crypto.randomUUID()}`;
  await idempotencyStore.begin(teamId, conflictKey, "hash-a");
  const conflict = await idempotencyStore.begin(teamId, conflictKey, "hash-b");
  checks.push({
    name: "idempotency: a different payload under the same key conflicts",
    passed: conflict.status === "conflict",
    detail: conflict.status,
  });

  // An abandoned claim frees the key immediately rather than for the lock TTL.
  const retryKey = `retry-${crypto.randomUUID()}`;
  await idempotencyStore.begin(teamId, retryKey, "hash-a");
  await idempotencyStore.abandon(teamId, retryKey);
  const afterAbandon = await idempotencyStore.begin(teamId, retryKey, "hash-a");
  checks.push({
    name: "idempotency: abandoning a claim frees the key",
    passed: afterAbandon.status === "acquired",
    detail: afterAbandon.status,
  });

  return checks;
}

export default {
  async fetch(_request: Request, env: WorkerBindings): Promise<Response> {
    return await withWorkerBindings(env, async () => {
      const checks = [
        ...(await cacheChecks()),
        ...(await rateLimitChecks()),
        ...(await idempotencyChecks()),
      ];

      return Response.json(
        {
          passed: checks.every((check) => check.passed),
          checks,
        },
        { status: checks.every((check) => check.passed) ? 200 : 500 },
      );
    });
  },
};
