/* eslint-disable no-unused-vars -- parameter names in type signatures */

import { createDrizzleClient, withDrizzleClient } from "~/server/drizzle";
import { logger } from "~/server/logger/log";
import { startTrace, withTraceContext } from "~/server/logger/trace-context";
import { cronJobFor } from "~/server/queue/cron-registry";
import { registeredHandler } from "~/server/queue/workers-driver";
import {
  withWorkerBindings,
  type WorkerBindings,
} from "~/server/worker-bindings";
import { registerScheduledJobs } from "./jobs";

/**
 * The `scheduled()` export: every recurring job that used to be a BullMQ
 * repeatable job.
 *
 * `domain-verification`, `webhook-cleanup`, `usage-reporting`,
 * `cleanup-email-bodies` and `email-event-cleanup` were queues only in the
 * sense that BullMQ needs a queue to hang a schedule on — each carries one
 * recurring job and never a real message. On Cloudflare that is a Cron Trigger,
 * and the queue disappears.
 *
 * The 1.5s campaign scheduler is deliberately not here: Cron Triggers floor at
 * one minute, which is why §4.2 makes it a Durable Object alarm instead.
 *
 * See references/serverless-migration.md §2.
 */
export async function handleScheduled(
  controller: { cron: string; scheduledTime: number },
  env: WorkerBindings,
  ctx: { waitUntil: (promise: Promise<unknown>) => void },
): Promise<void> {
  const job = cronJobFor(controller.cron);

  if (!job) {
    // Only reachable if `wrangler.jsonc` declares a trigger `cron-registry.ts`
    // does not, which `cron-registry.unit.test.ts` exists to prevent.
    logger.error(
      { cron: controller.cron },
      "Cron fired for an expression no job claims",
    );
    return;
  }

  await registerScheduledJobs();

  const handler = registeredHandler(job);

  if (!handler) {
    // Not an error: three of these jobs are opt-in (`EMAIL_CLEANUP_DAYS`,
    // `EMAIL_EVENT_RETENTION_DAYS`, cloud-only usage reporting) and register no
    // handler when their feature is off. The trigger still fires, because
    // triggers are static config and cannot be conditional.
    logger.info(
      { cron: controller.cron, job },
      "Cron fired for a job that is not enabled in this deployment",
    );
    return;
  }

  const { db, close } = createDrizzleClient(env.HYPERDRIVE.connectionString, 1);

  try {
    await withWorkerBindings(env, () =>
      withDrizzleClient(db, () =>
        // A cron is the start of a unit of work, so it starts a trace the same
        // way an HTTP handler does. There is no inbound `traceparent` to
        // continue — nothing called us.
        withTraceContext(startTrace(null), async () => {
          logger.info({ cron: controller.cron, job }, "Cron job starting");

          try {
            await handler({
              id: `${job}-${controller.scheduledTime}`,
              name: job,
              data: {},
              attemptsMade: 0,
            } as never);

            logger.info({ cron: controller.cron, job }, "Cron job finished");
          } catch (error) {
            // Nothing retries a Cron Trigger — there is no message and no
            // attempt count. The next tick is the retry, so the job has to be
            // safe to skip once, and a failure has to be visible.
            logger.error(
              { err: error, cron: controller.cron, job },
              "Cron job failed; it will not be retried before its next tick",
            );
          }
        }),
      ),
    );
  } finally {
    ctx.waitUntil(close());
  }
}
