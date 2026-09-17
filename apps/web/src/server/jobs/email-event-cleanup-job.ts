import { lt } from "drizzle-orm";
import { env } from "~/env";
import { drizzleDb, schema } from "~/server/drizzle";
import { isEmailEventRetentionEnabled } from "~/utils/common";
import { logger } from "../logger/log";
import { createQueue, createWorker, EMAIL_EVENT_CLEANUP_QUEUE } from "../queue";

const CLEANUP_CRON = "30 0 * * *"; // daily, staggered off the email-body cleanup

/**
 * `EmailEvent` growth is monotonic and unbounded: a typical marketing email
 * produces roughly 3.5 rows, so at 1M emails/month the table gains ~3.5M rows a
 * month and never gives any back.
 *
 * Off unless `EMAIL_EVENT_RETENTION_DAYS` is set, matching `EMAIL_CLEANUP_DAYS`
 * -- an upgrade should never start deleting anyone's data on its own.
 *
 * Note the interaction with engagement dedup in `ses-hook-parser`: it decides
 * whether an Open/Click has already been counted by looking for an existing
 * `EmailEvent` row. Deleting one lets a *later* event for the same email be
 * counted a second time. Set the window well beyond the point where SES still
 * reports engagement (days, not months) and this cannot bite.
 */
let initialized = false;

/** Deletes every `EmailEvent` older than `retentionDays`; returns how many. */
export async function deleteExpiredEmailEvents(retentionDays: number) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  const deleted = await drizzleDb
    .delete(schema.emailEvent)
    .where(lt(schema.emailEvent.createdAt, cutoff))
    .returning({ id: schema.emailEvent.id });

  logger.info(
    { deleted: deleted.length, cutoff: cutoff.toISOString() },
    "[EmailEventCleanupJob]: Deleted old email events",
  );

  return deleted.length;
}

export async function initEmailEventCleanupJob() {
  if (initialized || !isEmailEventRetentionEnabled()) {
    return;
  }

  const retentionDays = env.EMAIL_EVENT_RETENTION_DAYS!;
  const cleanupQueue = createQueue(EMAIL_EVENT_CLEANUP_QUEUE);

  createWorker(
    EMAIL_EVENT_CLEANUP_QUEUE,
    async () => {
      await deleteExpiredEmailEvents(retentionDays);
    },
    {
      concurrency: 1,
      onCompleted: (job) => {
        logger.info({ jobId: job.id }, "[EmailEventCleanupJob]: Job completed");
      },
      onFailed: (job, err) => {
        logger.error(
          { err, jobId: job?.id },
          "[EmailEventCleanupJob]: Job failed",
        );
      },
    },
  );

  await cleanupQueue.schedule("email-event-cleanup-daily", {
    cron: CLEANUP_CRON,
    tz: "UTC",
  });

  initialized = true;
}
