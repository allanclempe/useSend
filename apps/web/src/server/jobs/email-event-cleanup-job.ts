import { asc, inArray, lt } from "drizzle-orm";
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

/**
 * Rows per `DELETE`. The first run on an install that has been accumulating
 * events for years has to remove everything outside the window at once; doing
 * that in a single statement holds one transaction open over tens of millions
 * of rows. Batching keeps each transaction short and lets autovacuum keep up.
 */
const DELETE_BATCH_SIZE = 10_000;

/**
 * Deletes every `EmailEvent` older than `retentionDays`; returns how many.
 *
 * `batchSize` exists so the tests can cross a batch boundary without seeding
 * ten thousand rows; callers should leave it alone.
 */
export async function deleteExpiredEmailEvents(
  retentionDays: number,
  batchSize = DELETE_BATCH_SIZE,
) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);

  let deleted = 0;

  // `.count` rather than `.returning()`: the only thing we do with the deleted
  // rows is count them, and materialising every id in the Node heap to do that
  // is how the first run runs out of memory.
  for (;;) {
    const batch = await drizzleDb
      .delete(schema.emailEvent)
      .where(
        inArray(
          schema.emailEvent.id,
          drizzleDb
            .select({ id: schema.emailEvent.id })
            .from(schema.emailEvent)
            .where(lt(schema.emailEvent.createdAt, cutoff))
            .orderBy(asc(schema.emailEvent.createdAt))
            .limit(batchSize),
        ),
      );

    deleted += batch.count;

    // A short batch means the cutoff has been reached.
    if (batch.count < batchSize) {
      break;
    }
  }

  logger.info(
    { deleted, cutoff: cutoff.toISOString() },
    "[EmailEventCleanupJob]: Deleted old email events",
  );

  return deleted;
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
