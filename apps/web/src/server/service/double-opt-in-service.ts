import { DomainStatus } from "@prisma/client";
import { createHash, timingSafeEqual } from "crypto";
import { EmailRenderer } from "@usesend/email-editor/src/renderer";
import { env } from "~/env";
import {
  DEFAULT_DOUBLE_OPT_IN_CONTENT,
  DEFAULT_DOUBLE_OPT_IN_SUBJECT,
} from "~/lib/constants/double-opt-in";
import { and, asc, eq } from "drizzle-orm";
import { drizzleDb, schema } from "../drizzle";
import { withUpdatedAt } from "../drizzle/touch";
import { logger } from "../logger/log";
import { sendEmail } from "./email-service";
import { validateDomainFromEmail } from "./domain-service";

const DOUBLE_OPT_IN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

function createDoubleOptInHash(contactId: string, expiresAt: number) {
  return createHash("sha256")
    .update(`${contactId}-${expiresAt}-${env.NEXTAUTH_SECRET}`)
    .digest("hex");
}

function replaceTemplateTokens(
  value: string,
  variables: Record<string, string | undefined>,
) {
  return Object.entries(variables).reduce((acc, [key, replacement]) => {
    if (replacement === undefined) {
      return acc;
    }

    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tokenRegex = new RegExp(`\\{\\{\\s*${escapedKey}\\s*\\}\\}`, "gi");
    return acc.replace(tokenRegex, replacement);
  }, value);
}

function createDoubleOptInConfirmationUrl(contactId: string) {
  const expiresAt = Date.now() + DOUBLE_OPT_IN_EXPIRY_MS;
  const hash = createDoubleOptInHash(contactId, expiresAt);
  const searchParams = new URLSearchParams({
    contactId,
    expiresAt: String(expiresAt),
    hash,
  });

  return `${env.NEXTAUTH_URL}/subscribe?${searchParams.toString()}`;
}

export async function sendDoubleOptInConfirmationEmail({
  contactId,
  contactBookId,
  teamId,
}: {
  contactId: string;
  contactBookId: string;
  teamId: number;
}) {
  const [row] = await drizzleDb
    .select({
      id: schema.contact.id,
      email: schema.contact.email,
      firstName: schema.contact.firstName,
      lastName: schema.contact.lastName,
      contactBookId: schema.contact.contactBookId,
      book: {
        id: schema.contactBook.id,
        name: schema.contactBook.name,
        doubleOptInEnabled: schema.contactBook.doubleOptInEnabled,
        doubleOptInFrom: schema.contactBook.doubleOptInFrom,
        doubleOptInSubject: schema.contactBook.doubleOptInSubject,
        doubleOptInContent: schema.contactBook.doubleOptInContent,
      },
    })
    .from(schema.contact)
    .innerJoin(
      schema.contactBook,
      eq(schema.contactBook.id, schema.contact.contactBookId),
    )
    .where(eq(schema.contact.id, contactId))
    .limit(1);

  // Reshaped to Prisma's nested include so the rest of the function is unchanged.
  const contact = row ? { ...row, contactBook: row.book } : null;

  if (!contact || contact.contactBookId !== contactBookId) {
    throw new Error("Contact not found for double opt-in email");
  }

  if (!contact.contactBook.doubleOptInEnabled) {
    return;
  }

  const configuredFrom = contact.contactBook.doubleOptInFrom?.trim();
  let from: string;

  if (!configuredFrom) {
    const [domain] = await drizzleDb
      .select({ name: schema.domain.name })
      .from(schema.domain)
      .where(
        and(
          eq(schema.domain.teamId, teamId),
          eq(schema.domain.status, DomainStatus.SUCCESS),
        ),
      )
      .orderBy(asc(schema.domain.createdAt))
      .limit(1);

    if (!domain) {
      throw new Error(
        "Double opt-in requires at least one verified domain to send confirmation emails",
      );
    }

    from = `hello@${domain.name}`;
  } else {
    from = configuredFrom;
  }

  const confirmationUrl = createDoubleOptInConfirmationUrl(contact.id);

  const variableValues: Record<string, string> = {
    email: contact.email,
    firstName: contact.firstName ?? "",
    lastName: contact.lastName ?? "",
    doubleOptInUrl: confirmationUrl,
  };

  const content =
    contact.contactBook.doubleOptInContent ?? DEFAULT_DOUBLE_OPT_IN_CONTENT;

  let html: string;

  try {
    const renderer = new EmailRenderer(JSON.parse(content));
    html = await renderer.render({
      shouldReplaceVariableValues: true,
      variableValues,
      linkValues: {
        "{{doubleOptInUrl}}": confirmationUrl,
        doubleOptInUrl: confirmationUrl,
      },
    });
  } catch (error) {
    logger.error(
      {
        error,
        contactBookId,
      },
      "[DoubleOptInService]: Failed to render custom template, using fallback HTML",
    );

    html = `<p>Please confirm your subscription by clicking <a href="${confirmationUrl}">this link</a>.</p>`;
  }

  const subject = replaceTemplateTokens(
    contact.contactBook.doubleOptInSubject ?? DEFAULT_DOUBLE_OPT_IN_SUBJECT,
    variableValues,
  );

  await validateDomainFromEmail(from, teamId);

  await sendEmail({
    to: contact.email,
    from,
    subject,
    html: replaceTemplateTokens(html, { doubleOptInUrl: confirmationUrl }),
    teamId,
  });
}

export async function confirmDoubleOptInSubscription({
  contactId,
  expiresAt,
  hash,
}: {
  contactId: string;
  expiresAt: string;
  hash: string;
}) {
  const expiresAtTimestamp = Number(expiresAt);

  if (!Number.isFinite(expiresAtTimestamp)) {
    throw new Error("Invalid confirmation link");
  }

  if (Date.now() > expiresAtTimestamp) {
    throw new Error("Confirmation link has expired");
  }

  const expectedHash = createDoubleOptInHash(contactId, expiresAtTimestamp);
  const providedHashBuffer = Buffer.from(hash, "utf-8");
  const expectedHashBuffer = Buffer.from(expectedHash, "utf-8");
  if (
    providedHashBuffer.length !== expectedHashBuffer.length ||
    !timingSafeEqual(providedHashBuffer, expectedHashBuffer)
  ) {
    throw new Error("Invalid confirmation link");
  }

  const [existingContact] = await drizzleDb
    .select()
    .from(schema.contact)
    .where(eq(schema.contact.id, contactId))
    .limit(1);

  if (!existingContact) {
    throw new Error("Contact not found");
  }

  if (existingContact.subscribed || existingContact.unsubscribeReason != null) {
    return existingContact;
  }

  const [updated] = await drizzleDb
    .update(schema.contact)
    .set(withUpdatedAt({ subscribed: true, unsubscribeReason: null }))
    .where(eq(schema.contact.id, contactId))
    .returning();

  if (!updated) {
    throw new Error("Contact not found");
  }

  return updated;
}
