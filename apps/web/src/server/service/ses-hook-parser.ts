import {
  EmailStatus,
  SuppressionReason,
  UnsubscribeReason,
  type Email,
} from "~/types/db";
import {
  type EmailBasePayload,
  type EmailEventPayloadMap,
  type EmailWebhookEventType,
} from "@usesend/lib/src/webhook/webhook-events";
import {
  SesBounce,
  SesClick,
  SesEvent,
  SesEventDataKey,
} from "~/types/aws-types";
import {
  unsubscribeContact,
  updateCampaignAnalytics,
} from "./campaign-service";
import { env } from "~/env";
import { and, eq, sql } from "drizzle-orm";
import { drizzleDb, schema } from "../drizzle";
import { createId } from "../drizzle/id";
import { withUpdatedAt } from "../drizzle/touch";
import { createQueue, createWorker, SES_WEBHOOK_QUEUE } from "../queue";
import { getChildLogger, logger, withLogger } from "../logger/log";
import { randomUUID } from "crypto";
import { SuppressionService } from "./suppression-service";
import { WebhookService } from "./webhook-service";
import {
  buildEmailBasePayload,
  emailStatusToEvent,
} from "./email-webhook-payload";

export async function parseSesHook(data: SesEvent) {
  // `Send` is no longer subscribed (`ses-settings-service`): it was about a
  // quarter of the pipeline spent being told something we already knew.
  // `email-queue-service` records the SENT status, the `email.sent` webhook and
  // the campaign counter itself, at the SES handoff. Events still arrive for a
  // while after the configuration sets are updated, and SNS can replay an old
  // one at any time, so they are dropped here rather than left to double-count.
  if (data.eventType === "Send") {
    logger.info(
      { sesEmailId: data.mail.messageId },
      "Ignoring SES Send event; SENT is recorded locally at handoff",
    );
    return true;
  }

  const mailStatus = getEmailStatus(data);

  if (!mailStatus) {
    // The event identifies itself; the rest of the payload is the recipient
    // address, the subject and every header, which do not belong in a log.
    logger.error(
      { eventType: data.eventType, sesEmailId: data.mail?.messageId },
      "Unknown email status",
    );
    return false;
  }

  const sesEmailId = data.mail.messageId;

  const mailData = getEmailData(data);

  logger.setBindings({
    sesEmailId,
  });

  logger.info({ mailStatus }, "Parsing ses hook");

  let [email] = await drizzleDb
    .select()
    .from(schema.email)
    .where(eq(schema.email.sesEmailId, sesEmailId))
    .limit(1);

  // Handle race condition: If email not found by sesEmailId, try to find by custom header
  if (!email) {
    const emailIdHeader = data.mail.headers.find(
      (h) => h.name === "X-Usesend-Email-ID" || h.name === "X-Unsend-Email-ID",
    );

    if (emailIdHeader?.value) {
      [email] = await drizzleDb
        .select()
        .from(schema.email)
        .where(eq(schema.email.id, emailIdHeader.value))
        .limit(1);

      // If found, update the sesEmailId to fix the missing reference
      if (email) {
        await drizzleDb
          .update(schema.email)
          .set(withUpdatedAt({ sesEmailId }))
          .where(eq(schema.email.id, email.id));
        logger.info(
          { emailId: email.id, sesEmailId },
          "Updated email with sesEmailId from webhook (race condition resolved)",
        );
      }
    }
  }

  logger.setBindings({
    sesEmailId,
    mailId: email?.id,
    teamId: email?.teamId,
  });

  if (!email) {
    logger.error(
      { eventType: data.eventType },
      "Email not found",
    );
    return false;
  }

  if (
    email.latestStatus === mailStatus &&
    mailStatus === EmailStatus.DELIVERY_DELAYED
  ) {
    return true;
  }

  const isEngagementEvent =
    mailStatus === EmailStatus.OPENED || mailStatus === EmailStatus.CLICKED;
  const existingMailEvent =
    email.campaignId || isEngagementEvent
      ? ((
          await drizzleDb
            .select({ id: schema.emailEvent.id })
            .from(schema.emailEvent)
            .where(
              and(
                eq(schema.emailEvent.emailId, email.id),
                eq(schema.emailEvent.status, mailStatus),
              ),
            )
            .limit(1)
        )[0] ?? null)
      : null;

  // Update the latest status and to avoid race conditions
  // Kept as raw SQL on purpose. SES events arrive out of order, so the status
  // only ever moves forward — a read-then-write would let a late DELIVERED
  // overwrite a BOUNCED. The comparison relies on the enum's declaration order.
  await drizzleDb.execute(sql`
      UPDATE "Email"
      SET "latestStatus" = CASE
        WHEN ${mailStatus}::text::"EmailStatus" > "latestStatus" OR "latestStatus" IS NULL OR "latestStatus" = 'SCHEDULED'::"EmailStatus"
        THEN ${mailStatus}::text::"EmailStatus"
        ELSE "latestStatus"
      END
      WHERE id = ${email.id}
    `);

  logger.info("Latest status updated");

  // Update daily email usage statistics
  const today = new Date().toISOString().split("T")[0] as string; // Format: YYYY-MM-DD

  const isHardBounced =
    mailStatus === EmailStatus.BOUNCED &&
    (mailData as SesBounce).bounceType === "Permanent";

  // Fix: Only add the actual bounced/complained recipients to suppression list
  // Add emails to suppression list for hard bounces and complaints
  if (isHardBounced || mailStatus === EmailStatus.COMPLAINED) {
    logger.info("Adding emails to suppression list");

    // Get the actual affected recipients from the event data
    let recipientEmails: string[] = [];

    if (isHardBounced && data.bounce?.bouncedRecipients) {
      // For bounces, only add the recipients that actually bounced
      recipientEmails = data.bounce.bouncedRecipients.map(
        (recipient) => recipient.emailAddress,
      );
    } else if (
      mailStatus === EmailStatus.COMPLAINED &&
      data.complaint?.complainedRecipients
    ) {
      // For complaints, only add the recipients that actually complained
      recipientEmails = data.complaint.complainedRecipients.map(
        (recipient) => recipient.emailAddress,
      );
    }

    // Only proceed if we have affected recipients
    if (recipientEmails.length > 0) {
      try {
        await Promise.all(
          recipientEmails.map((recipientEmail) =>
            SuppressionService.addSuppression({
              email: recipientEmail,
              teamId: email.teamId,
              reason: isHardBounced
                ? SuppressionReason.HARD_BOUNCE
                : SuppressionReason.COMPLAINT,
              source: email.id,
            }),
          ),
        );

        logger.info(
          {
            emailId: email.id,
            recipients: recipientEmails,
            reason: isHardBounced ? "HARD_BOUNCE" : "COMPLAINT",
          },
          "Added emails to suppression list due to bounce/complaint",
        );
      } catch (error) {
        logger.error(
          {
            emailId: email.id,
            recipients: recipientEmails,
            error: error instanceof Error ? error.message : "Unknown error",
          },
          "Failed to add emails to suppression list",
        );
        // Don't throw error - continue processing the webhook
      }
    } else {
      logger.warn(
        {
          emailId: email.id,
          eventType: data.eventType,
        },
        "No affected recipients found in bounce/complaint event data",
      );
    }
  }

  const isDuplicateEngagement = Boolean(existingMailEvent) && isEngagementEvent;

  if (
    !isDuplicateEngagement &&
    // "SENT" is deliberately absent. `DailyEmailUsage.sent` is written by
    // `recordAcceptedSends` when the email is accepted, not by an SES echo --
    // see `usage-service`. Listing it here as well would double-count any Send
    // event that slipped through.
    ["DELIVERED", "OPENED", "CLICKED", "BOUNCED", "COMPLAINED"].includes(
      mailStatus,
    )
  ) {
    logger.info("Updating daily email usage");
    const updateField = mailStatus.toLowerCase();

    // The counter to bump is chosen at runtime from the event type, so the
    // column is looked up rather than named. Incremented in SQL: SES events for
    // one team land concurrently and a read-then-write would drop them.
    const usageColumns = {
      delivered: schema.dailyEmailUsage.delivered,
      opened: schema.dailyEmailUsage.opened,
      clicked: schema.dailyEmailUsage.clicked,
      bounced: schema.dailyEmailUsage.bounced,
      complained: schema.dailyEmailUsage.complained,
    } as const;

    const usageColumn = usageColumns[updateField as keyof typeof usageColumns];

    await drizzleDb
      .insert(schema.dailyEmailUsage)
      .values(
        withUpdatedAt({
          teamId: email.teamId,
          domainId: email.domainId ?? 0,
          date: today,
          type: email.campaignId
            ? ("MARKETING" as const)
            : ("TRANSACTIONAL" as const),
          delivered: updateField === "delivered" ? 1 : 0,
          opened: updateField === "opened" ? 1 : 0,
          clicked: updateField === "clicked" ? 1 : 0,
          bounced: updateField === "bounced" ? 1 : 0,
          complained: updateField === "complained" ? 1 : 0,
          hardBounced: isHardBounced ? 1 : 0,
        }),
      )
      .onConflictDoUpdate({
        target: [
          schema.dailyEmailUsage.teamId,
          schema.dailyEmailUsage.domainId,
          schema.dailyEmailUsage.date,
          schema.dailyEmailUsage.type,
        ],
        set: withUpdatedAt({
          ...(usageColumn ? { [updateField]: sql`${usageColumn} + 1` } : {}),
          ...(isHardBounced
            ? {
                hardBounced: sql`${schema.dailyEmailUsage.hardBounced} + 1`,
              }
            : {}),
        }),
      });

    if (
      isHardBounced ||
      updateField === "complained" ||
      updateField === "delivered"
    ) {
      logger.info("Updating cumulated metrics");
      const cumulatedField = isHardBounced ? "hardBounced" : updateField;
      const cumulatedColumns = {
        delivered: schema.cumulatedMetrics.delivered,
        hardBounced: schema.cumulatedMetrics.hardBounced,
        complained: schema.cumulatedMetrics.complained,
      } as const;

      const cumulatedColumn =
        cumulatedColumns[cumulatedField as keyof typeof cumulatedColumns];

      if (cumulatedColumn) {
        // These are bigint columns, but the generated schema reads them as
        // `bigint({ mode: "number" })`, so the increment is a plain + 1 rather
        // than Prisma's BigInt(1).
        await drizzleDb
          .insert(schema.cumulatedMetrics)
          .values({
            teamId: email.teamId,
            domainId: email.domainId ?? 0,
            [cumulatedField]: 1,
          })
          .onConflictDoUpdate({
            target: [
              schema.cumulatedMetrics.teamId,
              schema.cumulatedMetrics.domainId,
            ],
            set: { [cumulatedField]: sql`${cumulatedColumn} + 1` },
          });
      }
    }
  }

  if (email.campaignId) {
    if (
      mailStatus !== "CLICKED" ||
      !(mailData as SesClick).link.startsWith(`${env.NEXTAUTH_URL}/unsubscribe`)
    ) {
      await checkUnsubscribe({
        contactId: email.contactId!,
        campaignId: email.campaignId,
        teamId: email.teamId,
        event: mailStatus,
        mailData: data,
      });

      if (!existingMailEvent) {
        await updateCampaignAnalytics(
          email.campaignId,
          mailStatus,
          isHardBounced,
        );
      }
    }
  }

  logger.info("Creating email event");

  await drizzleDb.insert(schema.emailEvent).values({
    id: createId(),
    emailId: email.id,
    status: mailStatus,
    data: mailData as any,
    teamId: email.teamId,
  });

  logger.info("Email event created");

  try {
    const occurredAt = data.mail.timestamp
      ? new Date(data.mail.timestamp).toISOString()
      : new Date().toISOString();

    const metadata = buildEmailMetadata(mailStatus, mailData);

    await WebhookService.emit(
      email.teamId,
      emailStatusToEvent(mailStatus),
      buildEmailWebhookPayload({
        email: toEmail(email),
        status: mailStatus,
        occurredAt,
        eventData: mailData,
        metadata,
      }),
      {
        domainId: email.domainId ?? null,
      },
    );
  } catch (error) {
    logger.error(
      { error, emailId: email.id, mailStatus },
      "[SesHookParser]: Failed to emit webhook",
    );
  }

  return true;
}

