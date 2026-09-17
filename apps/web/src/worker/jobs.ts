import { initDomainVerificationJob } from "~/server/jobs/domain-verification-job";
import { initEmailEventCleanupJob } from "~/server/jobs/email-event-cleanup-job";
import { initWebhookCleanupJob } from "~/server/jobs/webhook-cleanup-job";

/**
 * These two register at module scope, behind their own feature gates, so the
 * import *is* the registration. `process.env` is populated before module
 * evaluation under `nodejs_compat`, which is what makes that safe here — see
 * §8's verified list.
 */
import "~/server/jobs/cleanup-email-bodies";
import "~/server/jobs/usage-job";

/**
 * The Worker's equivalent of `src/instrumentation.ts`.
 *
 * Next.js calls `register()` once at server startup and the BullMQ workers it
 * creates live for the lifetime of the process. A Worker has no startup and no
 * process: handlers are registered per isolate, and an isolate exists only as
 * long as it is serving something. So this runs on the way into a scheduled
 * invocation instead, and is idempotent because an isolate can serve many.
 *
 * Note what is *not* here. `EmailQueueService.init()` reads `SesSetting` rows
 * to size a worker per region, and on Cloudflare that sizing is deploy-time
 * config (§4.1); `CampaignSchedulerService.start()` registers a 1.5s repeatable
 * job, which is a Durable Object alarm here and not a Cron Trigger (§4.2).
 */
let registered = false;

export async function registerScheduledJobs(): Promise<void> {
  if (registered) {
    return;
  }

  // Each of these is a no-op when its feature is off, and each is idempotent.
  await initDomainVerificationJob();
  await initWebhookCleanupJob();
  await initEmailEventCleanupJob();

  registered = true;
}
