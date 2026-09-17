import {
  CAMPAIGN_SCHEDULER_QUEUE,
  createQueue,
  createWorker,
  createWorkerHandler,
  type TeamJob,
} from "../queue";
import { CampaignBatchService } from "../service/campaign-service";
import { db } from "../db";
import { logger } from "../logger/log";

const SCHEDULER_TICK_MS = 1500;

type SchedulerJob = TeamJob<{}>;

export class CampaignSchedulerService {
  private static schedulerQueue = createQueue<SchedulerJob["data"]>(
    CAMPAIGN_SCHEDULER_QUEUE
  );

  static worker = createWorker(
    CAMPAIGN_SCHEDULER_QUEUE,
    createWorkerHandler(async (_job: SchedulerJob) => {
      try {
        const now = new Date();
        const campaigns = await db.campaign.findMany({
          where: {
            status: { in: ["SCHEDULED", "RUNNING"] },
            OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }],
          },
          select: {
            id: true,
            teamId: true,
            lastSentAt: true,
            batchWindowMinutes: true,
          },
        });

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

  static async start() {
    try {
      await this.schedulerQueue.schedule("campaign-scheduler", {
        every: SCHEDULER_TICK_MS,
      });
    } catch (err) {
      // Registering the same recurring job is idempotent; ignore exists errors
      logger.info({ err }, "Scheduler start attempted");
    }
  }
}