type EmailBounceSubType =
  EmailEventPayloadMap["email.bounced"]["bounce"]["subType"];

/** Pins the Drizzle email row to the `Email` shape the webhook payload expects. */
function toEmail(row: typeof schema.email.$inferSelect): Email {
  return row;
}

function buildEmailWebhookPayload(params: {
  email: Email;
  status: EmailStatus;
  occurredAt: string;
  eventData: SesEvent | SesEvent[SesEventDataKey];
  metadata?: Record<string, unknown>;
}): EmailEventPayloadMap[EmailWebhookEventType] {
  const { email, status, eventData, occurredAt, metadata } = params;

  const basePayload: EmailBasePayload = buildEmailBasePayload({
    email,
    status,
    occurredAt,
    metadata,
  });

  switch (status) {
    case EmailStatus.BOUNCED: {
      const bounce = eventData as SesBounce | undefined;
      return {
        ...basePayload,
        bounce: {
          type: bounce?.bounceType ?? "Undetermined",
          subType: normalizeBounceSubType(bounce?.bounceSubType),
          message: bounce?.bouncedRecipients?.[0]?.diagnosticCode,
        },
      };
    }
    case EmailStatus.OPENED: {
      const openData = eventData as SesEvent["open"];
      return {
        ...basePayload,
        open: {
          timestamp: openData?.timestamp ?? occurredAt,
          userAgent: openData?.userAgent,
          ip: openData?.ipAddress,
        },
      };
    }
    case EmailStatus.CLICKED: {
      const clickData = eventData as SesClick | undefined;
      return {
        ...basePayload,
        click: {
          timestamp: clickData?.timestamp ?? occurredAt,
          url: clickData?.link ?? "",
          userAgent: clickData?.userAgent,
          ip: clickData?.ipAddress,
        },
      };
    }
    default:
      return basePayload;
  }
}

