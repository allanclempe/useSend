import { env } from "~/env";
import { EmailAttachment } from "~/types";
import { convert as htmlToText } from "html-to-text";
import { getConfigurationSetName } from "~/utils/ses-utils";
import { eq, sql } from "drizzle-orm";
import { drizzleDb, schema } from "../drizzle";
import { createId } from "../drizzle/id";
import { withUpdatedAt } from "../drizzle/touch";
import { sendRawEmail } from "../aws/ses";
import {
  createQueue,
  createWorker,
  createWorkerHandler,
  type Queue,
  type TeamJob,
  type Worker,
} from "../queue";
import { logger } from "../logger/log";
import { LimitService } from "./limit-service";
import { recordAcceptedSends, reverseAcceptedSend } from "./usage-service";
import { updateCampaignAnalytics } from "./campaign-analytics-service";
import { WebhookService } from "./webhook-service";
import {
  buildEmailBasePayload,
  emailStatusToEvent,
} from "./email-webhook-payload";
import { EmailStatus } from "~/types/db";
import {
  BUILT_IN_CONTACT_VARIABLES,
  replaceContactVariables,
} from "../utils/contact-variable-replacement";
// Notifications about limits are handled inside LimitService.

type QueueEmailJob = TeamJob<{
  emailId: string;
  timestamp: number;
  unsubUrl?: string;
  isBulk?: boolean;
}>;

function createQueueAndWorker(region: string, quota: number, suffix: string) {
  const queueName = `${region}-${suffix}`;

  const queue = createQueue<QueueEmailJob["data"]>(queueName);

  // TODO: Add team context to job data when queueing
  const worker = createWorker(queueName, createWorkerHandler(executeEmail), {
    concurrency: quota,
  });

  return { queue, worker };
}

export class EmailQueueService {
  private static initialized = false;
  public static transactionalQueue = new Map<
    string,
    Queue<QueueEmailJob["data"]>
  >();
  private static transactionalWorker = new Map<string, Worker>();
  public static marketingQueue = new Map<string, Queue<QueueEmailJob["data"]>>();
  private static marketingWorker = new Map<string, Worker>();

  public static initializeQueue(
    region: string,
    quota: number,
    transactionalQuotaPercentage: number
  ) {
    logger.info(
      { region },
      `[EmailQueueService]: Initializing queue for region`
    );

    const transactionalQuota = Math.floor(
      (quota * transactionalQuotaPercentage) / 100
    );
    const marketingQuota = quota - transactionalQuota;

    if (this.transactionalQueue.has(region)) {
      logger.info(
        { region, transactionalQuota },
        `[EmailQueueService]: Updating transactional quota for region`
      );
      const transactionalWorker = this.transactionalWorker.get(region);
      if (transactionalWorker) {
        transactionalWorker.concurrency =
          transactionalQuota !== 0 ? transactionalQuota : 1;
      }
    } else {
      logger.info(
        { region, transactionalQuota },
        `[EmailQueueService]: Creating transactional queue for region`
      );
      const { queue: transactionalQueue, worker: transactionalWorker } =
        createQueueAndWorker(
          region,
          transactionalQuota !== 0 ? transactionalQuota : 1,
          "transaction"
        );
      this.transactionalQueue.set(region, transactionalQueue);
      this.transactionalWorker.set(region, transactionalWorker);
    }

    if (this.marketingQueue.has(region)) {
      logger.info(
        { region, marketingQuota },
        `[EmailQueueService]: Updating marketing quota for region`
      );
      const marketingWorker = this.marketingWorker.get(region);
      if (marketingWorker) {
        marketingWorker.concurrency = marketingQuota !== 0 ? marketingQuota : 1;
      }
    } else {
      logger.info(
        { region, marketingQuota },
        `[EmailQueueService]: Creating marketing queue for region`
      );
      const { queue: marketingQueue, worker: marketingWorker } =
        createQueueAndWorker(
          region,
          marketingQuota !== 0 ? marketingQuota : 1,
          "marketing"
        );
      this.marketingQueue.set(region, marketingQueue);
      this.marketingWorker.set(region, marketingWorker);
    }
  }

