/* eslint-disable no-unused-vars -- parameter names in type signatures */

import {
  idempotencyStore,
  LOCK_TTL_SECONDS,
  RESULT_TTL_SECONDS,
} from "~/server/idempotency";
import { canonicalizePayload } from "~/server/utils/idempotency";
import { UnsendApiError } from "~/server/public-api/api-error";
import { logger } from "~/server/logger/log";

export type { IdempotencyRecord } from "~/server/idempotency";

export type IdempotencyHandlerOptions<TPayload, TResult> = {
  teamId: number;
  idemKey: string | undefined;
  payload: TPayload;
  operation: () => Promise<TResult>;
  extractEmailIds: (result: TResult) => string[];
  formatCachedResponse: (emailIds: string[]) => TResult;
  logContext: string;
};

export const IdempotencyService = {
  /**
   * Runs `operation` at most once per `Idempotency-Key`, and replays its result
   * for anyone who asks again with the same payload.
   *
   * The store underneath is a Durable Object (`server/idempotency`). What used
   * to be four calls and a re-check here —
   * read the result, take a lock, read the result again because the lock might
   * have been released in between, release the lock in a `finally` — is now one
   * `begin` that returns the decision, because on a Durable Object there is no
   * window between reading and claiming for anything to happen in.
   */
  async withIdempotency<TPayload, TResult>(
    options: IdempotencyHandlerOptions<TPayload, TResult>,
  ): Promise<TResult> {
    const {
      teamId,
      idemKey,
      payload,
      operation,
      extractEmailIds,
      formatCachedResponse,
      logContext,
    } = options;

    if (idemKey !== undefined && (idemKey.length < 1 || idemKey.length > 256)) {
      throw new UnsendApiError({
        code: "BAD_REQUEST",
        message: "Invalid Idempotency-Key length",
      });
    }

    if (!idemKey) {
      return await operation();
    }

    const { bodyHash } = canonicalizePayload(payload);
    const begin = await idempotencyStore.begin(teamId, idemKey, bodyHash);

    if (begin.status === "hit") {
      logger.info({ teamId }, `Idempotency hit for ${logContext}`);
      return formatCachedResponse(begin.emailIds);
    }

    if (begin.status === "conflict") {
      throw new UnsendApiError({
        code: "NOT_UNIQUE",
        message: "Idempotency-Key already used with a different payload",
      });
    }

    if (begin.status === "in-progress") {
      throw new UnsendApiError({
        code: "NOT_UNIQUE",
        message:
          "Request with same Idempotency-Key is in progress. Retry later.",
      });
    }

    let completed = false;

    try {
      const result = await operation();

      // Records the result and releases the claim together, so there is no
      // moment where the key is free but the work has been done.
      await idempotencyStore.complete(
        teamId,
        idemKey,
        bodyHash,
        extractEmailIds(result),
      );
      completed = true;

      return result;
    } finally {
      // An operation that threw leaves nothing to replay, and holding the key
      // for the full claim TTL would block the client's retry for no reason.
      if (!completed) {
        await idempotencyStore.abandon(teamId, idemKey);
      }
    }
  },
};

export const IDEMPOTENCY_CONSTANTS = {
  RESULT_TTL_SECONDS,
  LOCK_TTL_SECONDS,
};