function normalizeBounceSubType(
  subType: SesBounce["bounceSubType"] | undefined,
): EmailBounceSubType {
  const normalized = subType?.replace(/\s+/g, "") as
    | EmailBounceSubType
    | undefined;

  const validSubTypes: EmailBounceSubType[] = [
    "General",
    "NoEmail",
    "Suppressed",
    "OnAccountSuppressionList",
    "MailboxFull",
    "MessageTooLarge",
    "ContentRejected",
    "AttachmentRejected",
  ];

  if (normalized && validSubTypes.includes(normalized)) {
    return normalized;
  }

  return "General";
}

function buildEmailMetadata(
  status: EmailStatus,
  mailData: SesEvent | SesEvent[SesEventDataKey],
) {
  switch (status) {
    case EmailStatus.BOUNCED: {
      const bounce = mailData as SesBounce;
      return {
        bounceType: bounce.bounceType,
        bounceSubType: bounce.bounceSubType,
        diagnosticCode: bounce.bouncedRecipients?.[0]?.diagnosticCode,
      };
    }
    case EmailStatus.COMPLAINED: {
      const complaintInfo = (mailData as any)?.complaint ?? mailData;
      return {
        feedbackType: complaintInfo?.complaintFeedbackType,
        userAgent: complaintInfo?.userAgent,
      };
    }
    case EmailStatus.OPENED: {
      const openData = (mailData as any)?.open ?? mailData;
      return {
        ipAddress: openData?.ipAddress,
        userAgent: openData?.userAgent,
      };
    }
    case EmailStatus.CLICKED: {
      const click = mailData as SesClick;
      return {
        ipAddress: click.ipAddress,
        userAgent: click.userAgent,
        link: click.link,
      };
    }
    case EmailStatus.RENDERING_FAILURE: {
      const failure = mailData as SesEvent["renderingFailure"];
      return {
        errorMessage: failure?.errorMessage,
        templateName: failure?.templateName,
      };
    }
    case EmailStatus.DELIVERY_DELAYED: {
      const deliveryDelay = mailData as SesEvent["deliveryDelay"];
      return {
        delayType: deliveryDelay?.delayType,
        expirationTime: deliveryDelay?.expirationTime,
        delayedRecipients: deliveryDelay?.delayedRecipients,
      };
    }
    case EmailStatus.REJECTED: {
      const reject = mailData as SesEvent["reject"];
      return {
        reason: reject?.reason,
      };
    }
    default:
      return undefined;
  }
}

