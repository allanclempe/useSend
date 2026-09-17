import { EmailRenderer } from "@usesend/email-editor/src/renderer";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { drizzleDb, schema } from "../drizzle";
import { createId } from "../drizzle/id";
import { withUpdatedAt } from "../drizzle/touch";
import { createHash } from "crypto";
import { env } from "~/env";
import {
  Campaign,
  Contact,
  EmailStatus,
  UnsubscribeReason,
} from "~/types/db";

function toContact(row: typeof schema.contact.$inferSelect): Contact {
  // jsonb reads as `unknown` in Drizzle; Prisma typed it JsonValue.
  return { ...row, properties: (row.properties ?? {}) as Contact["properties"] };
}

/** Pins the Drizzle campaign row to the `Campaign` shape callers expect. */
export function toCampaign(row: typeof schema.campaign.$inferSelect): Campaign {
  return row;
}
import { EmailQueueService } from "./email-queue-service";
import {
  CAMPAIGN_BATCH_QUEUE,
  createQueue,
  createWorker,
  createWorkerHandler,
  type TeamJob,
} from "../queue";
import { logger } from "../logger/log";
import { SuppressionService } from "./suppression-service";
import { UnsendApiError } from "../public-api/api-error";
import {
  validateApiKeyDomainAccess,
  validateDomainFromEmail,
} from "./domain-service";
import {
  BUILT_IN_CONTACT_VARIABLES,
  createCaseInsensitiveVariableValues,
  getContactReplacementValue,
  replaceContactVariables,
} from "../utils/contact-variable-replacement";
import { updateContactSubscription } from "./contact-service";
import { getCampaignUnsubscribeVariableValues } from "~/lib/constants/campaign";

const CAMPAIGN_UNSUB_PLACEHOLDER_TOKENS = [
  "{{unsend_unsubscribe_url}}",
  "{{usesend_unsubscribe_url}}",
] as const;

const CAMPAIGN_UNSUB_PLACEHOLDER_REGEXES =
  CAMPAIGN_UNSUB_PLACEHOLDER_TOKENS.map((placeholder) => {
    const inner = placeholder.replace(/[{}]/g, "").trim();
    return new RegExp(`\\{\\{\\s*${inner}\\s*\\}}`, "i");
  });

function campaignHasUnsubscribePlaceholder(
  ...sources: Array<string | null | undefined>
) {
  return CAMPAIGN_UNSUB_PLACEHOLDER_REGEXES.some((regex) =>
    sources.some((source) => (source ? regex.test(source) : false)),
  );
}

function replaceUnsubscribePlaceholders(html: string, url: string) {
  return CAMPAIGN_UNSUB_PLACEHOLDER_REGEXES.reduce((acc, regex) => {
    return acc.replace(new RegExp(regex.source, "gi"), url);
  }, html);
}

function sanitizeAddressList(addresses?: string | string[]) {
  if (!addresses) {
    return [] as string[];
  }

  const list = Array.isArray(addresses) ? addresses : [addresses];

  return list
    .map((address) => address.trim())
    .filter((address) => address.length > 0);
}

async function prepareCampaignHtml(
  campaign: Campaign,
): Promise<{ campaign: Campaign; html: string }> {
  if (campaign.content) {
    try {
      const jsonContent = JSON.parse(campaign.content);
      const renderer = new EmailRenderer(jsonContent);
      const html = await renderer.render();

      if (campaign.html !== html) {
        const [updated] = await drizzleDb
          .update(schema.campaign)
          .set(withUpdatedAt({ html }))
          .where(eq(schema.campaign.id, campaign.id))
          .returning();

        if (updated) {
          campaign = toCampaign(updated);
        }
      }

      return { campaign, html };
    } catch (error) {
      logger.error({ err: error }, "Failed to parse campaign content");
      throw new Error("Failed to parse campaign content");
    }
  }

  if (campaign.html) {
    return { campaign, html: campaign.html };
  }

  throw new Error("No content added for campaign");
}

async function renderCampaignHtmlForContact({
  campaign,
  contact,
  unsubscribeUrl,
  allowedVariables,
}: {
  campaign: Campaign;
  contact: Contact;
  unsubscribeUrl: string;
  allowedVariables: string[];
}) {
  if (campaign.content) {
    try {
      const jsonContent = JSON.parse(campaign.content);
      const renderer = new EmailRenderer(jsonContent);
      const linkValues: Record<string, string> = {};

      for (const token of CAMPAIGN_UNSUB_PLACEHOLDER_TOKENS) {
        linkValues[token] = unsubscribeUrl;
      }

      const variableValues = createCaseInsensitiveVariableValues({
        email: contact.email,
        firstName: contact.firstName,
        lastName: contact.lastName,
        ...allowedVariables.reduce(
          (acc, variable) => {
            const value = getContactReplacementValue({
              contact,
              key: variable,
              allowedVariables,
            });

            if (value !== undefined) {
              acc[variable] = value;
            }

            return acc;
          },
          {} as Record<string, string | null | undefined>,
        ),
        ...getCampaignUnsubscribeVariableValues(unsubscribeUrl),
      });

      return renderer.render({
        shouldReplaceVariableValues: true,
        variableValues,
        linkValues,
      });
    } catch (error) {
      logger.error({ err: error }, "Failed to parse campaign content");
      throw new Error("Failed to parse campaign content");
    }
  }

  if (!campaign.html) {
    throw new Error("No HTML content for campaign");
  }

  let html = replaceUnsubscribePlaceholders(campaign.html, unsubscribeUrl);
  html = replaceContactVariables(html, contact, allowedVariables);

  return html;
}

