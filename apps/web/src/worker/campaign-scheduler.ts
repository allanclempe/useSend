import { DurableObject } from "cloudflare:workers";
import { logger } from "~/server/logger/log";
import { currentTraceparent, newTraceContext, withTraceContext } from "~/server/logger/trace-context";
import { SCHEDULER_TICK_MS } from "~/server/jobs/campaign-scheduler-job";
import { CAMPAIGN_SCHEDULER_QUEUE, createQueue } from "~/server/queue";
import {
  withWorkerBindings,
  type WorkerBindings,
} from "~/server/worker-bindings";

/**
 * The campaign scheduler's tick, as a self-rescheduling Durable Object alarm.
 *
 * Cron Triggers floor at one minute and this used to tick every 1.5 seconds, so
 * §4.2 made it an alarm — `setAlarm()` is millisecond-precision. The tick is
 * now 30 seconds rather than 1.5, and that is the measured decision, not a
 * compromise: a Durable Object hibernates after 10 seconds of inactivity, so an
 * object re-arming every 1.5s never leaves memory, while one re-arming every
 * 30s is evicted between every alarm (`prototypes/do-hibernation`). Whether
 * resident-but-eligible time is *billed* is a reading of Cloudflare's pricing
 * wording that cannot be settled without an account, and the two readings are
 * 30x apart. A 30s tick is in the cheap branch under either.
 *
 * **The alarm does no database work.** It enqueues, and a Queues consumer
 * sweeps. That is §4.2's other constraint and it is not stylistic: a held-open
 * outbound socket makes a Durable Object permanently ineligible for
 * hibernation — measured, silently, with no error anywhere — and a pooled
 * Postgres connection through Hyperdrive is exactly that. Sending to a queue
 * binding completes within the alarm and leaves nothing behind.
 *
 * For the same reason there is no `setTimeout`, no `setInterval` and no
 * unawaited `fetch()` anywhere in this file. Each was measured to pin the
 * object on its own.
 */

const TICK_ALARM_MS = SCHEDULER_TICK_MS;

/**
 * Minted per instance, so a local run can tell residency from eviction the way
 * the prototype did: an alarm handled by an instance that has handled no
 * earlier alarm means the object was evicted and rebuilt in between.
 */
let instanceCount = 0;

export class CampaignScheduler extends DurableObject<WorkerBindings> {
  private readonly instanceId = `i${++instanceCount}-${Date.now()}`;
  private alarmsHandled = 0;

  /**
   * Arms the tick if it is not already armed.
   *
   * Called from a low-frequency Cron Trigger rather than at startup, because a
   * Worker has no startup. An alarm, once set, is durable and survives eviction
   * and deploys — but something has to set the first one, and if an alarm
   * handler ever fails permanently the chain simply stops with nothing to say
   * so. A poke every ten minutes is what makes this self-healing.
   */
  async ensureRunning(): Promise<{ armed: boolean }> {
    if ((await this.ctx.storage.getAlarm()) !== null) {
      return { armed: false };
    }

    await this.ctx.storage.setAlarm(Date.now());
    return { armed: true };
  }

  async alarm(): Promise<void> {
    this.alarmsHandled += 1;

    await withWorkerBindings(this.env, () =>
      withTraceContext(newTraceContext(), async () => {
        logger.debug(
          {
            instanceId: this.instanceId,
            alarmsHandledByThisInstance: this.alarmsHandled,
          },
          "[CampaignScheduler]: Tick",
        );

        try {
          await createQueue<{ tickAt: number }>(CAMPAIGN_SCHEDULER_QUEUE).enqueue(
            "tick",
            { tickAt: Date.now() },
          );
        } catch (error) {
          // Never rethrown. A failed alarm handler is retried by Cloudflare and
          // would double-tick; worse, if it kept failing the chain would stop.
          // Losing one tick costs 30 seconds of scheduling latency.
          logger.error(
            { err: error, traceparent: currentTraceparent() },
            "[CampaignScheduler]: Failed to enqueue tick",
          );
        }
      }),
    );

    // Re-armed last and unconditionally, so the chain cannot be broken by a
    // failure above.
    await this.ctx.storage.setAlarm(Date.now() + TICK_ALARM_MS);
  }
}