async function checkUnsubscribe({
  contactId,
  campaignId,
  teamId,
  event,
  mailData,
}: {
  contactId: string;
  campaignId: string;
  teamId: number;
  event: EmailStatus;
  mailData: SesEvent;
}) {
  /**
   * If the email is bounced and the bounce type is permanent, we need to unsubscribe the contact
   * If the email is complained, we need to unsubscribe the contact
   */
  if (
    (event === EmailStatus.BOUNCED &&
      mailData.bounce?.bounceType === "Permanent") ||
    event === EmailStatus.COMPLAINED
  ) {
    const [contact] = await drizzleDb
      .select()
      .from(schema.contact)
      .where(eq(schema.contact.id, contactId))
      .limit(1);

    if (!contact) {
      return;
    }

    // Prisma's `contactBook: { teamId }` relation filter becomes a join.
    const allContacts = await drizzleDb
      .select({ id: schema.contact.id })
      .from(schema.contact)
      .innerJoin(
        schema.contactBook,
        eq(schema.contactBook.id, schema.contact.contactBookId),
      )
      .where(
        and(
          eq(schema.contact.email, contact.email),
          eq(schema.contactBook.teamId, teamId),
        ),
      );

    const allContactIds = allContacts
      .map((c) => c.id)
      .filter((c) => c !== contactId);

    await Promise.all([
      unsubscribeContact({
        contactId,
        campaignId,
        reason:
          event === EmailStatus.BOUNCED
            ? UnsubscribeReason.BOUNCED
            : UnsubscribeReason.COMPLAINED,
      }),
      ...allContactIds.map((c) =>
        unsubscribeContact({
          contactId: c,
          reason:
            event === EmailStatus.BOUNCED
              ? UnsubscribeReason.BOUNCED
              : UnsubscribeReason.COMPLAINED,
        }),
      ),
    ]);
  }
}

