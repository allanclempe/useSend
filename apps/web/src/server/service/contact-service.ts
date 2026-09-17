import { UnsubscribeReason } from "~/types/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  type ContactPayload,
  type ContactWebhookEventType,
} from "@usesend/lib/src/webhook/webhook-events";
import {
  mergeContactProperties,
  normalizeContactProperties,
} from "~/lib/contact-properties";
import { drizzleDb, schema } from "../drizzle";
import { createId } from "../drizzle/id";
import { withUpdatedAt } from "../drizzle/touch";
import { ContactQueueService } from "./contact-queue-service";
import { WebhookService } from "./webhook-service";
import { logger } from "../logger/log";
import { sendDoubleOptInConfirmationEmail } from "./double-opt-in-service";

type Contact = typeof schema.contact.$inferSelect;

export type ContactInput = {
  email: string;
  firstName?: string;
  lastName?: string;
  properties?: Record<string, string>;
  subscribed?: boolean;
};

export async function addOrUpdateContact(
  contactBookId: string,
  contact: ContactInput,
  teamId?: number,
) {
  const [contactBook] = await drizzleDb
    .select({
      doubleOptInEnabled: schema.contactBook.doubleOptInEnabled,
      teamId: schema.contactBook.teamId,
      variables: schema.contactBook.variables,
    })
    .from(schema.contactBook)
    .where(eq(schema.contactBook.id, contactBookId))
    .limit(1);

  if (!contactBook) {
    throw new Error("Contact book not found");
  }

  // Check if contact exists to handle subscribed logic
  const [existingContact] = await drizzleDb
    .select({
      subscribed: schema.contact.subscribed,
      unsubscribeReason: schema.contact.unsubscribeReason,
      properties: schema.contact.properties,
    })
    .from(schema.contact)
    .where(
      and(
        eq(schema.contact.contactBookId, contactBookId),
        eq(schema.contact.email, contact.email),
      ),
    )
    .limit(1);

  // Determine subscribed value for update
  // Only allow Yes→No transitions (allow unsubscribe, prevent re-subscribe)
  let subscribedValue: boolean | undefined = contact.subscribed;
  if (existingContact && contact.subscribed !== undefined) {
    // Block No→Yes (prevent re-subscribe via CSV), allow all other transitions
    if (!existingContact.subscribed && contact.subscribed) {
      subscribedValue = undefined; // Block re-subscribe
    }
    // All other cases (Yes→No, Yes→Yes, No→No) are allowed naturally
  }

  const isExplicitUnsubscribeRequest = contact.subscribed === false;

  const shouldSendDoubleOptIn =
    contactBook.doubleOptInEnabled &&
    !isExplicitUnsubscribeRequest &&
    (!existingContact ||
      (!existingContact.subscribed &&
        existingContact.unsubscribeReason === null));

  const shouldCreatePendingContact =
    contactBook.doubleOptInEnabled &&
    existingContact === undefined &&
    !isExplicitUnsubscribeRequest;

  const normalizedProperties =
    contact.properties === undefined
      ? undefined
      : normalizeContactProperties(contact.properties, contactBook.variables);
  const mergedProperties =
    normalizedProperties === undefined
      ? undefined
      : mergeContactProperties(
          (existingContact?.properties as Record<string, unknown> | null) ?? {},
          normalizedProperties,
          contactBook.variables,
        );

  // Prisma omitted `undefined` fields from an update; build the conflict payload
  // explicitly so a missing firstName does not blank an existing one.
  const conflictUpdate: Partial<typeof schema.contact.$inferInsert> = {
    ...(contact.firstName !== undefined
      ? { firstName: contact.firstName }
      : {}),
    ...(contact.lastName !== undefined ? { lastName: contact.lastName } : {}),
    ...(mergedProperties !== undefined
      ? { properties: mergedProperties }
      : {}),
    ...(subscribedValue !== undefined
      ? {
          subscribed: subscribedValue,
          unsubscribeReason: subscribedValue
            ? null
            : UnsubscribeReason.UNSUBSCRIBED,
        }
      : {}),
  };

  const [savedContact] = await drizzleDb
    .insert(schema.contact)
    .values(
      withUpdatedAt({
        id: createId(),
        contactBookId,
        email: contact.email,
        firstName: contact.firstName,
        lastName: contact.lastName,
        properties: normalizedProperties ?? {},
        subscribed: shouldCreatePendingContact
          ? false
          : (contact.subscribed ?? true),
        unsubscribeReason: shouldCreatePendingContact
          ? null
          : contact.subscribed === false
            ? UnsubscribeReason.UNSUBSCRIBED
            : null,
      }),
    )
    .onConflictDoUpdate({
      target: [schema.contact.contactBookId, schema.contact.email],
      // withUpdatedAt also guarantees a non-empty SET. Prisma accepted
      // `update: {}` as a no-op that still bumped @updatedAt; Drizzle would
      // generate invalid SQL for an empty set, and this matches the old
      // behaviour rather than working around it.
      set: withUpdatedAt(conflictUpdate),
    })
    .returning();

  if (!savedContact) {
    throw new Error("Failed to save contact");
  }

  if (shouldSendDoubleOptIn) {
    try {
      await sendDoubleOptInConfirmationEmail({
        contactId: savedContact.id,
        contactBookId,
        teamId: teamId ?? contactBook.teamId,
      });
    } catch (error) {
      logger.error(
        {
          error,
          contactId: savedContact.id,
          contactBookId,
          teamId: teamId ?? contactBook.teamId,
        },
        "[ContactService]: Failed to send double opt-in confirmation email",
      );
    }
  }

  const eventType: ContactWebhookEventType = existingContact
    ? "contact.updated"
    : "contact.created";

  await emitContactEvent(savedContact, eventType, teamId);

  return savedContact;
}

