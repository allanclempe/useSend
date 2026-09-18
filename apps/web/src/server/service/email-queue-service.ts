import { env } from "~/env";
import { EmailAttachment } from "~/types";
import { convert as htmlToText } from "html-to-text";
import { getConfigurationSetName } from "~/utils/ses-utils";
import { and, eq, sql } from "drizzle-orm";
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
} from "../queue";
import {
  SEND_QUEUE_MAX_ATTEMPTS,
  SEND_QUEUE_SUFFIXES,
  sendQueueName,
  SUPPORTED_SES_REGIONS,
} from "../queue/ses-regions";
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

/**
 * Why a region can be missing, which is now a product answer rather than a bug.
 *
 * Adding an SES region in the admin UI used to be enough: BullMQ created the
 * queue on demand. Cloudflare Queues are declared in `wrangler.jsonc`, so a
 * region outside `SUPPORTED_SES_REGIONS` has no queue and no binding and cannot
 * be sent from until someone adds it to the list and deploys (§4.1).
 */
function unknownRegion(region: string): string {
  return (
    `No send queue for SES region "${region}". Cloudflare Queues are declared at deploy time, ` +
    `so a region has to be in SUPPORTED_SES_REGIONS (server/queue/ses-regions.ts) and deployed ` +
    `before it can send. Supported: ${SUPPORTED_SES_REGIONS.join(", ")}.`
  );
}

export class EmailQueueService {
  private static initialized = false;
  public static transactionalQueue = new Map<
    string,
    Queue<QueueEmailJob["data"]>
  >();
  public static marketingQueue = new Map<string, Queue<QueueEmailJob["data"]>>();

  /**
   * Records a quota change, and deliberately does nothing else.
   *
   * `max_concurrency` on a Queues consumer is deploy-time configuration, so a
   * quota edited in the admin UI is stored in the database and takes effect at
   * the next deploy (§11, decision 1). `updateSesSetting` and its UI say so.
   *
   * This used to create a queue and a BullMQ worker per region on demand, and
   * retune their concurrency in place. Neither the creation nor the retuning
   * survives: the queues, their consumers and their bindings are declared in
   * `wrangler.jsonc` for every region in `SUPPORTED_SES_REGIONS` (§4.1), and
   * `registerSupportedRegions()` below binds handles to them at module load.
   */
  public static initializeQueue(
    region: string,
    quota: number,
    transactionalQuotaPercentage: number
  ) {
    logger.info(
      { region, quota, transactionalQuotaPercentage },
      `[EmailQueueService]: Quota recorded; consumer concurrency changes at the next deploy`
    );
  }

