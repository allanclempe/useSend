/**
 * Every Cron Trigger this Worker declares.
 *
 * Four of the eight BullMQ queues carry a recurring job and never a real
 * message; a fifth (`email-event-cleanup`) was added the same way. On BullMQ a
 * schedule is created at runtime by `queue.schedule(id, { cron })`, so the job
 * module owned the expression. On Cloudflare a schedule is a Cron Trigger in
 * `wrangler.jsonc` — deploy-time config, exactly like a queue binding — and a
 * cron the deployment does not declare simply never fires.
 *
 * So the expression moves here and the job modules import it. That is not
 * indirection for its own sake: it makes the job module and `wrangler.jsonc`
 * physically unable to disagree, and `cron-registry.unit.test.ts` checks the
 * remaining half, that `wrangler.jsonc` declares exactly this set.
 *
 * The key is the logical queue name, which is also the key `createWorker`
 * registers a handler under — that is what lets `controller.cron` find the
 * function to run. See references/serverless-migration.md §2.
 */

export const CRON_TRIGGERS = {
  /** 1:1 with today's pattern. Chunked against the subrequest cap in §4.3. */
  "domain-verification": "0 * * * *",
  /** Daily at 03:00 UTC. */
  "webhook-cleanup": "0 3 * * *",
  /** 00:00 and 12:00 UTC. Cloud only — there is no Stripe to report to otherwise. */
  "usage-reporting": "0 */12 * * *",
  /** Midnight UTC. Self-hosted only, and only when a retention window is set. */
  "cleanup-email-bodies": "0 0 * * *",
  /** 00:30 UTC, staggered off the email-body cleanup so they never overlap. */
  "email-event-cleanup": "30 0 * * *",
} as const satisfies Record<string, string>;

export type CronJobName = keyof typeof CRON_TRIGGERS;

/** Every distinct expression, which is what `triggers.crons` has to contain. */
export const CRON_EXPRESSIONS: readonly string[] = [
  ...new Set(Object.values(CRON_TRIGGERS)),
];

/**
 * Which job a firing cron belongs to.
 *
 * Two jobs sharing one expression would be ambiguous here, and Cloudflare gives
 * the handler nothing but the expression to go on — so the schedules above are
 * deliberately all distinct, and this returns the first match rather than
 * pretending to handle a case the config does not allow.
 */
export function cronJobFor(cron: string): CronJobName | undefined {
  return (Object.keys(CRON_TRIGGERS) as CronJobName[]).find(
    (name) => CRON_TRIGGERS[name] === cron,
  );
}

export function isDeclaredCron(cron: string): boolean {
  return CRON_EXPRESSIONS.includes(cron);
}