export async function createCampaignFromApi({
  teamId,
  apiKeyId,
  name,
  from,
  subject,
  previewText,
  content,
  html,
  contactBookId,
  replyTo,
  cc,
  bcc,
  batchSize,
}: {
  teamId: number;
  apiKeyId?: number;
  name: string;
  from: string;
  subject: string;
  previewText?: string;
  content?: string;
  html?: string;
  contactBookId: string;
  replyTo?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  batchSize?: number;
}) {
  if (!content && !html) {
    throw new UnsendApiError({
      code: "BAD_REQUEST",
      message: "Either content or html must be provided",
    });
  }

  if (content) {
    try {
      JSON.parse(content);
    } catch (error) {
      logger.error({ err: error }, "Invalid campaign content JSON from API");
      throw new UnsendApiError({
        code: "BAD_REQUEST",
        message: "Invalid content JSON",
      });
    }
  }

  const [contactBook] = await drizzleDb
    .select({ id: schema.contactBook.id })
    .from(schema.contactBook)
    .where(
      and(
        eq(schema.contactBook.id, contactBookId),
        eq(schema.contactBook.teamId, teamId),
      ),
    )
    .limit(1);

  if (!contactBook) {
    throw new UnsendApiError({
      code: "BAD_REQUEST",
      message: "Contact book not found",
    });
  }

  let domain;

  if (apiKeyId) {
    const [apiKeyRow] = await drizzleDb
      .select({ apiKey: schema.apiKey, domain: schema.domain })
      .from(schema.apiKey)
      .leftJoin(schema.domain, eq(schema.domain.id, schema.apiKey.domainId))
      .where(eq(schema.apiKey.id, apiKeyId))
      .limit(1);

    // Reshaped to Prisma's nested include for validateApiKeyDomainAccess.
    const apiKey = apiKeyRow
      ? { ...apiKeyRow.apiKey, domain: apiKeyRow.domain }
      : null;

    if (!apiKey || apiKey.teamId !== teamId) {
      throw new UnsendApiError({
        code: "FORBIDDEN",
        message: "Invalid API key",
      });
    }

    domain = await validateApiKeyDomainAccess(from, teamId, apiKey);
  } else {
    domain = await validateDomainFromEmail(from, teamId);
  }

  const sanitizedHtml = html?.trim();
  const sanitizedContent = content ?? null;

  const unsubPlaceholderFound = campaignHasUnsubscribePlaceholder(
    sanitizedContent,
    sanitizedHtml,
  );

  if (!unsubPlaceholderFound) {
    throw new UnsendApiError({
      code: "BAD_REQUEST",
      message: "Campaign must include an unsubscribe link before sending",
    });
  }

  const [campaign] = await drizzleDb
    .insert(schema.campaign)
    .values(
      withUpdatedAt({
        id: createId(),
        name,
        from,
        subject,
        isApi: true,
        ...(previewText !== undefined ? { previewText } : {}),
        content: sanitizedContent,
        ...(sanitizedHtml && sanitizedHtml.length > 0
          ? { html: sanitizedHtml }
          : {}),
        contactBookId,
        replyTo: sanitizeAddressList(replyTo),
        cc: sanitizeAddressList(cc),
        bcc: sanitizeAddressList(bcc),
        teamId,
        domainId: domain.id,
        ...(typeof batchSize === "number" ? { batchSize } : {}),
      }),
    )
    .returning();

  if (!campaign) {
    throw new UnsendApiError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to create campaign",
    });
  }

  return toCampaign(campaign);
}