  public static async queueEmail(
    emailId: string,
    teamId: number,
    region: string,
    transactional: boolean,
    unsubUrl?: string,
    delay?: number
  ) {
    if (!this.initialized) {
      await this.init();
    }
    const queue = transactional
      ? this.transactionalQueue.get(region)
      : this.marketingQueue.get(region);
    const isBulk = !transactional;
    if (!queue) {
      throw new Error(`Queue for region ${region} not found`);
    }
    await queue.enqueue(
      emailId,
      {
        emailId,
        timestamp: Date.now(),
        unsubUrl,
        isBulk,
        teamId,
      },
      { jobId: emailId, delay }
    );

    // This is where a send becomes billable. Every path -- the public API, the
    // batch endpoint, campaigns, and SMTP (which posts to the public API) --
    // reaches the queue through here or `queueBulk`, and nothing reaches SES
    // without first reaching the queue, so it is the one place that sees each
    // accepted send exactly once.
    //
    // Deliberately after the enqueue, not before: if the queue rejects the job
    // the caller gets an error and we never took the work on. `queueEmail`'s own
    // callers mark the email FAILED in that case.
    await recordAcceptedSends([emailId]);
  }

  /**
   * Efficiently queues multiple pre-defined email jobs using BullMQ's addBulk.
   * Jobs are grouped by region and type (transactional/marketing) before queuing.
   *
   * @param jobs - Array of job details to queue.
   * @returns A promise that resolves when all bulk additions are attempted.
   */
  public static async queueBulk(
    jobs: {
      emailId: string;
      teamId: number;
      region: string;
      transactional: boolean;
      unsubUrl?: string;
      delay?: number;
      timestamp?: number; // Optional: pass timestamp if needed for data
    }[]
  ): Promise<void> {
    if (jobs.length === 0) {
      logger.info("[EmailQueueService]: No jobs provided for bulk queue.");
      return;
    }

    if (!this.initialized) {
      await this.init();
    }

    logger.info(
      { count: jobs.length },
      `[EmailQueueService]: Starting bulk queue for jobs.`
    );

    // Group jobs by region and type
    const groupedJobs = jobs.reduce(
      (acc, job) => {
        const key = `${job.region}-${job.transactional ? "transactional" : "marketing"}`;
        if (!acc[key]) {
          acc[key] = {
            queue: job.transactional
              ? this.transactionalQueue.get(job.region)
              : this.marketingQueue.get(job.region),
            region: job.region,
            transactional: job.transactional,
            jobDetails: [],
          };
        }
        acc[key]?.jobDetails.push(job);
        return acc;
      },
      {} as Record<
        string,
        {
          queue: Queue<QueueEmailJob["data"]> | undefined;
          region: string;
          transactional: boolean;
          jobDetails: typeof jobs;
        }
      >
    );

    const bulkAddPromises: Promise<any>[] = [];

    for (const groupKey in groupedJobs) {
      const group = groupedJobs[groupKey];
      if (!group || !group.queue) {
        logger.error(
          { groupKey, count: group?.jobDetails?.length ?? 0 },
          `[EmailQueueService]: Queue not found for group during bulk add. Skipping jobs.`
        );
        // Optionally: handle these skipped jobs (e.g., mark corresponding emails as failed)
        continue;
      }

      const queue = group.queue;
      const isBulk = !group.transactional;
      const bulkData = group.jobDetails.map((job) => ({
        name: job.emailId, // Use emailId as job name (matches single queue logic)
        data: {
          emailId: job.emailId,
          timestamp: job.timestamp ?? Date.now(),
          unsubUrl: job.unsubUrl,
          isBulk,
          teamId: job.teamId,
        },
        options: {
          jobId: job.emailId, // Use emailId as jobId
          delay: job.delay,
        },
      }));

      logger.info(
        { count: bulkData.length, queue: queue.name },
        `[EmailQueueService]: Adding jobs to queue`
      );
      bulkAddPromises.push(
        queue
          .enqueueBulk(bulkData)
          // Counted per group, inside the chain, so a group whose enqueue failed
          // is not billed. `queueBulk` swallows that failure rather than
          // rejecting, so counting after `allSettled` would bill for emails that
          // never made it onto a queue.
          .then(() => recordAcceptedSends(bulkData.map((job) => job.data.emailId)))
          .catch((error: unknown) => {
            logger.error(
              { err: error, queue: queue.name },
              `[EmailQueueService]: Failed to add bulk jobs to queue`
            );
            // Optionally: handle bulk add failure (e.g., mark corresponding emails as failed)
          })
      );
    }

    await Promise.allSettled(bulkAddPromises);
    logger.info(
      "[EmailQueueService]: Finished processing bulk queue requests."
    );
  }

