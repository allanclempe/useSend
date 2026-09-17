import { eq, isNotNull } from "drizzle-orm";
import { drizzleDb, schema } from "~/server/drizzle";
import { getUsageDate, getUsageUnits } from "~/lib/usage";
import { sendUsageToStripe } from "~/server/billing/usage";
import { createQueue, createWorker } from "../queue";
import { CRON_TRIGGERS } from "../queue/cron-registry";
import { logger } from "../logger/log";
import { isCloud } from "~/utils/common";

const USAGE_QUEUE_NAME = "usage-reporting";

/**
 * Cloud only: this reports metered usage to Stripe, and a self-hosted install
 * has no Stripe to report to.
 *
 * The gate used to live in `instrumentation.ts`, which decided whether to
 * import this module at all. A Worker cannot do that — its Cron Triggers are
 * static config, so the trigger fires in every deployment and the module is
 * always in the bundle — so the gate moves here, where both runtimes see it.
 * With no handler registered, `scheduled()` logs that the job is not enabled
 * and returns.
 */
if (isCloud()) {
  const usageQueue = createQueue(USAGE_QUEUE_NAME);

  createWorker(
    USAGE_QUEUE_NAME,
    async () => {
      // Get all teams with stripe customer IDs
      const teams = await drizzleDb.query.team.findMany({
        where: isNotNull(schema.team.stripeCustomerId),
        with: {
          dailyEmailUsages: {
            // Get yesterday's date by subtracting 1 day from today
            where: eq(schema.dailyEmailUsage.date, getUsageDate()),
          },
        },
      });

      // Process each team
      for (const team of teams) {
        if (!team.stripeCustomerId) continue;

        const transactionUsage = team.dailyEmailUsages
          .filter((usage) => usage.type === "TRANSACTIONAL")
          .reduce((sum, usage) => sum + usage.sent, 0);

        const marketingUsage = team.dailyEmailUsages
          .filter((usage) => usage.type === "MARKETING")
          .reduce((sum, usage) => sum + usage.sent, 0);

        const totalUsage = getUsageUnits(marketingUsage, transactionUsage);

        try {
          await sendUsageToStripe(team.stripeCustomerId, totalUsage);
          logger.info(
            { teamId: team.id, date: getUsageDate(), usage: totalUsage },
            `[Usage Reporting] Reported usage for team`,
          );
        } catch (error) {
          logger.error(
            {
              err: error,
              teamId: team.id,
              message: error instanceof Error ? error.message : error,
            },
            `[Usage Reporting] Failed to report usage for team`,
          );
        }
      }
    },
    {
      onCompleted: (job) => {
        logger.info({ jobId: job.id }, `[Usage Reporting] Job completed`);
      },
      onFailed: (job, err) => {
        logger.error({ err, jobId: job?.id }, `[Usage Reporting] Job failed`);
      },
    },
  );

  await usageQueue.schedule("daily-usage-report", {
    cron: CRON_TRIGGERS[USAGE_QUEUE_NAME],
    tz: "UTC",
  });
}