export async function getCampaignForTeam({
  campaignId,
  teamId,
}: {
  campaignId: string;
  teamId: number;
}) {
  const [campaign] = await drizzleDb
    .select({
      id: schema.campaign.id,
      name: schema.campaign.name,
      from: schema.campaign.from,
      subject: schema.campaign.subject,
      previewText: schema.campaign.previewText,
      contactBookId: schema.campaign.contactBookId,
      html: schema.campaign.html,
      content: schema.campaign.content,
      status: schema.campaign.status,
      scheduledAt: schema.campaign.scheduledAt,
      batchSize: schema.campaign.batchSize,
      batchWindowMinutes: schema.campaign.batchWindowMinutes,
      total: schema.campaign.total,
      sent: schema.campaign.sent,
      delivered: schema.campaign.delivered,
      opened: schema.campaign.opened,
      clicked: schema.campaign.clicked,
      unsubscribed: schema.campaign.unsubscribed,
      bounced: schema.campaign.bounced,
      hardBounced: schema.campaign.hardBounced,
      complained: schema.campaign.complained,
      replyTo: schema.campaign.replyTo,
      cc: schema.campaign.cc,
      bcc: schema.campaign.bcc,
      createdAt: schema.campaign.createdAt,
      updatedAt: schema.campaign.updatedAt,
    })
    .from(schema.campaign)
    .where(
      and(
        eq(schema.campaign.id, campaignId),
        eq(schema.campaign.teamId, teamId),
      ),
    )
    .limit(1);

  if (!campaign) {
    throw new UnsendApiError({
      code: "NOT_FOUND",
      message: "Campaign not found",
    });
  }

  return campaign;
}

export async function sendCampaign(id: string) {
  const [found] = await drizzleDb
    .select()
    .from(schema.campaign)
    .where(eq(schema.campaign.id, id))
    .limit(1);

  if (!found) {
    throw new Error("Campaign not found");
  }

  let campaign = toCampaign(found);

  const prepared = await prepareCampaignHtml(campaign);
  campaign = prepared.campaign;
  const html = prepared.html;

  if (!campaign.contactBookId) {
    throw new Error("No contact book found for campaign");
  }

  if (!html) {
    throw new Error("No HTML content for campaign");
  }

  const unsubPlaceholderFound = campaignHasUnsubscribePlaceholder(
    campaign.content,
    html,
  );

  if (!unsubPlaceholderFound) {
    throw new Error("Campaign must include an unsubscribe link before sending");
  }

  // Count subscribed contacts for total, don't load all into memory
  const total = await drizzleDb.$count(
    schema.contact,
    and(
      eq(schema.contact.contactBookId, campaign.contactBookId),
      eq(schema.contact.subscribed, true),
    ),
  );

  // Mark as scheduled (or keep running if already running), set totals and scheduledAt if not set
  await drizzleDb
    .update(schema.campaign)
    .set(
      withUpdatedAt({
        status: "SCHEDULED" as const,
        total,
        scheduledAt: campaign.scheduledAt ?? new Date(),
        lastCursor: campaign.lastCursor ?? null,
      }),
    )
    .where(eq(schema.campaign.id, id));

  // Kick off first batch immediately (idempotent by jobId)
  await CampaignBatchService.queueBatch({
    campaignId: id,
    teamId: campaign.teamId,
  });
}

export async function scheduleCampaign({
  campaignId,
  teamId,
  scheduledAt: scheduledAtInput,
  batchSize,
}: {
  campaignId: string;
  teamId: number;
  scheduledAt?: Date | string;
  batchSize?: number;
}) {
  const [scheduleTarget] = await drizzleDb
    .select()
    .from(schema.campaign)
    .where(
      and(
        eq(schema.campaign.id, campaignId),
        eq(schema.campaign.teamId, teamId),
      ),
    )
    .limit(1);

  let campaign = scheduleTarget ? toCampaign(scheduleTarget) : undefined;
  if (!campaign) {
    throw new UnsendApiError({
      code: "NOT_FOUND",
      message: "Campaign not found",
    });
  }

  let html: string;
  try {
    const prepared = await prepareCampaignHtml(campaign);
    campaign = prepared.campaign;
    html = prepared.html;
  } catch (err) {
    throw new UnsendApiError({
      code: "BAD_REQUEST",
      message: err instanceof Error ? err.message : "Invalid campaign content",
    });
  }

  if (!campaign.contactBookId) {
    throw new UnsendApiError({
      code: "BAD_REQUEST",
      message: "No contact book found for campaign",
    });
  }

  if (!html) {
    throw new UnsendApiError({
      code: "BAD_REQUEST",
      message: "No HTML content for campaign",
    });
  }

  const unsubPlaceholderFound = campaignHasUnsubscribePlaceholder(
    campaign.content,
    html,
  );
  if (!unsubPlaceholderFound) {
    throw new UnsendApiError({
      code: "BAD_REQUEST",
      message: "Campaign must include an unsubscribe link before scheduling",
    });
  }

  // Count subscribed contacts for total
  const total = await drizzleDb.$count(
    schema.contact,
    and(
      eq(schema.contact.contactBookId, campaign.contactBookId),
      eq(schema.contact.subscribed, true),
    ),
  );

  if (total === 0) {
    throw new UnsendApiError({
      code: "BAD_REQUEST",
      message: "No subscribed contacts to send",
    });
  }

  const scheduledAt = scheduledAtInput
    ? scheduledAtInput instanceof Date
      ? scheduledAtInput
      : new Date(scheduledAtInput)
    : new Date();

  const shouldResetCursor =
    campaign.status === "DRAFT" || campaign.status === "SENT";

  await drizzleDb
    .update(schema.campaign)
    .set(
      withUpdatedAt({
        status: "SCHEDULED" as const,
        scheduledAt,
        total,
        ...(batchSize ? { batchSize } : {}),
        ...(shouldResetCursor ? { lastCursor: null } : {}),
      }),
    )
    .where(eq(schema.campaign.id, campaign.id));

  return { ok: true };
}

