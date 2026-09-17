import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";

import { AppError, badRequest, notFound } from "~/server/app-error";
import { drizzleDb, schema } from "~/server/drizzle";
import {
  contactBookMiddleware,
  teamMiddleware,
} from "~/server/functions/middleware";
import * as contactBookService from "~/server/service/contact-book-service";
import * as contactService from "~/server/service/contact-service";

/**
 * Contact books and the contacts in them, from
 * `server/api/routers/contacts.ts` (#9).
 *
 * Everything below the book level goes through `contactBookMiddleware`, so a
 * contact is only ever addressed as "this contact, in this book, of this
 * team" — `contactService` takes all three and the contact id alone is never
 * enough. That is why the delete and update functions can return `NOT_FOUND`
 * for a contact that plainly exists: it exists in somebody else's book.
 *
 * The two list queries are written out here rather than pushed into the
 * service because they are the same `ILIKE` filter over a paginated read and
 * an uncapped export, and keeping them side by side is what stops the two
 * drifting.
 */

/**
 * `properties` is a jsonb column and Drizzle types it `unknown`, which Start
 * refuses to return from a server function — it cannot prove a value it knows
 * nothing about will survive the wire, and the check is a good one.
 *
 * tRPC never had to answer the question because superjson would take whatever
 * it was handed, so the routers cast at each *read* site instead and the
 * mutations returned `unknown` to a dashboard that was already treating it as
 * a string map. The coercion belongs here, at the seam, once.
 */
const withStringProperties = <T extends { properties: unknown }>(row: T) => ({
  ...row,
  properties: (row.properties ?? {}) as Record<string, string>,
});

export const getContactBooks = createServerFn({ method: "GET" })
  .middleware([teamMiddleware])
  .validator(z.object({ search: z.string().optional() }))
  .handler(({ data, context }) =>
    contactBookService.getContactBooks(context.team.id, data.search),
  );

export const createContactBook = createServerFn({ method: "POST" })
  .middleware([teamMiddleware])
  .validator(
    z.object({
      name: z.string(),
      variables: z.array(z.string()).optional(),
    }),
  )
  .handler(async ({ data, context }) =>
    withStringProperties(
      await contactBookService.createContactBook(
        context.team.id,
        data.name,
        data.variables,
      ),
    ),
  );

export const getContactBookDetails = createServerFn({ method: "GET" })
  .middleware([contactBookMiddleware])
  .handler(async ({ context }) => {
    const { contactBook } = context;
    const { totalContacts, unsubscribedContacts, campaigns } =
      await contactBookService.getContactBookDetails(contactBook.id);

    return {
      ...withStringProperties(contactBook),
      totalContacts,
      unsubscribedContacts,
      campaigns,
    };
  });

export const updateContactBook = createServerFn({ method: "POST" })
  .middleware([contactBookMiddleware])
  .validator(
    z.object({
      name: z.string().optional(),
      properties: z.record(z.string()).optional(),
      emoji: z.string().optional(),
      doubleOptInEnabled: z.boolean().optional(),
      doubleOptInFrom: z.string().nullable().optional(),
      doubleOptInSubject: z.string().optional(),
      doubleOptInContent: z.string().optional(),
      variables: z.array(z.string()).optional(),
    }),
  )
  .handler(async ({ data, context }) =>
    withStringProperties(
      await contactBookService.updateContactBook(context.contactBook.id, data),
    ),
  );

export const deleteContactBook = createServerFn({ method: "POST" })
  .middleware([contactBookMiddleware])
  .handler(async ({ context }) =>
    withStringProperties(
      await contactBookService.deleteContactBook(context.contactBook.id),
    ),
  );

