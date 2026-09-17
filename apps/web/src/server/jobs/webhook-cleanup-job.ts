import { subDays } from "date-fns";
import { db } from "~/server/db";
import { createQueue, createWorker, WEBHOOK_CLEANUP_QUEUE } from "../queue";
import { logger } from "../logger/log";

const WEBHOOK_RETENTION_DAYS = 30;

const webhookCleanupQueue = createQueue(WEBHOOK_CLEANUP_QUEUE);

createWorker(
  WEBHOOK_CLEANUP_QUEUE,
  async () => {
    const cutoff = subDays(new Date(), WEBHOOK_RETENTION_DAYS);
    const result = await db.webhookCall.deleteMany({
      where: {
        createdAt: {
          lt: cutoff,
        },
      },
    });

    logger.info(
      { deleted: result.count, cutoff: cutoff.toISOString() },
      "[WebhookCleanupJob]: Deleted old webhook calls",
    );
  },
  {
    onCompleted: (job) => {
      logger.info({ jobId: job.id }, "[WebhookCleanupJob]: Job completed");
    },
    onFailed: (job, err) => {
      logger.error({ err, jobId: job?.id }, "[WebhookCleanupJob]: Job failed");
    },
  }
);

// daily at 03:00 UTC
await webhookCleanupQueue.schedule("webhook-cleanup-daily", {
  cron: "0 3 * * *",
  tz: "UTC",
});