export async function pauseCampaign({
  campaignId,
  teamId,
}: {
  campaignId: string;
  teamId: number;
}) {
  const [campaign] = await drizzleDb
    .select()
    .from(schema.campaign)
    .where(
      and(
        eq(schema.campaign.id, campaignId),
        eq(schema.campaign.teamId, teamId),
      ),
    )
    .limit(1);

  if (!campaign) {
    throw new UnsendApiError({
      code: "NOT_FOUND",
      message: "Campaign not found",
    });
  }

  await drizzleDb
    .update(schema.campaign)
    .set(withUpdatedAt({ status: "PAUSED" as const }))
    .where(eq(schema.campaign.id, campaignId));

  return { ok: true };
}

export async function resumeCampaign({
  campaignId,
  teamId,
}: {
  campaignId: string;
  teamId: number;
}) {
  const [campaign] = await drizzleDb
    .select()
    .from(schema.campaign)
    .where(
      and(
        eq(schema.campaign.id, campaignId),
        eq(schema.campaign.teamId, teamId),
      ),
    )
    .limit(1);

  if (!campaign) {
    throw new UnsendApiError({
      code: "NOT_FOUND",
      message: "Campaign not found",
    });
  }

  if (campaign.scheduledAt && campaign.scheduledAt.getTime() > Date.now()) {
    await drizzleDb
      .update(schema.campaign)
      .set(withUpdatedAt({ status: "SCHEDULED" as const }))
      .where(eq(schema.campaign.id, campaignId));
  } else {
    await drizzleDb
      .update(schema.campaign)
      .set(withUpdatedAt({ status: "RUNNING" as const }))
      .where(eq(schema.campaign.id, campaignId));
  }

  return { ok: true };
}

export function createUnsubUrl(contactId: string, campaignId: string) {
  const unsubId = `${contactId}-${campaignId}`;

  const unsubHash = createHash("sha256")
    .update(`${unsubId}-${env.NEXTAUTH_SECRET}`)
    .digest("hex");

  return `${env.NEXTAUTH_URL}/unsubscribe?id=${unsubId}&hash=${unsubHash}`;
}

export function createOneClickUnsubUrl(contactId: string, campaignId: string) {
  const unsubId = `${contactId}-${campaignId}`;

  const unsubHash = createHash("sha256")
    .update(`${unsubId}-${env.NEXTAUTH_SECRET}`)
    .digest("hex");

  return `${env.NEXTAUTH_URL}/api/unsubscribe-oneclick?id=${unsubId}&hash=${unsubHash}`;
}

function verifyUnsubscribeLink(id: string, hash: string) {
  const [contactId, campaignId] = id.split("-");

  if (!contactId || !campaignId) {
    throw new Error("Invalid unsubscribe link");
  }

  // Verify the hash
  const expectedHash = createHash("sha256")
    .update(`${id}-${env.NEXTAUTH_SECRET}`)
    .digest("hex");

  if (hash !== expectedHash) {
    throw new Error("Invalid unsubscribe link");
  }

  return { contactId, campaignId };
}

export async function getContactFromUnsubscribeLink(id: string, hash: string) {
  const { contactId } = verifyUnsubscribeLink(id, hash);

  const [contact] = await drizzleDb
    .select()
    .from(schema.contact)
    .where(eq(schema.contact.id, contactId))
    .limit(1);

  if (!contact) {
    throw new Error("Contact not found");
  }

  return toContact(contact);
}

export async function unsubscribeContactFromLink(id: string, hash: string) {
  const { contactId, campaignId } = verifyUnsubscribeLink(id, hash);

  return await unsubscribeContact({
    contactId,
    campaignId,
    reason: UnsubscribeReason.UNSUBSCRIBED,
  });
}