export const contacts = createServerFn({ method: "GET" })
  .middleware([contactBookMiddleware])
  .validator(
    z.object({
      page: z.number().optional(),
      subscribed: z.boolean().optional(),
      search: z.string().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const page = data.page || 1;
    const limit = 30;
    const offset = (page - 1) * limit;

    const where = and(
      eq(schema.contact.contactBookId, context.contactBook.id),
      data.subscribed !== undefined
        ? eq(schema.contact.subscribed, data.subscribed)
        : undefined,
      data.search
        ? or(
            ilike(schema.contact.email, `%${data.search}%`),
            ilike(schema.contact.firstName, `%${data.search}%`),
            ilike(schema.contact.lastName, `%${data.search}%`),
          )
        : undefined,
    );

    const countP = drizzleDb.$count(schema.contact, where);

    const contactsP = drizzleDb
      .select({
        id: schema.contact.id,
        email: schema.contact.email,
        firstName: schema.contact.firstName,
        lastName: schema.contact.lastName,
        properties: schema.contact.properties,
        subscribed: schema.contact.subscribed,
        createdAt: schema.contact.createdAt,
        contactBookId: schema.contact.contactBookId,
        unsubscribeReason: schema.contact.unsubscribeReason,
      })
      .from(schema.contact)
      .where(where)
      .orderBy(desc(schema.contact.createdAt))
      .offset(offset)
      .limit(limit);

    const [rows, count] = await Promise.all([contactsP, countP]);

    // jsonb reads as `unknown` in Drizzle; the list expects a string map.
    const list = rows.map((row) => ({
      ...row,
      properties: (row.properties ?? {}) as Record<string, string>,
    }));

    return { contacts: list, totalPage: Math.ceil(count / limit) };
  });

export const addContacts = createServerFn({ method: "POST" })
  .middleware([contactBookMiddleware])
  .validator(
    z.object({
      contacts: z
        .array(
          z.object({
            email: z.string(),
            firstName: z.string().optional(),
            lastName: z.string().optional(),
            properties: z.record(z.string()).optional(),
            subscribed: z.boolean().optional(),
          }),
        )
        .max(50000),
    }),
  )
  .handler(({ data, context }) =>
    contactService.bulkAddContacts(
      context.contactBook.id,
      data.contacts,
      context.team.id,
    ),
  );

export const updateContact = createServerFn({ method: "POST" })
  .middleware([contactBookMiddleware])
  .validator(
    z.object({
      contactId: z.string(),
      email: z.string().optional(),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      properties: z.record(z.string()).optional(),
      subscribed: z.boolean().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const { contactId, ...contact } = data;
    const updatedContact = await contactService.updateContactInContactBook(
      contactId,
      context.contactBook.id,
      contact,
      context.team.id,
    );

    if (!updatedContact) {
      throw notFound("Contact not found");
    }

    return withStringProperties(updatedContact);
  });

export const deleteContact = createServerFn({ method: "POST" })
  .middleware([contactBookMiddleware])
  .validator(z.object({ contactId: z.string() }))
  .handler(async ({ data, context }) => {
    const deletedContact = await contactService.deleteContactInContactBook(
      data.contactId,
      context.contactBook.id,
      context.team.id,
    );

    if (!deletedContact) {
      throw notFound("Contact not found");
    }

    return withStringProperties(deletedContact);
  });

export const bulkDeleteContacts = createServerFn({ method: "POST" })
  .middleware([contactBookMiddleware])
  .validator(z.object({ contactIds: z.array(z.string()).min(1).max(1000) }))
  .handler(async ({ data, context }) => {
    const deletedContacts =
      await contactService.bulkDeleteContactsInContactBook(
        data.contactIds,
        context.contactBook.id,
        context.team.id,
      );

    return { count: deletedContacts.length };
  });

/**
 * The service throws a bare `Error` for the one refusal a user can act on —
 * a contact who is already confirmed has nothing to re-confirm — so it is
 * matched on its message and turned into `BAD_REQUEST`. Everything else is
 * left alone rather than flattened into a 400.
 */
export const resendDoubleOptInConfirmation = createServerFn({ method: "POST" })
  .middleware([contactBookMiddleware])
  .validator(z.object({ contactId: z.string() }))
  .handler(async ({ data, context }) => {
    try {
      const contact =
        await contactService.resendDoubleOptInConfirmationInContactBook(
          data.contactId,
          context.contactBook.id,
          context.team.id,
        );

      if (!contact) {
        throw notFound("Contact not found");
      }

      return { success: true };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      if (
        error instanceof Error &&
        error.message ===
          "Double opt-in confirmation can only be resent to pending contacts"
      ) {
        throw badRequest(error.message);
      }

      throw error;
    }
  });

export const exportContacts = createServerFn({ method: "GET" })
  .middleware([contactBookMiddleware])
  .validator(
    z.object({
      subscribed: z.boolean().optional(),
      search: z.string().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const where = and(
      eq(schema.contact.contactBookId, context.contactBook.id),
      data.subscribed !== undefined
        ? eq(schema.contact.subscribed, data.subscribed)
        : undefined,
      data.search
        ? or(
            ilike(schema.contact.email, `%${data.search}%`),
            ilike(schema.contact.firstName, `%${data.search}%`),
            ilike(schema.contact.lastName, `%${data.search}%`),
          )
        : undefined,
    );

    return drizzleDb
      .select({
        email: schema.contact.email,
        firstName: schema.contact.firstName,
        lastName: schema.contact.lastName,
        properties: schema.contact.properties,
        subscribed: schema.contact.subscribed,
        unsubscribeReason: schema.contact.unsubscribeReason,
        createdAt: schema.contact.createdAt,
      })
      .from(schema.contact)
      .where(where)
      .orderBy(desc(schema.contact.createdAt))
      .limit(100000) // Cap to prevent memory issues
      .then((rows) =>
        rows.map((row) => ({
          ...row,
          properties: (row.properties ?? {}) as Record<string, string>,
        })),
      );
  });
