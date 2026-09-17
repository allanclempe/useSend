import { DurableObject } from "cloudflare:workers";
import { createDrizzleClient, withDrizzleClient } from "~/server/drizzle";
import { logger } from "~/server/logger/log";
import { startTrace, withTraceContext } from "~/server/logger/trace-context";
import {
  computeBackoff,
  processWebhookCall,
  WEBHOOK_MAX_ATTEMPTS,
} from "~/server/service/webhook-service";
import {
  withWorkerBindings,
  type WorkerBindings,
} from "~/server/worker-bindings";

/**
 * One Durable Object per `webhookId`, and it is the ordering guarantee.
 *
 * `webhook-service.ts` used to take a Redis lock — `SET NX PX` with a Lua
 * release, a 15s TTL and a retry path for losing the race — so that two
 * deliveries to the same endpoint could not overlap. A Durable Object is
 * single-threaded per object id, so that property is free here: calls for one
 * webhook arrive at one object and are delivered one at a time, in the order
 * they were appended. The lock, the Lua and the retry path are deleted (§3).
 *
 * Retry timing is an alarm rather than a queue's redelivery. That is what lets
 * the head of the list stay the head: a queue would have put a failed message
 * back at an arbitrary position relative to the messages behind it, which is
 * exactly the ordering the lock existed to protect.
 *
 * Two constraints from the residency measurement in §4.2 apply here and are
 * both deliberate:
 *
 * - **No connection outlives an alarm.** A held-open outbound socket makes a
 *   Durable Object permanently ineligible for hibernation — measured, silently,
 *   with no error anywhere. The Drizzle client is built inside the alarm and
 *   awaited closed before it returns, so an idle dispatcher holds nothing.
 * - **Nothing is left pending across a tick.** No `setTimeout`, no unawaited
 *   `fetch`. Each was measured to pin the object on its own.
 *
 * Unlike the campaign scheduler, this object has no standing tick: it arms an
 * alarm only while it has work, so an idle webhook costs nothing.
 */

type PendingCall = {
  callId: string;
  teamId: number;
  /** Prior attempts, matching BullMQ's `attemptsMade`; 0 on the first run. */
  attemptsMade: number;
  /** The trace the emitting request was in, so delivery joins it. */
  traceparent: string | null;
};

const PENDING_KEY = "pending";

export class WebhookDispatcher extends DurableObject<WorkerBindings> {
  /**
   * Appends a call and makes sure the loop is running.
   *
   * Deliberately not delivering inline: returning quickly keeps the caller —
   * which is usually in the middle of an API request or a queue consumer —
   * from waiting on someone else's HTTP endpoint.
   */
  async deliver(
    callId: string,
    teamId: number,
    traceparent: string | null,
  ): Promise<void> {
    const pending =
      (await this.ctx.storage.get<PendingCall[]>(PENDING_KEY)) ?? [];

    // At-least-once delivery means `deliver` can be called twice for one call.
    // Appending it twice would deliver it twice; this is the cheap half of the
    // guard, and `processWebhookCall` reading the row's status is the rest.
    if (pending.some((call) => call.callId === callId)) {
      return;
    }

    pending.push({ callId, teamId, attemptsMade: 0, traceparent });
    await this.ctx.storage.put(PENDING_KEY, pending);

    // An alarm already set is either about to run or is a retry backoff that
    // must not be brought forward.
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  /** How many calls are waiting. Exists for tests and for triage. */
  async depth(): Promise<number> {
    return (await this.ctx.storage.get<PendingCall[]>(PENDING_KEY))?.length ?? 0;
  }

  async alarm(): Promise<void> {
    const pending =
      (await this.ctx.storage.get<PendingCall[]>(PENDING_KEY)) ?? [];
    const call = pending[0];

    if (!call) {
      await this.ctx.storage.delete(PENDING_KEY);
      return;
    }

    const { db, close } = createDrizzleClient(
      this.env.HYPERDRIVE.connectionString,
      1,
    );

    let delivered = false;

    try {
      await withWorkerBindings(this.env, () =>
        withDrizzleClient(db, () =>
          withTraceContext(startTrace(call.traceparent), async () => {
            await processWebhookCall({
              id: call.callId,
              name: call.callId,
              data: { callId: call.callId, teamId: call.teamId },
              attemptsMade: call.attemptsMade,
            });
          }),
        ),
      );

      delivered = true;
    } catch (error) {
      // `processWebhookCall` has already recorded the failure on the row and
      // decided whether to auto-disable the webhook. All that is left is when
      // to try again.
      logger.warn(
        { err: error, callId: call.callId, attemptsMade: call.attemptsMade },
        "[WebhookDispatcher]: Delivery attempt failed",
      );
    } finally {
      // Awaited, not `waitUntil`: a socket that outlives the alarm is what
      // makes this object permanently resident (§4.2).
      await close();
    }

    const attempts = call.attemptsMade + 1;
    const exhausted = attempts >= WEBHOOK_MAX_ATTEMPTS;

    if (delivered || exhausted) {
      pending.shift();
    } else {
      pending[0] = { ...call, attemptsMade: attempts };
    }

    await this.ctx.storage.put(PENDING_KEY, pending);

    if (pending.length === 0) {
      return;
    }

    // A retry waits out its backoff; anything else runs as soon as this alarm
    // returns. Either way the head of the list is what runs next, which is the
    // ordering guarantee.
    const nextAt =
      delivered || exhausted ? Date.now() : Date.now() + computeBackoff(attempts);

    await this.ctx.storage.setAlarm(nextAt);
  }
}