export async function unsubscribeContact({
  contactId,
  campaignId,
  reason,
}: {
  contactId: string;
  campaignId?: string;
  reason: UnsubscribeReason;
}) {
  // Update the contact's subscription status
  try {
    const [contact] = await drizzleDb
      .select()
      .from(schema.contact)
      .where(eq(schema.contact.id, contactId))
      .limit(1);

    if (!contact) {
      throw new Error("Contact not found");
    }

    if (contact.subscribed) {
      const updatedContact = await updateContactSubscription({
        contactId,
        subscribed: false,
        unsubscribeReason: reason,
      });

      if (campaignId) {
        await drizzleDb
          .update(schema.campaign)
          .set(
            withUpdatedAt({
              // SQL rather than read-then-write: concurrent unsubscribes on the
              // same campaign would otherwise lose counts.
              unsubscribed: sql`${schema.campaign.unsubscribed} + 1`,
            }),
          )
          .where(eq(schema.campaign.id, campaignId));
      }

      return updatedContact;
    }

    return contact;
  } catch (error) {
    logger.error({ err: error }, "Error unsubscribing contact");
    throw new Error("Failed to unsubscribe contact");
  }
}

export async function subscribeContact(id: string, hash: string) {
  const [contactId, campaignId] = id.split("-");

  if (!contactId || !campaignId) {
    throw new Error("Invalid subscribe link");
  }

  // Verify the hash
  const expectedHash = createHash("sha256")
    .update(`${id}-${env.NEXTAUTH_SECRET}`)
    .digest("hex");

  if (hash !== expectedHash) {
    throw new Error("Invalid subscribe link");
  }

  // Update the contact's subscription status
  try {
    const [contact] = await drizzleDb
      .select()
      .from(schema.contact)
      .where(eq(schema.contact.id, contactId))
      .limit(1);

    if (!contact) {
      throw new Error("Contact not found");
    }

    if (!contact.subscribed) {
      await updateContactSubscription({
        contactId,
        subscribed: true,
        unsubscribeReason: null,
      });

      await drizzleDb
        .update(schema.campaign)
        .set(
          withUpdatedAt({
            unsubscribed: sql`${schema.campaign.unsubscribed} - 1`,
          }),
        )
        .where(eq(schema.campaign.id, campaignId));
    }

    return true;
  } catch (error) {
    logger.error({ err: error }, "Error subscribing contact");
    throw new Error("Failed to subscribe contact");
  }
}

export async function deleteCampaign(id: string, teamId: number) {
  const [existing] = await drizzleDb
    .select()
    .from(schema.campaign)
    .where(and(eq(schema.campaign.id, id), eq(schema.campaign.teamId, teamId)))
    .limit(1);

  if (!existing) {
    throw new UnsendApiError({
      code: "NOT_FOUND",
      message: "Campaign not found",
    });
  }

  const campaign = await drizzleDb.transaction(async (tx) => {
    await tx
      .delete(schema.campaignEmail)
      .where(eq(schema.campaignEmail.campaignId, id));

    const [deleted] = await tx
      .delete(schema.campaign)
      .where(eq(schema.campaign.id, id))
      .returning();

    if (!deleted) {
      throw new UnsendApiError({
        code: "NOT_FOUND",
        message: "Campaign not found",
      });
    }

    return toCampaign(deleted);
  });

  return campaign;
}

type CampaignEmailJob = {
  contact: Contact;
  campaign: Campaign;
  allowedVariables: string[];
  emailConfig: {
    from: string;
    subject: string;
    replyTo?: string[];
    cc?: string[];
    bcc?: string[];
    teamId: number;
    campaignId: string;
    previewText?: string;
    domainId: number;
    region: string;
  };
};

type CampaignContactFailureInput = {
  contact: Pick<Contact, "id" | "email">;
  campaign: Pick<Campaign, "id" | "from" | "subject" | "html" | "previewText">;
  emailConfig: {
    replyTo?: string[];
    cc?: string[];
    bcc?: string[];
    teamId: number;
    domainId: number;
  };
  error: unknown;
};

function getFailureMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export async function recordCampaignContactFailure({
  contact,
  campaign,
  emailConfig,
  error,
}: CampaignContactFailureInput) {
  const failureMessage = getFailureMessage(error);

  await drizzleDb.transaction(async (tx) => {
    const [existingCampaignEmail] = await tx
      .select({ emailId: schema.campaignEmail.emailId })
      .from(schema.campaignEmail)
      .where(
        and(
          eq(schema.campaignEmail.campaignId, campaign.id),
          eq(schema.campaignEmail.contactId, contact.id),
        ),
      )
      .limit(1);

    let emailId = existingCampaignEmail?.emailId;

    if (!emailId) {
      const [existingEmail] = await tx
        .select({ id: schema.email.id })
        .from(schema.email)
        .where(
          and(
            eq(schema.email.campaignId, campaign.id),
            eq(schema.email.contactId, contact.id),
          ),
        )
        .orderBy(desc(schema.email.createdAt))
        .limit(1);

      if (existingEmail) {
        emailId = existingEmail.id;
      } else {
        const [failedEmail] = await tx
          .insert(schema.email)
          .values(
            withUpdatedAt({
              id: createId(),
              to: [contact.email],
              replyTo: emailConfig.replyTo ?? [],
              cc: emailConfig.cc ?? [],
              bcc: emailConfig.bcc ?? [],
              from: campaign.from,
              subject: campaign.subject,
              html: campaign.html,
              text: campaign.previewText,
              teamId: emailConfig.teamId,
              campaignId: campaign.id,
              contactId: contact.id,
              domainId: emailConfig.domainId,
              latestStatus: "FAILED" as const,
            }),
          )
          .returning({ id: schema.email.id });

        if (!failedEmail) {
          throw new Error("Failed to create campaign failure email");
        }

        emailId = failedEmail.id;
      }

      await tx.insert(schema.campaignEmail).values({
        campaignId: campaign.id,
        contactId: contact.id,
        emailId,
      });
    }

    await tx
      .update(schema.email)
      .set(withUpdatedAt({ latestStatus: "FAILED" as const }))
      .where(eq(schema.email.id, emailId));

    await tx.insert(schema.emailEvent).values({
      id: createId(),
      emailId,
      status: "FAILED" as const,
      data: { error: failureMessage },
      teamId: emailConfig.teamId,
    });
  });
}