export async function getContactInContactBook(
  contactId: string,
  contactBookId: string,
) {
  const [found] = await drizzleDb
    .select()
    .from(schema.contact)
    .where(
      and(
        eq(schema.contact.id, contactId),
        eq(schema.contact.contactBookId, contactBookId),
      ),
    )
    .limit(1);

  return found ?? null;
}

export async function updateContactInContactBook(
  contactId: string,
  contactBookId: string,
  contact: Partial<ContactInput>,
  teamId?: number,
) {
  const existingContact = await getContactInContactBook(
    contactId,
    contactBookId,
  );

  if (!existingContact) {
    return null;
  }

  const [contactBook] = await drizzleDb
    .select({ variables: schema.contactBook.variables })
    .from(schema.contactBook)
    .where(eq(schema.contactBook.id, contactBookId))
    .limit(1);

  const mergedProperties =
    contact.properties === undefined
      ? undefined
      : mergeContactProperties(
          (existingContact.properties as Record<string, unknown> | null) ?? {},
          contact.properties,
          contactBook?.variables ?? [],
        );

  const [updatedContact] = await drizzleDb
    .update(schema.contact)
    .set(
      withUpdatedAt({
        ...contact,
        ...(mergedProperties !== undefined
          ? { properties: mergedProperties }
          : {}),
        ...(contact.subscribed !== undefined
          ? {
              unsubscribeReason: contact.subscribed
                ? null
                : UnsubscribeReason.UNSUBSCRIBED,
            }
          : {}),
      }),
    )
    .where(eq(schema.contact.id, contactId))
    .returning();

  if (!updatedContact) {
    return null;
  }

  await emitContactEvent(updatedContact, "contact.updated", teamId);

  return updatedContact;
}

export async function deleteContactInContactBook(
  contactId: string,
  contactBookId: string,
  teamId?: number,
) {
  const existingContact = await getContactInContactBook(
    contactId,
    contactBookId,
  );

  if (!existingContact) {
    return null;
  }

  const [deletedContact] = await drizzleDb
    .delete(schema.contact)
    .where(eq(schema.contact.id, contactId))
    .returning();

  if (!deletedContact) {
    return null;
  }

  await emitContactEvent(deletedContact, "contact.deleted", teamId);

  return deletedContact;
}

export async function bulkDeleteContactsInContactBook(
  contactIds: string[],
  contactBookId: string,
  teamId?: number,
) {
  const contacts = await drizzleDb
    .select()
    .from(schema.contact)
    .where(
      and(
        inArray(schema.contact.id, contactIds),
        eq(schema.contact.contactBookId, contactBookId),
      ),
    );

  if (contacts.length === 0) {
    return [];
  }

  await drizzleDb.delete(schema.contact).where(
    and(
      inArray(
        schema.contact.id,
        contacts.map((c) => c.id),
      ),
      eq(schema.contact.contactBookId, contactBookId),
    ),
  );

  await Promise.all(
    contacts.map((contact) =>
      emitContactEvent(contact, "contact.deleted", teamId),
    ),
  );

  return contacts;
}

