import { DurableObject } from "cloudflare:workers";

import {
  LOCK_TTL_SECONDS,
  RESULT_TTL_SECONDS,
  type IdempotencyBegin,
} from "~/server/idempotency/types";
import type { WorkerBindings } from "~/server/worker-bindings";

/**
 * One `Idempotency-Key`, for one team.
 *
 * The object id is `teamId:key` (`server/idempotency/durable-object-driver.ts`),
 * so this class holds exactly one entry and the Redis lock it replaces is gone
 * rather than ported: a Durable Object is single-threaded per object id, so
 * "only one caller may be deciding this at a time" is a property of where the
 * code runs. The same reasoning retired the webhook lock in Phase 8 (§3).
 */

/** The only storage key. One entry per object. */
const ENTRY_KEY = "entry";

type Entry =
  | { state: "pending"; bodyHash: string; expiresAt: number }
  | {
      state: "done";
      bodyHash: string;
      emailIds: string[];
      expiresAt: number;
    };

export class IdempotencyKeeper extends DurableObject<WorkerBindings> {
  /**
   * Read, decide and claim in one indivisible step.
   *
   * On Redis this was `GET`, then `SET NX`, then another `GET` to cover the
   * case where the winner finished in between — three round trips and a
   * genuine race the second `GET` only narrows. Here it is one call and no
   * race, which is the whole argument for the Durable Object.
   */
  async begin(bodyHash: string): Promise<IdempotencyBegin> {
    return await this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const entry = await this.ctx.storage.get<Entry>(ENTRY_KEY);

      if (entry && entry.expiresAt > now) {
        if (entry.bodyHash !== bodyHash) {
          // Same key, different payload — a client bug, and the answer is the
          // same whether the first request finished or is still running.
          return { status: "conflict" };
        }

        return entry.state === "done"
          ? { status: "hit", emailIds: entry.emailIds }
          : { status: "in-progress" };
      }

      // No entry, or one whose claim timed out. Storage has no TTL of its own,
      // so expiry is a field that is checked rather than something that happens.
      const expiresAt = now + LOCK_TTL_SECONDS * 1000;
      await this.ctx.storage.put<Entry>(ENTRY_KEY, {
        state: "pending",
        bodyHash,
        expiresAt,
      });
      await this.ctx.storage.setAlarm(expiresAt);

      return { status: "acquired" };
    });
  }

  async complete(bodyHash: string, emailIds: string[]): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const expiresAt = Date.now() + RESULT_TTL_SECONDS * 1000;

      await this.ctx.storage.put<Entry>(ENTRY_KEY, {
        state: "done",
        bodyHash,
        emailIds,
        expiresAt,
      });
      // Replaces the 60-second claim alarm with the 24-hour result one.
      await this.ctx.storage.setAlarm(expiresAt);
    });
  }

  async abandon(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const entry = await this.ctx.storage.get<Entry>(ENTRY_KEY);

      // Only a claim is abandoned. A `finally` that ran after `complete`
      // succeeded must not delete the result it just stored.
      if (entry?.state !== "pending") {
        return;
      }

      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
    });
  }

  /**
   * Reclaims the object's storage once its entry has expired.
   *
   * Unlike the rate limiter, this one is worth an alarm: idempotency keys are
   * supplied by clients and therefore unbounded, one per request that sets the
   * header, and the alarm is one Durable Object request per key per *day*
   * rather than per second.
   */
  async alarm(): Promise<void> {
    const entry = await this.ctx.storage.get<Entry>(ENTRY_KEY);

    if (!entry) {
      return;
    }

    if (entry.expiresAt > Date.now()) {
      // A `complete` moved the expiry out while this alarm was in flight.
      await this.ctx.storage.setAlarm(entry.expiresAt);
      return;
    }

    await this.ctx.storage.deleteAll();
  }
}