function getEmailStatus(data: SesEvent) {
  const { eventType } = data;

  if (eventType === "Send") {
    return EmailStatus.SENT;
  } else if (eventType === "Delivery") {
    return EmailStatus.DELIVERED;
  } else if (eventType === "Bounce") {
    return EmailStatus.BOUNCED;
  } else if (eventType === "Complaint") {
    return EmailStatus.COMPLAINED;
  } else if (eventType === "Reject") {
    return EmailStatus.REJECTED;
  } else if (eventType === "Open") {
    return EmailStatus.OPENED;
  } else if (eventType === "Click") {
    return EmailStatus.CLICKED;
  } else if (eventType === "Rendering Failure") {
    return EmailStatus.RENDERING_FAILURE;
  } else if (eventType === "DeliveryDelay") {
    return EmailStatus.DELIVERY_DELAYED;
  }
}

function getEmailData(data: SesEvent) {
  const { eventType } = data;

  if (eventType === "Rendering Failure") {
    return data.renderingFailure;
  } else if (eventType === "DeliveryDelay") {
    return data.deliveryDelay;
  } else {
    return data[eventType.toLowerCase() as SesEventDataKey];
  }
}

export class SesHookParser {
  private static sesHookQueue = createQueue<SesEvent>(SES_WEBHOOK_QUEUE);

  private static worker = createWorker<SesEvent>(
    SES_WEBHOOK_QUEUE,
    async (job) => {
      return await withLogger(
        getChildLogger({
          queueId: job.id ?? randomUUID(),
        }),
        async () => {
          await this.execute(job.data);
        },
      );
    },
    { concurrency: 50 },
  );

  private static async execute(event: SesEvent) {
    try {
      await parseSesHook(event);
    } catch (error) {
      logger.error({ error }, "Error parsing ses hook");
      throw error;
    }
  }

  static async queue(data: { event: SesEvent; messageId: string }) {
    return await this.sesHookQueue.enqueue(data.messageId, data.event);
  }
}