  public static async changeDelay(
    emailId: string,
    region: string,
    transactional: boolean,
    delay: number
  ) {
    if (!this.initialized) {
      await this.init();
    }
    const queue = transactional
      ? this.transactionalQueue.get(region)
      : this.marketingQueue.get(region);
    if (!queue) {
      throw new Error(`Queue for region ${region} not found`);
    }

    const job = await queue.getJob(emailId);
    if (!job) {
      throw new Error(`Job ${emailId} not found`);
    }
    await job.changeDelay(delay);
  }

  public static async chancelEmail(
    emailId: string,
    region: string,
    transactional: boolean
  ) {
    if (!this.initialized) {
      await this.init();
    }
    const queue = transactional
      ? this.transactionalQueue.get(region)
      : this.marketingQueue.get(region);
    if (!queue) {
      throw new Error(`Queue for region ${region} not found`);
    }

    const job = await queue.getJob(emailId);
    if (!job) {
      throw new Error(`Job ${emailId} not found`);
    }
    await job.remove();
  }

  public static async init() {
    const sesSettings = await drizzleDb.select().from(schema.sesSetting);
    for (const sesSetting of sesSettings) {
      this.initializeQueue(
        sesSetting.region,
        sesSetting.sesEmailRateLimit,
        sesSetting.transactionalQuota
      );
    }
    this.initialized = true;
  }
}

async function executeEmail(job: QueueEmailJob) {
  logger.info(
    { emailId: job.data.emailId, elapsed: Date.now() - job.data.timestamp },
    `[EmailQueueService]: Executing email job`
  );

  const [email] = await drizzleDb
    .select()
    .from(schema.email)
    .where(eq(schema.email.id, job.data.emailId))
    .limit(1);

  const domain = email?.domainId
    ? ((
        await drizzleDb
          .select()
          .from(schema.domain)
          .where(eq(schema.domain.id, email.domainId))
          .limit(1)
      )[0] ?? null)
    : null;

  if (!email) {
    logger.info(
      { emailId: job.data.emailId },
      `[EmailQueueService]: Email not found, skipping`
    );
    return;
  }

  const attachments: Array<EmailAttachment> = email.attachments
    ? JSON.parse(email.attachments)
    : [];

  logger.info({ domain }, `Domain`);

  const configurationSetName = await getConfigurationSetName(
    domain?.clickTracking ?? false,
    domain?.openTracking ?? false,
    domain?.region ?? env.AWS_DEFAULT_REGION
  );

  if (!configurationSetName) {
    return;
  }

  logger.info({ emailId: email.id }, `[EmailQueueService]: Sending email`);
  const unsubUrl = job.data.unsubUrl;
  const isBulk = job.data.isBulk;

  const text = email.text
    ? email.text
    : email.campaignId && email.html
      ? htmlToText(email.html)
      : undefined;
  let subject = email.subject;

  if (email.campaignId && email.contactId && subject.includes("{{")) {
    const [row] = await drizzleDb
      .select({
        contact: schema.contact,
        variables: schema.contactBook.variables,
      })
      .from(schema.contact)
      .innerJoin(
        schema.contactBook,
        eq(schema.contactBook.id, schema.contact.contactBookId),
      )
      .where(eq(schema.contact.id, email.contactId))
      .limit(1);

    if (row) {
      subject = replaceContactVariables(
        subject,
        // jsonb reads as `unknown`; the helper expects Prisma's JsonValue.
        { ...row.contact, properties: row.contact.properties ?? {} } as never,
        [
          ...BUILT_IN_CONTACT_VARIABLES,
          ...(row.variables ?? []),
        ],
      );

      if (subject !== email.subject) {
        await drizzleDb
          .update(schema.email)
          .set(withUpdatedAt({ subject }))
          .where(eq(schema.email.id, email.id));
      }
    }
  }

  let inReplyToMessageId: string | undefined = undefined;

  if (email.inReplyToId) {
    const [replyEmail] = await drizzleDb
      .select({ sesEmailId: schema.email.sesEmailId })
      .from(schema.email)
      .where(eq(schema.email.id, email.inReplyToId))
      .limit(1);

    if (replyEmail && replyEmail.sesEmailId) {
      inReplyToMessageId = replyEmail.sesEmailId;
    }
  }

  try {
    // Check limits right before sending (cloud-only)
    const limitCheck = await LimitService.checkEmailLimit(email.teamId);
    logger.info({ limitCheck }, `[EmailQueueService]: Limit check`);
    if (limitCheck.isLimitReached) {
      await drizzleDb.insert(schema.emailEvent).values({
        id: createId(),
        emailId: email.id,
        status: "FAILED" as const,
        data: {
          error: "Email sending limit reached",
          reason: limitCheck.reason,
          limit: limitCheck.limit,
        },
        teamId: email.teamId,
      });
      await drizzleDb
        .update(schema.email)
        .set(withUpdatedAt({ latestStatus: "FAILED" as const }))
        .where(eq(schema.email.id, email.id));
      // Accepted, then blocked by the team's own plan limit before it reached
      // SES. Billing for an email the quota stopped us sending would be
      // indefensible, so the acceptance is given back.
      await reverseAcceptedSend(email.id);
      return;
    }

    const customHeaders = email.headers ? JSON.parse(email.headers) : undefined;

    const messageId = await sendRawEmail({
      to: email.to,
      from: email.from,
      subject,
      replyTo: email.replyTo,
      bcc: email.bcc,
      cc: email.cc,
      text,
      html: email.html ?? undefined,
      region: domain?.region ?? env.AWS_DEFAULT_REGION,
      configurationSetName,
      attachments: attachments.length > 0 ? attachments : undefined,
      unsubUrl,
      isBulk,
      inReplyToMessageId,
      emailId: email.id,
      sesTenantId: domain?.sesTenantId,
      headers: customHeaders,
    });

    logger.info(
      { emailId: email.id, sesEmailId: messageId },
      `[EmailQueueService]: Email sent`
    );

    // Delete attachments and headers after sending the email, and record SENT in
    // the same statement. SES will not tell us -- the `Send` notification is no
    // longer subscribed -- and this is the better vantage point anyway: we have
    // the message id in hand, synchronously, with no SNS round-trip to be
    // delayed, dropped or replayed.
    await drizzleDb
      .update(schema.email)
      .set(
        withUpdatedAt({
          sesEmailId: messageId,
          text,
          attachments: null,
          headers: null,
          // Same forward-only guard `ses-hook-parser` uses, and for the same
          // reason: SES events arrive out of order, and a DELIVERED that beat
          // this update must not be rolled back to SENT. The comparison relies
          // on the enum's declaration order, where SENT sits just above QUEUED.
          latestStatus: sql`CASE
            WHEN "latestStatus" IS NULL
              OR "latestStatus" = 'SCHEDULED'::"EmailStatus"
              OR 'SENT'::"EmailStatus" > "latestStatus"
            THEN 'SENT'::"EmailStatus"
            ELSE "latestStatus"
          END`,
        }),
      )
      .where(eq(schema.email.id, email.id));

    await recordEmailSent({ ...email, sesEmailId: messageId ?? null });
  } catch (error: any) {
    await drizzleDb.insert(schema.emailEvent).values({
      id: createId(),
      emailId: email.id,
      status: "FAILED" as const,
      data: { error: error.toString() },
      teamId: email.teamId,
    });
    await drizzleDb
      .update(schema.email)
      .set(withUpdatedAt({ latestStatus: "FAILED" as const }))
      .where(eq(schema.email.id, email.id));
    // Accepted, but SES never took it. Same reasoning as the limit branch above:
    // we bill for accepted sends, not for sends we failed to make.
    await reverseAcceptedSend(email.id);
  }
}

