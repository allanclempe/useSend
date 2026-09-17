import { CampaignStatus } from "@prisma/client";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import { drizzleDb, schema } from "~/server/drizzle";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  contactBookProcedure,
  createTRPCRouter,
  teamProcedure,
} from "~/server/api/trpc";
import * as contactService from "~/server/service/contact-service";
import * as contactBookService from "~/server/service/contact-book-service";

export const contactsRouter = createTRPCRouter({
  getContactBooks: teamProcedure
    .input(z.object({ search: z.string().optional() }))
    .query(async ({ ctx: { team }, input }) => {
      return contactBookService.getContactBooks(team.id, input.search);
    }),

  createContactBook: teamProcedure
    .input(
      z.object({
        name: z.string(),
        variables: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ ctx: { team }, input }) => {
      const { name, variables } = input;
      return contactBookService.createContactBook(team.id, name, variables);
    }),

  getContactBookDetails: contactBookProcedure.query(
    async ({ ctx: { contactBook } }) => {
      const { totalContacts, unsubscribedContacts, campaigns } =
        await contactBookService.getContactBookDetails(contactBook.id);

      return {
        ...contactBook,
        totalContacts,
        unsubscribedContacts,
        campaigns,
      };
    },
  ),

  updateContactBook: contactBookProcedure
    .input(
      z.object({
        contactBookId: z.string(),
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
    .mutation(async ({ ctx: { contactBook }, input }) => {
      const { contactBookId, ...data } = input;
      return contactBookService.updateContactBook(contactBook.id, data);
    }),

  deleteContactBook: contactBookProcedure
    .input(z.object({ contactBookId: z.string() }))
    .mutation(async ({ ctx: { contactBook }, input }) => {
      return contactBookService.deleteContactBook(contactBook.id);
    }),

  contacts: contactBookProcedure
    .input(
      z.object({
        page: z.number().optional(),
        subscribed: z.boolean().optional(),
        search: z.string().optional(),
      }),
    )
    .query(async ({ input }) => {
      const page = input.page || 1;
      const limit = 30;
      const offset = (page - 1) * limit;

      const where = and(
        eq(schema.contact.contactBookId, input.contactBookId),
        input.subscribed !== undefined
          ? eq(schema.contact.subscribed, input.subscribed)
          : undefined,
        input.search
          ? or(
              ilike(schema.contact.email, `%${input.search}%`),
              ilike(schema.contact.firstName, `%${input.search}%`),
              ilike(schema.contact.lastName, `%${input.search}%`),
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
      const contacts = rows.map((row) => ({
        ...row,
        properties: (row.properties ?? {}) as Record<string, string>,
      }));

      return { contacts, totalPage: Math.ceil(count / limit) };
    }),

  addContacts: contactBookProcedure
    .input(
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
    .mutation(async ({ ctx: { contactBook, team }, input }) => {
      return contactService.bulkAddContacts(
        contactBook.id,
        input.contacts,
        team.id,
      );
    }),

  updateContact: contactBookProcedure
    .input(
      z.object({
        contactId: z.string(),
        email: z.string().optional(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        properties: z.record(z.string()).optional(),
        subscribed: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx: { contactBook, team }, input }) => {
      const { contactId, ...contact } = input;
      const updatedContact = await contactService.updateContactInContactBook(
        contactId,
        contactBook.id,
        contact,
        team.id,
      );

      if (!updatedContact) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Contact not found",
        });
      }

      return updatedContact;
    }),

  deleteContact: contactBookProcedure
    .input(z.object({ contactId: z.string() }))
    .mutation(async ({ ctx: { contactBook, team }, input }) => {
      const deletedContact = await contactService.deleteContactInContactBook(
        input.contactId,
        contactBook.id,
        team.id,
      );

      if (!deletedContact) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Contact not found",
        });
      }

      return deletedContact;
    }),

  bulkDeleteContacts: contactBookProcedure
    .input(z.object({ contactIds: z.array(z.string()).min(1).max(1000) }))
    .mutation(async ({ ctx: { contactBook, team }, input }) => {
      const deletedContacts =
        await contactService.bulkDeleteContactsInContactBook(
          input.contactIds,
          contactBook.id,
          team.id,
        );

      return { count: deletedContacts.length };
    }),

  resendDoubleOptInConfirmation: contactBookProcedure
    .input(z.object({ contactId: z.string() }))
    .mutation(async ({ ctx: { contactBook, team }, input }) => {
      try {
        const contact =
          await contactService.resendDoubleOptInConfirmationInContactBook(
            input.contactId,
            contactBook.id,
            team.id,
          );

        if (!contact) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Contact not found",
          });
        }

        return { success: true };
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }

        if (
          error instanceof Error &&
          error.message ===
            "Double opt-in confirmation can only be resent to pending contacts"
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: error.message,
          });
        }

        throw error;
      }
    }),

  exportContacts: contactBookProcedure
    .input(
      z.object({
        subscribed: z.boolean().optional(),
        search: z.string().optional(),
      }),
    )
    .query(async ({ input }) => {
      const where = and(
        eq(schema.contact.contactBookId, input.contactBookId),
        input.subscribed !== undefined
          ? eq(schema.contact.subscribed, input.subscribed)
          : undefined,
        input.search
          ? or(
              ilike(schema.contact.email, `%${input.search}%`),
              ilike(schema.contact.firstName, `%${input.search}%`),
              ilike(schema.contact.lastName, `%${input.search}%`),
            )
          : undefined,
      );

      const contacts = await drizzleDb
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

      return contacts;
    }),
});
