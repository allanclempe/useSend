import { createRoute, z } from "@hono/zod-openapi";
import { ContactBookSchema } from "~/lib/zod/contact-book-schema";
import { PublicAPIApp } from "~/server/public-api/hono";
import { and, eq, sql } from "drizzle-orm";
import { drizzleDb, schema } from "~/server/drizzle";
import { UnsendApiError } from "../../api-error";

const route = createRoute({
  method: "get",
  path: "/v1/contactBooks/{contactBookId}",
  request: {
    params: z.object({
      contactBookId: z.string().openapi({
        param: {
          name: "contactBookId",
          in: "path",
        },
        example: "clx1234567890",
      }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ContactBookSchema,
        },
      },
      description: "Retrieve the contact book",
    },
    403: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
      description:
        "Forbidden - API key doesn't have access to this contact book",
    },
    404: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.string(),
          }),
        },
      },
      description: "Contact book not found",
    },
  },
});

function getContactBook(app: PublicAPIApp) {
  app.openapi(route, async (c) => {
    const team = c.var.team;
    const contactBookId = c.req.valid("param").contactBookId;

    // LEFT JOIN + GROUP BY stands in for Prisma's `_count`. `COUNT(col)` skips
    // NULLs so an empty book counts 0, and the ::integer cast keeps postgres-js
    // from handing back bigint-as-string.
    const [contactBook] = await drizzleDb
      .select({
        book: schema.contactBook,
        contactCount: sql<number>`COUNT(${schema.contact.id})::integer`,
      })
      .from(schema.contactBook)
      .leftJoin(
        schema.contact,
        eq(schema.contact.contactBookId, schema.contactBook.id),
      )
      .where(
        and(
          eq(schema.contactBook.id, contactBookId),
          eq(schema.contactBook.teamId, team.id),
        ),
      )
      .groupBy(schema.contactBook.id)
      .limit(1);

    if (!contactBook) {
      throw new UnsendApiError({
        code: "NOT_FOUND",
        message: "Contact book not found",
      });
    }

    return c.json({
      ...contactBook.book,
      properties: (contactBook.book.properties ?? {}) as Record<string, string>,
      _count: { contacts: contactBook.contactCount },
    });
  });
}

export default getContactBook;