  public static async queueEmail(
    emailId: string,
    teamId: number,
    region: string,
    transactional: boolean,
    unsubUrl?: string
  ) {
    if (!this.initialized) {
      await this.init();
    }
    const queue = transactional
      ? this.transactionalQueue.get(region)
      : this.marketingQueue.get(region);
    const isBulk = !transactional;
    if (!queue) {
      throw new Error(unknownRegion(region));
    }
    await queue.enqueue(
      emailId,
      {
        emailId,
        timestamp: Date.now(),
        unsubUrl,
        isBulk,
        teamId,
      }
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

  /*
   * `changeDelay` and `chancelEmail` used to live here. Both are deleted.
   *
   * Neither has a Cloudflare Queues equivalent -- a queued message cannot be
   * looked up, moved or withdrawn -- and neither was ever needed: Postgres was
   * already the source of truth, and the queue mutation was redundant
   * bookkeeping that could not even do its job, since a message already picked
   * up by a worker sent regardless of what the row said. `updateEmail` and
   * `cancelEmail` are plain UPDATEs now, and the claim below is what makes them
   * authoritative. See §4.5.
   */

  /**
   * Nothing to do, and nothing to read.
   *
   * It used to query `SesSetting` to learn which queues to create. The set of
   * queues is deploy-time config rather than a query result now (§4.1), so
   * `registerSupportedRegions()` has already done the work at module load —
   * which it has to, because a consumer must be registered before the first
   * message arrives, and that is earlier than the first send.
   */
  public static async init() {
    this.initialized = true;
  }

  /**
   * Builds a queue handle and registers a consumer for every supported region,
   * without reading a row.
   *
   * The set of send queues used to come from `SesSetting`: whatever region a
   * user added in the admin UI got a queue, created on demand. Cloudflare
   * cannot do that — the queue, its consumer and its binding are all declared
   * in `wrangler.jsonc` — so the set is `SUPPORTED_SES_REGIONS` and it is known
   * before any query. Doing it at module load rather than in `init()` is what
   * puts a handler behind each declared consumer before the first message
   * arrives; `init()` is lazy and runs on the first *send*, which is too late
   * for a consumer invocation.
   */
  public static registerSupportedRegions() {
    for (const region of SUPPORTED_SES_REGIONS) {
      for (const suffix of SEND_QUEUE_SUFFIXES) {
        const queueName = sendQueueName(region, suffix);
        const queue = createQueue<QueueEmailJob["data"]>(queueName);

        // Concurrency is `max_concurrency` on the consumer, which is
        // deploy-time (§11, decision 1). Passing a number here would only be
        // read by the driver's inert setter.
        createWorker(queueName, createWorkerHandler(executeEmail));

        if (suffix === "transaction") {
          this.transactionalQueue.set(region, queue);
        } else {
          this.marketingQueue.set(region, queue);
        }
      }
    }
  }
}

EmailQueueService.registerSupportedRegions();

/**
 * Takes an email out of SCHEDULED, or reports that it could not.
 *
 * This one statement is the whole idempotency story for the send path (§4.4,
 * §4.5). Cloudflare Queues are at-least-once where BullMQ was effectively
 * at-most-once per attempt, so the same message can arrive twice — most often
 * because a handler succeeded and the ack was lost — and without this that is a
 * second copy of someone's email.
 *
 * `SCHEDULED` is the only pre-send state, which is why `sendEmail` writes it
 * even for an immediate send. That makes the transition a one-way gate, and it
 * covers three things at once:
 *
 * - **duplicate delivery** — the second arrival finds the row already QUEUED
 *   and updates nothing
 * - **cancellation** — a CANCELLED row cannot be claimed, so `cancelEmail` now
 *   stops a send that is already in flight, which removing a job from a queue
 *   never could
 * - **a stale message left by a reschedule** — same mechanism
 *
 * Returns false when zero rows came back: someone else has it, or nobody
 * should. Ack the message and drop it.
 */
export async function claimEmailForSending(emailId: string): Promise<boolean> {
  const claimed = await drizzleDb
    .update(schema.email)
    .set(withUpdatedAt({ latestStatus: "QUEUED" as const }))
    .where(
      and(
        eq(schema.email.id, emailId),
        eq(schema.email.latestStatus, "SCHEDULED"),
      ),
    )
    .returning({ id: schema.email.id });

  return claimed.length > 0;
}

/**
 * Puts an unsent email back where the claim found it.
 *
 * Without this the claim would turn every retryable failure into a lost email:
 * the row is QUEUED, the redelivery cannot claim it, and it sits there forever
 * -- never sent, never FAILED, with nothing to say so. Seen for real on the
 * first local run, where `getConfigurationSetName` threw after the claim.
 *
 * The `WHERE` clause matters. Only a row still sitting in QUEUED is released:
 * anything the handler already moved on -- SENT, FAILED -- is left alone.
 */
async function releaseEmailClaim(emailId: string) {
  await drizzleDb
    .update(schema.email)
    .set(withUpdatedAt({ latestStatus: "SCHEDULED" as const }))
    .where(
      and(
        eq(schema.email.id, emailId),
        eq(schema.email.latestStatus, "QUEUED"),
      ),
    );
}

async function executeEmail(job: QueueEmailJob) {
  logger.info(
    { emailId: job.data.emailId, elapsed: Date.now() - job.data.timestamp },
    `[EmailQueueService]: Executing email job`
  );

  const claimed = await claimEmailForSending(job.data.emailId);

  if (!claimed) {
    logger.info(
      { emailId: job.data.emailId },
      `[EmailQueueService]: Email is not claimable (already sent, claimed or cancelled); dropping`
    );
    return;
  }

  try {
    await sendClaimedEmail(job);
  } catch (error) {
    if (job.attemptsMade + 1 >= SEND_QUEUE_MAX_ATTEMPTS) {
      // Out of attempts. Releasing the claim here would put the row back in
      // SCHEDULED, where the sweeper would find it due and enqueue it again --
      // every 30 seconds, forever. A terminal status ends that, and the message
      // still reaches the dead letter queue on the way out.
      await failEmail(job.data.emailId, error);
    } else {
      // Hand the claim back so the redelivery can take it, then let the queue
      // see the failure and count the attempt.
      await releaseEmailClaim(job.data.emailId);
    }

    throw error;
  }
}

async function failEmail(emailId: string, error: unknown) {
  const [email] = await drizzleDb
    .update(schema.email)
    .set(withUpdatedAt({ latestStatus: "FAILED" as const }))
    .where(
      and(
        eq(schema.email.id, emailId),
        eq(schema.email.latestStatus, "QUEUED"),
      ),
    )
    .returning({ teamId: schema.email.teamId });

  if (!email) {
    return;
  }

  await drizzleDb.insert(schema.emailEvent).values({
    id: createId(),
    emailId,
    status: "FAILED" as const,
    data: { error: error instanceof Error ? error.message : String(error) },
    teamId: email.teamId,
  });

  // Accepted but never delivered to SES. Same reasoning as the other two
  // failure branches: we bill for accepted sends, not for sends we failed.
  await reverseAcceptedSend(emailId);

  logger.error(
    { err: error, emailId },
    `[EmailQueueService]: Email failed on its last attempt; marked FAILED`
  );
}

/**
 * Everything after the claim. Split out only so the claim can be released if
 * this throws -- there is one caller.
 */
async function sendClaimedEmail(job: QueueEmailJob) {
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
