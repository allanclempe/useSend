import {db} from "~/server/db";
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

            const result = await db.email.updateMany({
                where: {
                    createdAt: {lt: cutoffDate},
                    OR: [
                        {text: {not: null}},
                        {html: {not: null}},
                        {attachments: {not: null}},
                        {headers: {not: null}},
                    ],
                },
                data: {
                    text: null,
                    html: null,
                    attachments: null,
                    headers: null,
                },
            });

            logger.info(`[Cleanup] Emails cleaned: ${result.count}`);
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
