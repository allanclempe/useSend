import { getRedis, redisKey } from "../redis";
import {
  idempotencyScope,
  LOCK_TTL_SECONDS,
  RESULT_TTL_SECONDS,
  type IdempotencyBegin,
  type IdempotencyRecord,
  type IdempotencyStore,
} from "./types";

function resultKey(teamId: number, key: string) {
  return redisKey(`idem:${idempotencyScope(teamId, key)}`);
}

function lockKey(teamId: number, key: string) {
  return redisKey(`idemlock:${idempotencyScope(teamId, key)}`);
}

function parseRecord(raw: string | null): IdempotencyRecord | null {
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as IdempotencyRecord).bodyHash === "string" &&
      Array.isArray((parsed as IdempotencyRecord).emailIds)
    ) {
      return parsed as IdempotencyRecord;
    }
  } catch {
    // An unreadable record is no record: the caller re-runs the operation.
  }

  return null;
}

function decide(record: IdempotencyRecord, bodyHash: string): IdempotencyBegin {
  return record.bodyHash === bodyHash
    ? { status: "hit", emailIds: record.emailIds }
    : { status: "conflict" };
}

/**
 * The Node driver: the `GET` / `SET NX` / re-`GET` dance that used to live in
 * `IdempotencyService` itself.
 *
 * The one addition is that the lock now *holds the body hash* rather than `"1"`.
 * That is what lets a contended `begin` tell "the same request is already
 * running" from "this key is being used for something else" without waiting for
 * the first to finish, and it is what makes Redis and the Durable Object return
 * the same four answers.
 *
 * Deleted by Phase 10 (#12).
 */
export const redisIdempotencyStore: IdempotencyStore = {
  name: "redis",

  async begin(teamId, key, bodyHash) {
    const redis = getRedis();

    const existing = parseRecord(await redis.get(resultKey(teamId, key)));
    if (existing) {
      return decide(existing, bodyHash);
    }

    const acquired = await redis.set(
      lockKey(teamId, key),
      bodyHash,
      "EX",
      LOCK_TTL_SECONDS,
      "NX",
    );

    if (acquired === "OK") {
      return { status: "acquired" };
    }

    // Lost the race. The winner may already have finished.
    const again = parseRecord(await redis.get(resultKey(teamId, key)));
    if (again) {
      return decide(again, bodyHash);
    }

    const holder = await redis.get(lockKey(teamId, key));
    return holder && holder !== bodyHash
      ? { status: "conflict" }
      : { status: "in-progress" };
  },

  async complete(teamId, key, bodyHash, emailIds) {
    const redis = getRedis();

    await redis.setex(
      resultKey(teamId, key),
      RESULT_TTL_SECONDS,
      JSON.stringify({ bodyHash, emailIds } satisfies IdempotencyRecord),
    );
    await redis.del(lockKey(teamId, key));
  },

  async abandon(teamId, key) {
    await getRedis().del(lockKey(teamId, key));
  },
};