async function processContactEmail(jobData: CampaignEmailJob) {
  const { contact, campaign, emailConfig, allowedVariables } = jobData;

  const unsubscribeUrl = createUnsubUrl(contact.id, emailConfig.campaignId);
  const oneClickUnsubUrl = createOneClickUnsubUrl(
    contact.id,
    emailConfig.campaignId,
  );

  // Check for suppressed emails before processing
  const toEmails = [contact.email];
  const ccEmails = emailConfig.cc || [];
  const bccEmails = emailConfig.bcc || [];

  // Collect all unique emails to check for suppressions
  const allEmailsToCheck = [
    ...new Set([...toEmails, ...ccEmails, ...bccEmails]),
  ];

  const suppressionResults = await SuppressionService.checkMultipleEmails(
    allEmailsToCheck,
    emailConfig.teamId,
  );

  // Filter each field separately
  const filteredToEmails = toEmails.filter(
    (email) => !suppressionResults[email],
  );
  const filteredCcEmails = ccEmails.filter(
    (email) => !suppressionResults[email],
  );
  const filteredBccEmails = bccEmails.filter(
    (email) => !suppressionResults[email],
  );

  // Check if the contact's email (TO recipient) is suppressed
  const isContactSuppressed = filteredToEmails.length === 0;

  const html = await renderCampaignHtmlForContact({
    campaign,
    contact,
    unsubscribeUrl,
    allowedVariables,
  });
  const subject = replaceContactVariables(
    emailConfig.subject,
    contact,
    allowedVariables,
  );

  if (isContactSuppressed) {
    // Create suppressed email record
    logger.info(
      {
        contactEmail: contact.email,
        campaignId: emailConfig.campaignId,
        teamId: emailConfig.teamId,
      },
      "Contact email is suppressed. Creating suppressed email record.",
    );

    const [email] = await drizzleDb
      .insert(schema.email)
      .values(
        withUpdatedAt({
          id: createId(),
          to: toEmails,
          replyTo: emailConfig.replyTo,
          ...(ccEmails.length > 0 ? { cc: ccEmails } : {}),
          ...(bccEmails.length > 0 ? { bcc: bccEmails } : {}),
          from: emailConfig.from,
          subject,
          html,
          text: emailConfig.previewText,
          teamId: emailConfig.teamId,
          campaignId: emailConfig.campaignId,
          contactId: contact.id,
          domainId: emailConfig.domainId,
          latestStatus: "SUPPRESSED" as const,
        }),
      )
      .returning();

    if (!email) {
      throw new Error("Failed to create suppressed email record");
    }

    await drizzleDb.insert(schema.emailEvent).values({
      id: createId(),
      emailId: email.id,
      status: "SUPPRESSED" as const,
      data: {
        error: "Contact email is suppressed. No email sent.",
      },
      teamId: emailConfig.teamId,
    });

    await drizzleDb.insert(schema.campaignEmail).values({
      campaignId: emailConfig.campaignId,
      contactId: contact.id,
      emailId: email.id,
    });

    return;
  }

  // Log if any CC/BCC emails were filtered out
  if (ccEmails.length > filteredCcEmails.length) {
    logger.info(
      {
        originalCc: ccEmails,
        filteredCc: filteredCcEmails,
        campaignId: emailConfig.campaignId,
        teamId: emailConfig.teamId,
      },
      "Some CC recipients were suppressed and filtered out from campaign email.",
    );
  }

  if (bccEmails.length > filteredBccEmails.length) {
    logger.info(
      {
        originalBcc: bccEmails,
        filteredBcc: filteredBccEmails,
        campaignId: emailConfig.campaignId,
        teamId: emailConfig.teamId,
      },
      "Some BCC recipients were suppressed and filtered out from campaign email.",
    );
  }

  // Create email with filtered recipients
  const [email] = await drizzleDb
    .insert(schema.email)
    .values(
      withUpdatedAt({
        id: createId(),
        to: filteredToEmails,
        replyTo: emailConfig.replyTo,
        // Prisma read `undefined` as "use the column default"; spread instead of
        // writing an explicit undefined.
        ...(filteredCcEmails.length > 0 ? { cc: filteredCcEmails } : {}),
        ...(filteredBccEmails.length > 0 ? { bcc: filteredBccEmails } : {}),
        from: emailConfig.from,
        subject,
        html,
        text: emailConfig.previewText,
        teamId: emailConfig.teamId,
        campaignId: emailConfig.campaignId,
        contactId: contact.id,
        domainId: emailConfig.domainId,
      }),
    )
    .returning();

  if (!email) {
    throw new Error("Failed to create campaign email");
  }

  await drizzleDb.insert(schema.campaignEmail).values({
    campaignId: emailConfig.campaignId,
    contactId: contact.id,
    emailId: email.id,
  });

  // Queue email for sending
  await EmailQueueService.queueEmail(
    email.id,
    emailConfig.teamId,
    emailConfig.region,
    false,
    oneClickUnsubUrl,
  );
}

