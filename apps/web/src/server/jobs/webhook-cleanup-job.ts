import { subDays } from "date-fns";
import { lt } from "drizzle-orm";
import { env } from "~/env";
import { drizzleDb, schema } from "~/server/drizzle";
import { isWebhookCallRetentionEnabled } from "~/utils/common";
import { createQueue, createWorker, WEBHOOK_CLEANUP_QUEUE } from "../queue";
import { logger } from "../logger/log";

/**
 * This job previously ran its `createWorker` and `schedule` at module scope,
 * but nothing ever imported the module -- so the worker was never created and
 * `WebhookCall` grew without bound. It is now initialised from
 * `instrumentation.ts` like every other job.
 *
 * Retention is opt-in via `WEBHOOK_CALL_RETENTION_DAYS` rather than the 30 days
 * that used to be hardcoded here: wiring up a job that deletes rows should not
 * quietly start deleting them on upgrade. 30 is still a sensible value to set.
 */
let initialized = false;

/** Deletes every `WebhookCall` older than `retentionDays`; returns how many. */
export async function deleteExpiredWebhookCalls(retentionDays: number) {
  const cutoff = subDays(new Date(), retentionDays);
  // `.count` rather than `.returning()`: we only ever count the deleted rows,
  // and `.returning()` buffers every id into a JS array to get there.
  const deleted = await drizzleDb
    .delete(schema.webhookCall)
    .where(lt(schema.webhookCall.createdAt, cutoff));

  logger.info(
    { deleted: deleted.count, cutoff: cutoff.toISOString() },
    "[WebhookCleanupJob]: Deleted old webhook calls",
  );

  return deleted.count;
}

export async function initWebhookCleanupJob() {
  if (initialized || !isWebhookCallRetentionEnabled()) {
    return;
  }

  const retentionDays = env.WEBHOOK_CALL_RETENTION_DAYS!;
  const webhookCleanupQueue = createQueue(WEBHOOK_CLEANUP_QUEUE);

  createWorker(
    WEBHOOK_CLEANUP_QUEUE,
    async () => {
      await deleteExpiredWebhookCalls(retentionDays);
    },
    {
      concurrency: 1,
      onCompleted: (job) => {
        logger.info({ jobId: job.id }, "[WebhookCleanupJob]: Job completed");
      },
      onFailed: (job, err) => {
        logger.error({ err, jobId: job?.id }, "[WebhookCleanupJob]: Job failed");
      },
    },
  );

  // daily at 03:00 UTC
  await webhookCleanupQueue.schedule("webhook-cleanup-daily", {
    cron: "0 3 * * *",
    tz: "UTC",
  });

  initialized = true;
}