/**
 * The bookkeeping the SES `Send` notification used to do, done at the handoff
 * instead: the `EmailEvent` row, the campaign counter and the `email.sent`
 * webhook. The `Email.latestStatus` half is folded into the caller's existing
 * UPDATE so it costs no extra round trip.
 *
 * `email.sent` is a public webhook customers subscribe to, so this is not
 * optional cleanup -- dropping the SES subscription without it would silently
 * break a published contract.
 */
async function recordEmailSent(email: typeof schema.email.$inferSelect) {
  await drizzleDb.insert(schema.emailEvent).values({
    id: createId(),
    emailId: email.id,
    status: EmailStatus.SENT,
    data: { sesEmailId: email.sesEmailId },
    teamId: email.teamId,
  });

  if (email.campaignId) {
    await updateCampaignAnalytics(email.campaignId, EmailStatus.SENT);
  }

  try {
    await WebhookService.emit(
      email.teamId,
      emailStatusToEvent(EmailStatus.SENT),
      buildEmailBasePayload({
        email,
        status: EmailStatus.SENT,
        occurredAt: new Date().toISOString(),
      }),
      { domainId: email.domainId ?? null },
    );
  } catch (error) {
    // Matches `ses-hook-parser`: a webhook that cannot be delivered must not
    // fail the send, which has already happened and cannot be undone.
    logger.error(
      { err: error, emailId: email.id },
      "[EmailQueueService]: Failed to emit email.sent webhook",
    );
  }
}
