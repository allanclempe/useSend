import { asc, gt } from "drizzle-orm";
import { drizzleDb, schema } from "~/server/drizzle";
import { logger } from "~/server/logger/log";
import { CRON_TRIGGERS } from "~/server/queue/cron-registry";
import {
  createQueue,
  createWorker,
  DOMAIN_VERIFICATION_QUEUE,
} from "~/server/queue";
import {
  isDomainVerificationDue,
  refreshDomainVerification,
} from "~/server/service/domain-service";

let initialized = false;

/**
 * Domains looked at per invocation.
 *
 * This is the loop §4.3 named as the worst of the three, and the limit that
 * bites is the **subrequest cap**, not CPU: `refreshDomainVerification` makes
 * several AWS calls per domain, and a Worker invocation gets 1000 subrequests
 * total. Twenty-five domains leaves generous headroom for the slowest case,
 * where every domain in the page is due.
 *
 * It used to select every domain in the table and walk it in one job, which
 * worked under Node and cannot work here at any size an install might reach.
 */
const PAGE_SIZE = 25;

type DomainVerificationJob = { cursor?: number };

/**
 * Verifies one page of domains and reports where the next page starts.
 *
 * `Domain.id` is the cursor rather than `createdAt`: it is unique, so the
 * keyset is a total order and a page boundary cannot repeat or skip a row. The
 * old ordering was `createdAt asc`, which is not unique.
 */
export async function runDueDomainVerifications(
  options: { cursor?: number; limit?: number } = {},
) {
  const limit = options.limit ?? PAGE_SIZE;

  const domains = await drizzleDb
    .select()
    .from(schema.domain)
    .where(
      options.cursor !== undefined
        ? gt(schema.domain.id, options.cursor)
        : undefined,
    )
    .orderBy(asc(schema.domain.id))
    .limit(limit);

  for (const domain of domains) {
    try {
      const isDue = await isDomainVerificationDue(domain);
      if (!isDue) {
        continue;
      }

      await refreshDomainVerification(domain);
    } catch (error) {
      logger.error(
        { err: error, domainId: domain.id },
        "[DomainVerificationJob]: Failed to refresh domain verification",
      );
    }
  }

  // A short page means the end of the table. A full one means there is more,
  // and the caller enqueues a continuation from here.
  const nextCursor =
    domains.length === limit ? domains[domains.length - 1]?.id : undefined;

  return { processed: domains.length, nextCursor };
}

export async function initDomainVerificationJob() {
  if (initialized) {
    return;
  }

  const domainVerificationQueue = createQueue<DomainVerificationJob>(
    DOMAIN_VERIFICATION_QUEUE,
  );

  /**
   * One handler, two entry points.
   *
   * The hourly Cron Trigger invokes it with no cursor, which is page one; every
   * page after that arrives as a queue message the handler enqueued itself.
   * That is §4.3's "process a bounded page, enqueue a continuation with a
   * cursor", and it is why `domain-verification` is both a cron name and a
   * queue — see `CRON_CONTINUED_QUEUES`.
   */
  createWorker<DomainVerificationJob>(
    DOMAIN_VERIFICATION_QUEUE,
    async (job) => {
      const { processed, nextCursor } = await runDueDomainVerifications({
        cursor: job.data?.cursor,
      });

      logger.info(
        { processed, cursor: job.data?.cursor, nextCursor },
        "[DomainVerificationJob]: Verified a page of domains",
      );

      if (nextCursor !== undefined) {
        await domainVerificationQueue.enqueue("continue", {
          cursor: nextCursor,
        });
      }
    },
    {
      concurrency: 1,
      onFailed: (job, err) => {
        logger.error(
          { err, jobId: job?.id },
          "[DomainVerificationJob]: Job failed",
        );
      },
    },
  );

  await domainVerificationQueue.schedule("domain-verification-hourly", {
    cron: CRON_TRIGGERS[DOMAIN_VERIFICATION_QUEUE],
    tz: "UTC",
  });

  initialized = true;
}
