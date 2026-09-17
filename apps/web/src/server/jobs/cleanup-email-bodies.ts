import {and, isNotNull, lt, or} from "drizzle-orm";
import {drizzleDb, schema} from "~/server/drizzle";
import {withUpdatedAt} from "~/server/drizzle/touch";
import {logger} from "../logger/log";
import {createQueue, createWorker} from "../queue";
import {env} from "~/env";
import {isSelfHosted, isEmailCleanupEnabled} from "~/utils/common";

const CLEANUP_QUEUE_NAME = "cleanup-email-bodies";

const CLEANUP_CRON = "0 0 * * *"; // default: midnight UTC

// Only initialize if self hosted and cleanup enabled
if (isSelfHosted() && isEmailCleanupEnabled()) {
    const CLEANUP_DAYS = env.EMAIL_CLEANUP_DAYS!;

    /**
     * Initialize Queue
     */
    const cleanupQueue = createQueue(CLEANUP_QUEUE_NAME);

    createWorker(
        CLEANUP_QUEUE_NAME,
        async () => {
            logger.info(`[Cleanup] Starting cleanup for emails older than ${CLEANUP_DAYS} days...`);

            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - CLEANUP_DAYS);

            const cleaned = await drizzleDb
                .update(schema.email)
                .set(
                    withUpdatedAt({
                        text: null,
                        html: null,
                        attachments: null,
                        headers: null,
                    })
                )
                .where(
                    and(
                        lt(schema.email.createdAt, cutoffDate),
                        // Skip rows that are already stripped.
                        or(
                            isNotNull(schema.email.text),
                            isNotNull(schema.email.html),
                            isNotNull(schema.email.attachments),
                            isNotNull(schema.email.headers)
                        )
                    )
                );

            // `.count` rather than `.returning()`: we only count the rows, and
            // `.returning()` buffers every id into a JS array to get there.
            logger.info(`[Cleanup] Emails cleaned: ${cleaned.count}`);
        },
        {
            onCompleted: (job) => {
                logger.info({jobId: job.id}, ` Email Body cleanup job completed`);
            },
            onFailed: (job, err) => {
                logger.error({err, jobId: job?.id}, `Email Body cleanup job failed`);
            },
        }
    );

    await cleanupQueue.schedule("scheduled-email-cleanup", {
        cron: CLEANUP_CRON,
        tz: "UTC",
    });
}