export async function resendDoubleOptInConfirmationInContactBook(
  contactId: string,
  contactBookId: string,
  teamId?: number,
) {
  const existingContact = await getContactInContactBook(
    contactId,
    contactBookId,
  );

  if (!existingContact) {
    return null;
  }

  const isPendingConfirmation =
    !existingContact.subscribed && existingContact.unsubscribeReason === null;

  if (!isPendingConfirmation) {
    throw new Error(
      "Double opt-in confirmation can only be resent to pending contacts",
    );
  }

  const resolvedTeamId =
    teamId ??
    (
      await drizzleDb
        .select({ teamId: schema.contactBook.teamId })
        .from(schema.contactBook)
        .where(eq(schema.contactBook.id, contactBookId))
        .limit(1)
    )[0]?.teamId;

  if (!resolvedTeamId) {
    throw new Error("Team not found for contact book");
  }

  await sendDoubleOptInConfirmationEmail({
    contactId: existingContact.id,
    contactBookId,
    teamId: resolvedTeamId,
  });

  return existingContact;
}

export async function bulkAddContacts(
  contactBookId: string,
  contacts: Array<ContactInput>,
  teamId?: number,
) {
  await ContactQueueService.addBulkContactJobs(contactBookId, contacts, teamId);

  return {
    message: `Queued ${contacts.length} contacts for processing`,
    count: contacts.length,
  };
}

export async function unsubscribeContact(contactId: string) {
  await drizzleDb
    .update(schema.contact)
    .set(
      withUpdatedAt({
        subscribed: false,
        unsubscribeReason: UnsubscribeReason.UNSUBSCRIBED,
      }),
    )
    .where(eq(schema.contact.id, contactId));
}

export async function subscribeContact(contactId: string) {
  await drizzleDb
    .update(schema.contact)
    .set(withUpdatedAt({ subscribed: true, unsubscribeReason: null }))
    .where(eq(schema.contact.id, contactId));
}

export async function updateContactSubscription({
  contactId,
  subscribed,
  unsubscribeReason,
  teamId,
}: {
  contactId: string;
  subscribed: boolean;
  unsubscribeReason: UnsubscribeReason | null;
  teamId?: number;
}) {
  const [updatedContact] = await drizzleDb
    .update(schema.contact)
    .set(withUpdatedAt({ subscribed, unsubscribeReason }))
    .where(eq(schema.contact.id, contactId))
    .returning();

  if (!updatedContact) {
    throw new Error("Contact not found");
  }

  await emitContactEvent(updatedContact, "contact.updated", teamId);

  return updatedContact;
}

function buildContactPayload(contact: Contact): ContactPayload {
  return {
    id: contact.id,
    email: contact.email,
    contactBookId: contact.contactBookId,
    subscribed: contact.subscribed,
    properties: (contact.properties ?? {}) as Record<string, unknown>,
    firstName: contact.firstName,
    lastName: contact.lastName,
    createdAt: contact.createdAt.toISOString(),
    updatedAt: contact.updatedAt.toISOString(),
  };
}

async function emitContactEvent(
  contact: Contact,
  type: ContactWebhookEventType,
  teamId?: number,
) {
  try {
    const resolvedTeamId =
      teamId ??
      (
        await drizzleDb
          .select({ teamId: schema.contactBook.teamId })
          .from(schema.contactBook)
          .where(eq(schema.contactBook.id, contact.contactBookId))
          .limit(1)
      )[0]?.teamId;

    if (!resolvedTeamId) {
      logger.warn(
        { contactId: contact.id },
        "[ContactService]: Skipping webhook emission, teamId not found",
      );
      return;
    }

    await WebhookService.emit(
      resolvedTeamId,
      type,
      buildContactPayload(contact),
    );
  } catch (error) {
    logger.error(
      { error, contactId: contact.id, type },
      "[ContactService]: Failed to emit contact webhook event",
    );
  }
}
