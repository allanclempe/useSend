import {env} from "~/env";

export function isCloud() {
    return env.NEXT_PUBLIC_IS_CLOUD;
}

export function isSelfHosted() {
    return !isCloud();
}

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
