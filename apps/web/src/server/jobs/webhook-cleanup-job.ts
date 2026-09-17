import { subDays } from "date-fns";
import { lt } from "drizzle-orm";
import { env } from "~/env";
import { drizzleDb, schema } from "~/server/drizzle";
import { isWebhookCallRetentionEnabled } from "~/utils/common";
import { createQueue, createWorker, WEBHOOK_CLEANUP_QUEUE } from "../queue";
import { CRON_TRIGGERS } from "../queue/cron-registry";
import { logger } from "../logger/log";

/**
 * This job previously ran its `createWorker` and `schedule` at module scope,
 * but nothing ever imported the module -- so the worker was never created and
 * `WebhookCall` grew without bound. It is now initialised from
 * `instrumentation.ts` like every other job.
 *
 * `WEBHOOK_CALL_RETENTION_DAYS` defaults back to 30 days. It was briefly opt-in
 * so that wiring up a job which deletes rows would not quietly start deleting
 * them at an existing install on upgrade -- a concern that only applies to
 * installs that exist. Unbounded by default is the worse of the two failures:
 * the log is a debugging aid nobody reads at 31 days, and it grows with every
 * webhook a team subscribes to. Set the variable to 0 to keep it indefinitely.
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

  const retentionDays = env.WEBHOOK_CALL_RETENTION_DAYS;
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

  await webhookCleanupQueue.schedule("webhook-cleanup-daily", {
    cron: CRON_TRIGGERS[WEBHOOK_CLEANUP_QUEUE],
    tz: "UTC",
  });

  initialized = true;
}
