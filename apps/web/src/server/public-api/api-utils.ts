import { Context } from "hono";
import { and, eq } from "drizzle-orm";
import { drizzleDb, schema } from "../drizzle";
import { UnsendApiError } from "./api-error";

export const getContactBook = async (c: Context, teamId: number) => {
  const contactBookId = c.req.param("contactBookId");

  if (!contactBookId) {
    throw new UnsendApiError({
      code: "BAD_REQUEST",
      message: "contactBookId is mandatory",
    });
  }

  const [contactBook] = await drizzleDb
    .select()
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
      code: "NOT_FOUND",
      message: "Contact book not found for this team",
    });
  }

  return contactBook;
};

export const checkIsValidEmailId = async (emailId: string, teamId: number) => {
  const [email] = await drizzleDb
    .select({ id: schema.email.id })
    .from(schema.email)
    .where(and(eq(schema.email.id, emailId), eq(schema.email.teamId, teamId)))
    .limit(1);

  if (!email) {
    throw new UnsendApiError({ code: "NOT_FOUND", message: "Email not found" });
  }
};

export const checkIsValidEmailIdWithDomainRestriction = async (
  emailId: string, 
  teamId: number, 
  apiKeyDomainId?: number
) => {
  const [email] = await drizzleDb
    .select()
    .from(schema.email)
    .where(
      and(
        eq(schema.email.id, emailId),
        eq(schema.email.teamId, teamId),
        // Domain-restricted keys can only reach emails on their own domain.
        apiKeyDomainId !== undefined
          ? eq(schema.email.domainId, apiKeyDomainId)
          : undefined,
      ),
    )
    .limit(1);

  if (!email) {
    throw new UnsendApiError({ code: "NOT_FOUND", message: "Email not found" });
  }

  return email;
};