export async function updateCampaignAnalytics(
  campaignId: string,
  emailStatus: EmailStatus,
  hardBounce: boolean = false,
) {
  const [campaign] = await drizzleDb
    .select({ id: schema.campaign.id })
    .from(schema.campaign)
    .where(eq(schema.campaign.id, campaignId))
    .limit(1);

  if (!campaign) {
    throw new Error("Campaign not found");
  }

  // Every counter is incremented in SQL. These run once per inbound SES event,
  // so several can land on the same campaign at once and a read-then-write
  // would drop them.
  const bump = (column: AnyPgColumn) => sql`${column} + 1`;

  const updateData: Record<string, unknown> = {};

  switch (emailStatus) {
    case EmailStatus.SENT:
      updateData.sent = bump(schema.campaign.sent);
      break;
    case EmailStatus.DELIVERED:
      updateData.delivered = bump(schema.campaign.delivered);
      break;
    case EmailStatus.OPENED:
      updateData.opened = bump(schema.campaign.opened);
      break;
    case EmailStatus.CLICKED:
      updateData.clicked = bump(schema.campaign.clicked);
      break;
    case EmailStatus.BOUNCED:
      updateData.bounced = bump(schema.campaign.bounced);
      if (hardBounce) {
        updateData.hardBounced = bump(schema.campaign.hardBounced);
      }
      break;
    case EmailStatus.COMPLAINED:
      updateData.complained = bump(schema.campaign.complained);
      break;
    default:
      break;
  }

  // Prisma accepted an empty update as a no-op; an empty SET is invalid SQL.
  if (Object.keys(updateData).length === 0) {
    return;
  }

  await drizzleDb
    .update(schema.campaign)
    .set(withUpdatedAt(updateData))
    .where(eq(schema.campaign.id, campaignId));
}

// ---------------------------
// Simple campaign batch queue
// ---------------------------

type CampaignBatchJob = TeamJob<{ campaignId: string }>;

export class CampaignBatchService {
  private static batchQueue = createQueue<CampaignBatchJob["data"]>(
    CAMPAIGN_BATCH_QUEUE,
  );

