import {
  CAMPAIGN_SCHEDULER_QUEUE,
  createWorker,
  createWorkerHandler,
  type TeamJob,
} from "../queue";
import { CampaignBatchService } from "../service/campaign-service";
import { sweepDueScheduledEmails } from "../service/scheduled-email-sweeper";
import { and, inArray, isNull, lte, or } from "drizzle-orm";
import { drizzleDb, schema } from "../drizzle";
import { logger } from "../logger/log";
import { getWorkerBindings } from "../worker-bindings";

/**
 * 30 seconds, down from 1.5 -- and the change is the point, not a side effect
 * of the port.
 *
 * A Durable Object hibernates after 10 seconds of inactivity, so a tick that
 * re-arms every 1.5s never leaves memory: measured, one instance handled all 40
 * alarms of a 60s run (`prototypes/do-hibernation`). At any interval past 10s
 * the object is evicted between every alarm. Whether resident-but-eligible time
 * is *billed* is a reading of Cloudflare's pricing wording that cannot be
 * settled without an account, and the two readings are 30x apart -- 83% of the
 * entire included allowance at zero email volume, or nothing. A 30s tick is in
 * the cheap branch under either reading, and it also cuts alarm invocations
 * from 173% of the included DO requests to 8.6% (§12).
 *
 * The cost is up to 30s of scheduling jitter, which is invisible against
 * `batchWindowMinutes` (minutes) and scheduled sends (minute precision).
 *
 */
export const SCHEDULER_TICK_MS = 30_000;

type SchedulerJob = TeamJob<{}>;

export class CampaignSchedulerService {
  static worker = createWorker(
    CAMPAIGN_SCHEDULER_QUEUE,
    createWorkerHandler(async (_job: SchedulerJob) => {
      // Scheduled emails ride the same tick rather than getting a mechanism of
      // their own — §4.5 extends this sweep rather than inventing a second one.
      // Its own try/catch so a failure here cannot stop campaigns, and the
      // reverse.
      try {
        await sweepDueScheduledEmails();
      } catch (err) {
        logger.error({ err }, "Scheduled email sweep failed");
      }

      try {
        const now = new Date();
        const campaigns = await drizzleDb
          .select({
            id: schema.campaign.id,
            teamId: schema.campaign.teamId,
            lastSentAt: schema.campaign.lastSentAt,
            batchWindowMinutes: schema.campaign.batchWindowMinutes,
          })
          .from(schema.campaign)
          .where(
            and(
              inArray(schema.campaign.status, ["SCHEDULED", "RUNNING"]),
              or(
                isNull(schema.campaign.scheduledAt),
                lte(schema.campaign.scheduledAt, now),
              ),
            ),
          );

        const enqueuePromises: Promise<any>[] = [];
        for (const c of campaigns) {
          const windowMin = c.batchWindowMinutes ?? 0;
          if (windowMin > 0 && c.lastSentAt) {
            const elapsedMs = now.getTime() - new Date(c.lastSentAt).getTime();
            const windowMs = windowMin * 60 * 1000;
            if (elapsedMs < windowMs) {
              const remainingMs = windowMs - elapsedMs;
              logger.debug(
                { campaignId: c.id, remainingMs, windowMs },
                "Skip queueing batch; window not elapsed"
              );
              continue;
            }
          }
          enqueuePromises.push(
            CampaignBatchService.queueBatch({
              campaignId: c.id,
              teamId: c.teamId,
            }).catch((err) => {
              logger.error(
                { err, campaignId: c.id },
                "Failed to enqueue campaign batch"
              );
            })
          );
        }

        if (enqueuePromises.length > 0) {
          const results = await Promise.allSettled(enqueuePromises);
          const rejected = results.filter(
            (r) => r.status === "rejected"
          ).length;
          const fulfilled = results.length - rejected;
          logger.debug(
            { total: results.length, fulfilled, rejected },
            "Scheduler enqueue summary"
          );
        }
      } catch (err) {
        logger.error({ err }, "Campaign scheduler tick failed");
      }
    }),
    { concurrency: 1 }
  );

  /**
   * Arms the tick.
   *
   * It is the `CAMPAIGN_SCHEDULER` Durable Object's alarm: there is no
   * repeatable job to register, and `schedule()` would rightly refuse a
   * sub-minute interval as something no Cron Trigger can express. The BullMQ
   * repeatable job this fell back to is gone with Redis (#12).
   */
  static async start() {
    const scheduler = getWorkerBindings()?.CAMPAIGN_SCHEDULER as
      | CampaignSchedulerNamespace
      | undefined;

    if (!scheduler) {
      throw new Error(
        "No CAMPAIGN_SCHEDULER Durable Object binding. Bindings are only " +
          "readable inside a handler, so this is either a call made outside " +
          "`withWorkerBindings` or a missing binding in wrangler.jsonc.",
      );
    }

    // One object, one name. The scheduler is a singleton by construction:
    // two of them would double every campaign batch.
    const stub = scheduler.get(scheduler.idFromName(SCHEDULER_OBJECT_NAME));
    const { armed } = await stub.ensureRunning();

    if (armed) {
      logger.info("[CampaignScheduler]: Armed the tick alarm");
    }
  }
}

/** The single Durable Object id the scheduler lives on. */
export const SCHEDULER_OBJECT_NAME = "campaign-scheduler";

/* eslint-disable no-unused-vars -- parameter names in a type signature */
/**
 * Typed structurally for the same reason the webhook dispatcher is: the class
 * imports `cloudflare:workers`, and this module is reachable from Next.js.
 */
type CampaignSchedulerNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { ensureRunning(): Promise<{ armed: boolean }> };
};
/* eslint-enable no-unused-vars */
