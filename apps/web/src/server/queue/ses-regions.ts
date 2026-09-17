/**
 * The SES regions this deployment can send from.
 *
 * On BullMQ this list did not exist: `EmailQueueService.initializeQueue` was
 * called at runtime with whatever region a user typed into the admin UI, and
 * BullMQ created the queue on demand. Cloudflare Queues cannot do that — a
 * queue and its consumer are deploy-time configuration in `wrangler.jsonc` and
 * a binding that was not declared is simply absent from `env`.
 *
 * So **adding an SES region is now a deploy**, which is a product behaviour
 * change, not an implementation detail (§4.1). Adding one here and running
 * `pnpm --filter=web queues:print` to refresh `wrangler.jsonc` is the whole
 * change; idle queues cost nothing, so the list can be as long as is useful.
 *
 * **The contents of this list are a product decision.** What is below is the
 * set AWS documents for SES in commercial regions minus the opt-in ones, which
 * is a defensible default and not a researched answer about which regions
 * anyone actually sends from.
 */
export const SUPPORTED_SES_REGIONS: readonly string[] = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "ca-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-central-1",
  "eu-north-1",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "sa-east-1",
];

/** Transactional and marketing are separate queues so quotas can be split. */
export const SEND_QUEUE_SUFFIXES = ["transaction", "marketing"] as const;

export type SendQueueSuffix = (typeof SEND_QUEUE_SUFFIXES)[number];

/** The logical queue name `EmailQueueService` uses. Unchanged from BullMQ. */
export function sendQueueName(region: string, suffix: SendQueueSuffix): string {
  return `${region}-${suffix}`;
}

export function isSupportedSesRegion(region: string): boolean {
  return SUPPORTED_SES_REGIONS.includes(region);
}

/**
 * Consumer concurrency, and the reason it is a constant rather than the team's
 * configured `sesEmailRateLimit`.
 *
 * `max_concurrency` is deploy-time config; `sesEmailRateLimit` is a column in
 * the database that an admin edits in the UI. Decision 1 in §11 settled this:
 * the rate limit no longer takes effect until a deploy, and the settings UI
 * says so. What is left in code is a ceiling that no region's quota should
 * exceed, not a per-region tuning knob.
 *
 * Cloudflare autoscales up to this; it does not hold it open.
 */
export const SEND_QUEUE_MAX_CONCURRENCY = 20;
