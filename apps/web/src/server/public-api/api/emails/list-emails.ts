import { createRoute, z } from "@hono/zod-openapi";
import { PublicAPIApp } from "~/server/public-api/hono";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { drizzleDb, schema } from "~/server/drizzle";
import { EmailStatus } from "@prisma/client";
import { DEFAULT_QUERY_LIMIT } from "~/lib/constants";

const EmailSchema = z.object({
  id: z.string(),
  to: z.string().or(z.array(z.string())),
  replyTo: z.string().or(z.array(z.string())).optional().nullable(),
  cc: z.string().or(z.array(z.string())).optional().nullable(),
  bcc: z.string().or(z.array(z.string())).optional().nullable(),
  from: z.string(),
  subject: z.string(),
  html: z.string().nullable(),
  text: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  latestStatus: z.nativeEnum(EmailStatus).nullable(),
  scheduledAt: z.string().datetime().nullable(),
  domainId: z.number().nullable(),
});

const route = createRoute({
  method: "get",
  path: "/v1/emails",
  request: {
    query: z.object({
      page: z
        .string()
        .optional()
        .default("1")
        .transform(Number)
        .openapi({
          param: {
            name: "page",
            in: "query",
          },
          example: "1",
        }),
      limit: z
        .string()
        .optional()
        .default(String(DEFAULT_QUERY_LIMIT))
        .pipe(z.coerce.number().min(1).max(DEFAULT_QUERY_LIMIT))
        .openapi({
          param: {
            name: "limit",
            in: "query",
          },
          example: String(DEFAULT_QUERY_LIMIT),
        }),
      startDate: z
        .string()
        .datetime()
        .optional()
        .openapi({
          param: {
            name: "startDate",
            in: "query",
          },
          example: "2024-01-01T00:00:00Z",
        }),
      endDate: z
        .string()
        .datetime()
        .optional()
        .openapi({
          param: {
            name: "endDate",
            in: "query",
          },
          example: "2024-01-31T23:59:59Z",
        }),
      domainId: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .transform((val) => {
          if (!val) return undefined;
          return (Array.isArray(val) ? val : [val]).map(Number);
        })
        .openapi({
          param: {
            name: "domainId",
            in: "query",
          },
          example: "123", // or ["123", "456"]
        }),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(EmailSchema),
            count: z.number(),
          }),
        },
      },
      description: "Retrieve a list of emails",
    },
  },
});

function listEmails(app: PublicAPIApp) {
  app.openapi(route, async (c) => {
    const team = c.var.team;
    const { page, limit, startDate, endDate, domainId } = c.req.valid("query");

    // NOTE: the Prisma version assigned whereClause.createdAt twice, so passing
    // startDate *and* endDate silently dropped startDate. Both now apply.
    const where = and(
      eq(schema.email.teamId, team.id),
      startDate ? gte(schema.email.createdAt, new Date(startDate)) : undefined,
      endDate ? lte(schema.email.createdAt, new Date(endDate)) : undefined,
      team.apiKey.domainId !== null
        ? eq(schema.email.domainId, team.apiKey.domainId)
        : domainId && domainId.length > 0
          ? inArray(schema.email.domainId, domainId)
          : undefined,
    );

    // One transaction so the page and the total agree with each other.
    const [emails, count] = await drizzleDb.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: schema.email.id,
          to: schema.email.to,
          replyTo: schema.email.replyTo,
          cc: schema.email.cc,
          bcc: schema.email.bcc,
          from: schema.email.from,
          subject: schema.email.subject,
          html: schema.email.html,
          text: schema.email.text,
          createdAt: schema.email.createdAt,
          updatedAt: schema.email.updatedAt,
          latestStatus: schema.email.latestStatus,
          scheduledAt: schema.email.scheduledAt,
          domainId: schema.email.domainId,
        })
        .from(schema.email)
        .where(where)
        .orderBy(desc(schema.email.createdAt))
        .offset((page - 1) * limit)
        .limit(limit);

      const total = await tx.$count(schema.email, where);

      return [rows, total] as const;
    });

    return c.json({
      data: emails.map((email) => ({
        ...email,
        createdAt: email.createdAt.toISOString(),
        updatedAt: email.updatedAt.toISOString(),
        scheduledAt: email.scheduledAt ? email.scheduledAt.toISOString() : null,
      })),
      count,
    });
  });
}

export default listEmails;