  static worker = createWorker(
    CAMPAIGN_BATCH_QUEUE,
    createWorkerHandler(async (job: CampaignBatchJob) => {
      const { campaignId } = job.data;

      const [campaignRow] = await drizzleDb
        .select()
        .from(schema.campaign)
        .where(eq(schema.campaign.id, campaignId))
        .limit(1);
      if (!campaignRow) return;
      const campaign = toCampaign(campaignRow);
      if (!campaign.contactBookId) return;

      // Skip paused campaigns
      if (campaign.status === "PAUSED") return;

      // Respect scheduledAt if set
      if (campaign.scheduledAt && campaign.scheduledAt.getTime() > Date.now())
        return;

      // First touch moves SCHEDULED -> RUNNING
      if (campaign.status === "SCHEDULED") {
        await drizzleDb
          .update(schema.campaign)
          .set(withUpdatedAt({ status: "RUNNING" as const }))
          .where(eq(schema.campaign.id, campaignId));
      }

      const batchSize = campaign.batchSize ?? 500;

      // Prisma paged with cursor + skip:1. Contact.id is unique and the order
      // is id asc, so the keyset is just "after the last id seen".
      const contacts = await drizzleDb
        .select()
        .from(schema.contact)
        .where(
          and(
            eq(schema.contact.contactBookId, campaign.contactBookId),
            eq(schema.contact.subscribed, true),
            campaign.lastCursor
              ? gt(schema.contact.id, campaign.lastCursor)
              : undefined,
          ),
        )
        .orderBy(asc(schema.contact.id))
        .limit(batchSize);

      const [contactBook] = await drizzleDb
        .select({ variables: schema.contactBook.variables })
        .from(schema.contactBook)
        .where(eq(schema.contactBook.id, campaign.contactBookId))
        .limit(1);

      const allowedVariables = [
        ...BUILT_IN_CONTACT_VARIABLES,
        ...(contactBook?.variables ?? []),
      ];

      if (contacts.length === 0) {
        // No more contacts -> mark SENT
        await drizzleDb
          .update(schema.campaign)
          .set(withUpdatedAt({ status: "SENT" as const }))
          .where(eq(schema.campaign.id, campaignId));
        return;
      }

      // Fetch domain for region and id
      const [domain] = await drizzleDb
        .select()
        .from(schema.domain)
        .where(eq(schema.domain.id, campaign.domainId))
        .limit(1);
      if (!domain) return;

      // Bulk existence check to avoid duplicates while unique is not enforced
      const existing = await drizzleDb
        .select({ contactId: schema.campaignEmail.contactId })
        .from(schema.campaignEmail)
        .where(
          and(
            eq(schema.campaignEmail.campaignId, campaign.id),
            inArray(
              schema.campaignEmail.contactId,
              contacts.map((c) => c.id),
            ),
          ),
        );
      const existingSet = new Set(existing.map((e) => e.contactId));

      // Process each contact in this batch
      for (const contact of contacts) {
        if (existingSet.has(contact.id)) continue;

        try {
          await processContactEmail({
            contact: toContact(contact),
            campaign,
            allowedVariables,
            emailConfig: {
              from: campaign.from,
              subject: campaign.subject,
              replyTo: Array.isArray(campaign.replyTo) ? campaign.replyTo : [],
              cc: Array.isArray(campaign.cc) ? campaign.cc : [],
              bcc: Array.isArray(campaign.bcc) ? campaign.bcc : [],
              teamId: campaign.teamId,
              campaignId: campaign.id,
              previewText: campaign.previewText ?? undefined,
              domainId: domain.id,
              region: domain.region,
            },
          });
        } catch (err) {
          logger.error(
            { err, contactId: contact.id, campaignId },
            "Failed to process contact; skipping to next",
          );
          try {
            await recordCampaignContactFailure({
              contact: toContact(contact),
              campaign,
              emailConfig: {
                replyTo: Array.isArray(campaign.replyTo)
                  ? campaign.replyTo
                  : [],
                cc: Array.isArray(campaign.cc) ? campaign.cc : [],
                bcc: Array.isArray(campaign.bcc) ? campaign.bcc : [],
                teamId: campaign.teamId,
                domainId: domain.id,
              },
              error: err,
            });
          } catch (recordErr) {
            logger.error(
              { err: recordErr, contactId: contact.id, campaignId },
              "Failed to record campaign contact failure; skipping to next",
            );
          }
        }
      }

      // Advance cursor and timestamp
      const newCursor = contacts[contacts.length - 1]?.id;
      await drizzleDb
        .update(schema.campaign)
        .set(withUpdatedAt({ lastCursor: newCursor, lastSentAt: new Date() }))
        .where(eq(schema.campaign.id, campaignId));
    }),
    { concurrency: 20 },
  );

  static async queueBatch({
    campaignId,
    teamId,
  }: {
    campaignId: string;
    teamId?: number;
  }) {
    // Defensive check: avoid enqueue if window not elapsed (scheduler already enforces)
    try {
      const [campaign] = await drizzleDb
        .select({
          lastSentAt: schema.campaign.lastSentAt,
          batchWindowMinutes: schema.campaign.batchWindowMinutes,
          status: schema.campaign.status,
        })
        .from(schema.campaign)
        .where(eq(schema.campaign.id, campaignId))
        .limit(1);
      if (!campaign) return;
      if (campaign.status === "PAUSED" || campaign.status === "SENT") return;
      const windowMin = campaign.batchWindowMinutes ?? 0;
      if (windowMin > 0 && campaign.lastSentAt) {
        const elapsedMs = Date.now() - new Date(campaign.lastSentAt).getTime();
        const windowMs = windowMin * 60 * 1000;
        if (elapsedMs < windowMs) {
          logger.debug(
            { campaignId, remainingMs: windowMs - elapsedMs },
            "Defensive skip enqueue; window not elapsed",
          );
          return;
        }
      }
    } catch (err) {
      logger.warn(
        { err, campaignId },
        "Failed defensive window check; proceeding to enqueue",
      );
    }

    await this.batchQueue.enqueue(
      `campaign-${campaignId}`,
      { campaignId, teamId },
      { jobId: `campaign-batch-${campaignId}` },
    );
  }
}
