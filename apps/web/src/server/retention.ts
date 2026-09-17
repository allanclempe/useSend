import { env } from "~/env";

/**
 * Whether each of the three retention jobs is switched on.
 *
 * Server-only, because all three read variables that are not public. They were
 * in `~/utils/common` next to `isCloud()`, which is imported from components;
 * that made a module the browser has to load depend on `DATABASE_URL` being
 * readable, and the split is what keeps `~/env` out of the client bundle (#9).
 *
 * `undefined` and a non-positive count both mean "off": a retention job that
 * deletes rows should need a deliberate, positive number of days, not a
 * mistyped one.
 */
function isPositiveDayCount(days: number | undefined) {
  return days !== undefined && !isNaN(days) && days > 0;
}

export function isEmailCleanupEnabled() {
  return isPositiveDayCount(env.EMAIL_CLEANUP_DAYS);
}

export function isEmailEventRetentionEnabled() {
  return isPositiveDayCount(env.EMAIL_EVENT_RETENTION_DAYS);
}

export function isWebhookCallRetentionEnabled() {
  return isPositiveDayCount(env.WEBHOOK_CALL_RETENTION_DAYS);
}
