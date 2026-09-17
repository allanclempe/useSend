import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import { drizzleDb, schema } from "../drizzle";
import { logger } from "../logger/log";
import { EmailQueueService } from "./email-queue-service";

/**
 * Scheduled emails are a database query, not a delayed queue message.
 *
 * A send with `scheduledAt` used to be enqueued immediately with a delay, and
 * rescheduling or cancelling it meant reaching back into the queue to move or
 * remove that job. Cloudflare Queues cannot do either — a queued message cannot
 * be looked up, moved or withdrawn — and it does not need to, because Postgres
 * was already the source of truth. `updateEmail` wrote `scheduledAt` to the row
 * and only *then* mutated the queue; `cancelEmail` set `CANCELLED` and only
 * then removed the job. The queue half was redundant bookkeeping, and racy:
 * a job already picked up by a worker sent regardless of what the row said.
 *
 * So a scheduled send writes its row and nothing else, and this sweeps for what
 * is due on each scheduler tick. Reschedule and cancel become plain UPDATEs.
 *
 * See references/serverless-migration.md §4.5.
 */

/**
 * Rows per tick.
 *
 * Bounded because a Worker invocation has a 1000-subrequest cap and each of
 * these costs at least one database round trip (§4.3). Anything left over is
 * picked up by the next tick 30 seconds later, and the query is ordered by
 * `scheduledAt` so the most overdue go first.
 */
const SWEEP_LIMIT = 500;

export async function sweepDueScheduledEmails(limit = SWEEP_LIMIT) {
  const now = new Date();

  const due = await drizzleDb
    .select({
      id: schema.email.id,
      teamId: schema.email.teamId,
      campaignId: schema.email.campaignId,
      region: schema.domain.region,
    })
    .from(schema.email)
    .innerJoin(schema.domain, eq(schema.domain.id, schema.email.domainId))
    .where(
      and(
        eq(schema.email.latestStatus, "SCHEDULED"),
        isNotNull(schema.email.scheduledAt),
        lte(schema.email.scheduledAt, now),
      ),
    )
    .orderBy(asc(schema.email.scheduledAt))
    .limit(limit);

  if (due.length === 0) {
    return 0;
  }

  // Grouped so one region's emails go in one `sendBatch` rather than one call
  // each. `queueBulk` does the grouping and the 100-message chunking.
  await EmailQueueService.queueBulk(
    due.map((email) => ({
      emailId: email.id,
      teamId: email.teamId,
      region: email.region,
      // A scheduled campaign email does not exist — campaign fan-out enqueues
      // directly — but deriving it is cheaper than assuming it.
      transactional: email.campaignId === null,
    })),
  );

  logger.info(
    { count: due.length },
    "[ScheduledEmailSweeper]: Enqueued due scheduled emails",
  );

  return due.length;
}
