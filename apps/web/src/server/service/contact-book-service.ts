import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { createId } from "../drizzle/id";
import { withUpdatedAt } from "../drizzle/touch";
import {
  DEFAULT_DOUBLE_OPT_IN_CONTENT,
  DEFAULT_DOUBLE_OPT_IN_SUBJECT,
  hasDoubleOptInUrlPlaceholder,
} from "~/lib/constants/double-opt-in";
import { drizzleDb, schema } from "../drizzle";
import { UnsendApiError } from "../public-api/api-error";
import { validateDomainFromEmail } from "./domain-service";
import { LimitService } from "./limit-service";
import {
  normalizeContactBookVariables,
  validateContactBookVariables,
} from "./contact-variable-service";

/**
 * Accepts the root client or a transaction, so callers can compose several of
 * these into one atomic unit — see public-api/api/contacts/create-contact-book.
 */
export type ContactBookDbClient =
  | typeof drizzleDb
  | Parameters<Parameters<(typeof drizzleDb)["transaction"]>[0]>[0];

/**
 * Counts contacts per book.
 *
 * A LEFT JOIN + GROUP BY rather than a correlated subquery: inside a raw `sql`
 * template Drizzle renders columns unqualified, so
 * `WHERE ${contact.contactBookId} = ${contactBook.id}` becomes
 * `WHERE "contactBookId" = "id"` — and "id" then resolves against Contact, not
 * ContactBook. That compares a column to itself, matches nothing, and returns 0
 * without erroring. The join keeps qualification Drizzle's problem.
 *
 * `COUNT(col)` skips NULLs, so a book with no contacts is 0 rather than 1.
 *
 * The `::integer` cast matters: Postgres COUNT returns bigint, which
 * postgres-js hands back as a string.
 */
const contactCountSql = sql<number>`COUNT(${schema.contact.id})::integer`;

export async function getContactBooks(teamId: number, search?: string) {
  const rows = await drizzleDb
    .select({
      id: schema.contactBook.id,
      name: schema.contactBook.name,
      teamId: schema.contactBook.teamId,
      properties: schema.contactBook.properties,
      variables: schema.contactBook.variables,
      emoji: schema.contactBook.emoji,
      createdAt: schema.contactBook.createdAt,
      updatedAt: schema.contactBook.updatedAt,
      doubleOptInEnabled: schema.contactBook.doubleOptInEnabled,
      doubleOptInFrom: schema.contactBook.doubleOptInFrom,
      doubleOptInSubject: schema.contactBook.doubleOptInSubject,
      doubleOptInContent: schema.contactBook.doubleOptInContent,
      contactCount: contactCountSql,
    })
    .from(schema.contactBook)
    .leftJoin(
      schema.contact,
      eq(schema.contact.contactBookId, schema.contactBook.id),
    )
    .where(
      and(
        eq(schema.contactBook.teamId, teamId),
        // Prisma's `contains` with mode "insensitive".
        search ? ilike(schema.contactBook.name, `%${search}%`) : undefined,
      ),
    )
    // Grouping by the primary key is enough; every other selected column is
    // functionally dependent on it.
    .groupBy(schema.contactBook.id);

  // Callers and the tRPC schema expect Prisma's relation-count shape.
  //
  // `properties` is a jsonb column, which Drizzle types as `unknown`. Prisma
  // typed it JsonValue and the UI reads it as a string map, so narrow it here
  // rather than pushing `unknown` out to every caller.
  return rows.map(({ contactCount, properties, ...book }) => ({
    ...book,
    properties: (properties ?? {}) as Record<string, string>,
    _count: { contacts: contactCount },
  }));
}

export async function createContactBook(
  teamId: number,
  name: string,
  variables?: string[],
  client: ContactBookDbClient = drizzleDb,
) {
  const { isLimitReached, reason } =
    await LimitService.checkContactBookLimit(teamId);

  if (isLimitReached) {
    throw new UnsendApiError({
      code: "FORBIDDEN",
      message: reason ?? "Contact book limit reached",
    });
  }

  const normalizedVariables = normalizeContactBookVariables(variables);

  try {
    validateContactBookVariables(normalizedVariables);
  } catch (error) {
    throw new UnsendApiError({
      code: "BAD_REQUEST",
      message: error instanceof Error ? error.message : "Invalid variables",
    });
  }

  const [created] = await client
    .insert(schema.contactBook)
    .values(
      withUpdatedAt({
        // Prisma generated this with @default(cuid()); the column has no
        // database default, so it has to be supplied explicitly now.
        id: createId(),
        name,
        teamId,
        properties: {},
        variables: normalizedVariables,
        doubleOptInEnabled: true,
        doubleOptInSubject: DEFAULT_DOUBLE_OPT_IN_SUBJECT,
        doubleOptInContent: DEFAULT_DOUBLE_OPT_IN_CONTENT,
      }),
    )
    .returning();

  return created!;
}

