import { db } from "~/server/db";
import { logger } from "~/server/logger/log";
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

export async function runDueDomainVerifications() {
  const domains = await db.domain.findMany({
    orderBy: {
      createdAt: "asc",
    },
  });

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
}

export async function initDomainVerificationJob() {
  if (initialized) {
    return;
  }

  const domainVerificationQueue = createQueue(DOMAIN_VERIFICATION_QUEUE);

  createWorker(
    DOMAIN_VERIFICATION_QUEUE,
    async () => {
      await runDueDomainVerifications();
    },
    {
      concurrency: 1,
      onCompleted: (job) => {
        logger.info({ jobId: job.id }, "[DomainVerificationJob]: Job completed");
      },
      onFailed: (job, err) => {
        logger.error(
          { err, jobId: job?.id },
          "[DomainVerificationJob]: Job failed",
        );
      },
    },
  );

  await domainVerificationQueue.schedule("domain-verification-hourly", {
    cron: "0 * * * *",
    tz: "UTC",
  });

  initialized = true;
}