export async function getContactBookDetails(contactBookId: string) {
  const [totalContacts, unsubscribedContacts, campaigns] = await Promise.all([
    drizzleDb.$count(
      schema.contact,
      eq(schema.contact.contactBookId, contactBookId),
    ),
    drizzleDb.$count(
      schema.contact,
      and(
        eq(schema.contact.contactBookId, contactBookId),
        eq(schema.contact.subscribed, false),
      ),
    ),
    drizzleDb
      .select()
      .from(schema.campaign)
      .where(
        and(
          eq(schema.campaign.contactBookId, contactBookId),
          eq(schema.campaign.status, "SENT"),
        ),
      )
      .orderBy(desc(schema.campaign.createdAt))
      .limit(2),
  ]);

  return {
    totalContacts,
    unsubscribedContacts,
    campaigns,
  };
}

export async function updateContactBook(
  contactBookId: string,
  data: {
    name?: string;
    properties?: Record<string, string>;
    emoji?: string;
    variables?: string[];
    doubleOptInEnabled?: boolean;
    doubleOptInFrom?: string | null;
    doubleOptInSubject?: string;
    doubleOptInContent?: string;
  },
  client: ContactBookDbClient = drizzleDb,
) {
  const restData = { ...data };
  delete restData.variables;

  const normalizedVariables =
    data.variables === undefined
      ? undefined
      : normalizeContactBookVariables(data.variables);

  if (normalizedVariables !== undefined) {
    try {
      validateContactBookVariables(normalizedVariables);
    } catch (error) {
      throw new UnsendApiError({
        code: "BAD_REQUEST",
        message: error instanceof Error ? error.message : "Invalid variables",
      });
    }
  }

  const updateData: {
    name?: string;
    properties?: Record<string, string>;
    emoji?: string;
    variables?: string[];
    doubleOptInEnabled?: boolean;
    doubleOptInFrom?: string | null;
    doubleOptInSubject?: string;
    doubleOptInContent?: string;
  } = {
    ...restData,
    ...(normalizedVariables !== undefined
      ? { variables: normalizedVariables }
      : {}),
  };

  if (data.doubleOptInFrom !== undefined) {
    const normalizedFrom = data.doubleOptInFrom?.trim() ?? "";

    if (!normalizedFrom) {
      updateData.doubleOptInFrom = null;
    } else {
      const [contactBook] = await client
        .select({ teamId: schema.contactBook.teamId })
        .from(schema.contactBook)
        .where(eq(schema.contactBook.id, contactBookId))
        .limit(1);

      if (!contactBook) {
        throw new UnsendApiError({
          code: "BAD_REQUEST",
          message: "Contact book not found",
        });
      }

      await validateDomainFromEmail(normalizedFrom, contactBook.teamId);
      updateData.doubleOptInFrom = normalizedFrom;
    }
  }

  if (
    data.doubleOptInContent !== undefined &&
    !data.doubleOptInContent.trim()
  ) {
    updateData.doubleOptInContent = DEFAULT_DOUBLE_OPT_IN_CONTENT;
  } else if (
    data.doubleOptInContent !== undefined &&
    !hasDoubleOptInUrlPlaceholder(data.doubleOptInContent)
  ) {
    throw new UnsendApiError({
      code: "BAD_REQUEST",
      message:
        "Double opt-in email content must include the {{doubleOptInUrl}} placeholder",
    });
  }

  if (
    data.doubleOptInSubject !== undefined &&
    !data.doubleOptInSubject.trim()
  ) {
    updateData.doubleOptInSubject = DEFAULT_DOUBLE_OPT_IN_SUBJECT;
  }

  if (data.doubleOptInEnabled === true) {
    const [contactBook] = await client
      .select({
        doubleOptInSubject: schema.contactBook.doubleOptInSubject,
        doubleOptInContent: schema.contactBook.doubleOptInContent,
      })
      .from(schema.contactBook)
      .where(eq(schema.contactBook.id, contactBookId))
      .limit(1);

    if (!updateData.doubleOptInSubject && !contactBook?.doubleOptInSubject) {
      updateData.doubleOptInSubject = DEFAULT_DOUBLE_OPT_IN_SUBJECT;
    }

    if (!updateData.doubleOptInContent && !contactBook?.doubleOptInContent) {
      updateData.doubleOptInContent = DEFAULT_DOUBLE_OPT_IN_CONTENT;
    }
  }

  const [updated] = await client
    .update(schema.contactBook)
    .set(withUpdatedAt(updateData))
    .where(eq(schema.contactBook.id, contactBookId))
    .returning();

  if (!updated) {
    // Prisma's update threw when the row was missing; preserve that.
    throw new UnsendApiError({
      code: "NOT_FOUND",
      message: "Contact book not found",
    });
  }

  return updated;
}

export async function deleteContactBook(contactBookId: string) {
  const [deleted] = await drizzleDb
    .delete(schema.contactBook)
    .where(eq(schema.contactBook.id, contactBookId))
    .returning();

  if (!deleted) {
    throw new UnsendApiError({
      code: "NOT_FOUND",
      message: "Contact book not found",
    });
  }

  return deleted;
}
