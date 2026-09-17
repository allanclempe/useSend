import { createServerFn } from "@tanstack/react-start";
import { BOUNCE_ERROR_MESSAGES } from "@usesend/lib/src";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";

import { DEFAULT_QUERY_LIMIT } from "~/lib/constants";
import { drizzleDb, schema } from "~/server/drizzle";
import { emailMiddleware, teamMiddleware } from "~/server/functions/middleware";
import {
  cancelEmail as cancelEmailById,
  updateEmail,
} from "~/server/service/email-service";
import type { SesBounce } from "~/types/aws-types";
import { Email, EmailStatus, type JsonValue } from "~/types/db";

/**
 * The email log, from `server/api/routers/email.ts` (#9).
 *
 * Two of these queries are hand-written SQL and stay that way. The recipient
 * search has to unnest a `text[]` column, and the export needs a
 * `LEFT JOIN LATERAL` to pick each email's most recent `BOUNCED` event;
 * neither has a query-builder form.
 *
 * The bounce helpers below turn an SES payload into something a human can read
 * in a spreadsheet. They are deliberately total — an SES event we do not
 * recognise falls back to the `General` message for its type rather than
 * leaving the column blank.
 */

const statuses = Object.values(EmailStatus) as [EmailStatus];

const ensureBounceObject = (
  data: JsonValue,
): Partial<SesBounce> | undefined => {
  const raw =
    typeof data === "string"
      ? (() => {
          try {
            return JSON.parse(data);
          } catch {
            return undefined;
          }
        })()
      : data;
  if (!raw || typeof raw !== "object") return undefined;
  return raw as Partial<SesBounce>;
};

const getBounceReasonFromParsed = (
  bounce: Partial<SesBounce>,
): string | undefined => {
  const diagnostic = bounce.bouncedRecipients?.[0]?.diagnosticCode?.trim();
  if (diagnostic) return diagnostic;

  const type = (bounce.bounceType ?? "").toString().trim() as
    "Transient" | "Permanent" | "Undetermined" | "";
  const subtype = (bounce.bounceSubType ?? "")
    .toString()
    .trim()
    .replace(/\s+/g, "");

  if (type === "Permanent") {
    const key = (
      ["General", "NoEmail", "Suppressed", "OnAccountSuppressionList"].includes(
        subtype,
      )
        ? subtype
        : "General"
    ) as keyof typeof BOUNCE_ERROR_MESSAGES.Permanent;
    return BOUNCE_ERROR_MESSAGES.Permanent[key];
  }
  if (type === "Transient") {
    const key = (
      [
        "General",
        "MailboxFull",
        "MessageTooLarge",
        "ContentRejected",
        "AttachmentRejected",
      ].includes(subtype)
        ? subtype
        : "General"
    ) as keyof typeof BOUNCE_ERROR_MESSAGES.Transient;
    return BOUNCE_ERROR_MESSAGES.Transient[key];
  }
  if (type === "Undetermined") {
    return BOUNCE_ERROR_MESSAGES.Undetermined;
  }
  return undefined;
};

export const emails = createServerFn({ method: "GET" })
  .middleware([teamMiddleware])
  .validator(
    z.object({
      page: z.number().optional(),
      status: z.enum(statuses).optional().nullable(),
      domain: z.number().optional(),
      search: z.string().optional().nullable(),
      apiId: z.number().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const page = data.page || 1;
    const limit = DEFAULT_QUERY_LIMIT;
    const offset = (page - 1) * limit;

    // The recipient search has to stay raw — it unnests a text[] column, and
    // there is no query-builder form of that.
    const matchesSearch = data.search
      ? or(
          ilike(schema.email.subject, `%${data.search}%`),
          sql`EXISTS (
              SELECT 1 FROM unnest(${schema.email.to}) AS recipient
              WHERE recipient ILIKE ${`%${data.search}%`}
            )`,
        )
      : undefined;

    const rows = (await drizzleDb
      .select({
        id: schema.email.id,
        createdAt: schema.email.createdAt,
        latestStatus: schema.email.latestStatus,
        subject: schema.email.subject,
        to: schema.email.to,
        scheduledAt: schema.email.scheduledAt,
      })
      .from(schema.email)
      .where(
        and(
          eq(schema.email.teamId, context.team.id),
          data.status ? eq(schema.email.latestStatus, data.status) : undefined,
          data.domain ? eq(schema.email.domainId, data.domain) : undefined,
          data.apiId ? eq(schema.email.apiId, data.apiId) : undefined,
          matchesSearch,
        ),
      )
      .orderBy(desc(schema.email.createdAt))
      .limit(limit)
      .offset(offset)) as unknown as Array<Email>;

    return { emails: rows };
  });

export const exportEmails = createServerFn({ method: "GET" })
  .middleware([teamMiddleware])
  .validator(
    z.object({
      status: z.enum(statuses).optional().nullable(),
      domain: z.number().optional(),
      search: z.string().optional().nullable(),
      apiId: z.number().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    // Kept raw: the LEFT JOIN LATERAL that pulls each email's most recent
    // BOUNCED event has no query-builder equivalent.
    const rows = (await drizzleDb.execute<{
      to: string[];
      latestStatus: EmailStatus;
      subject: string;
      scheduledAt: Date | null;
      createdAt: Date;
      bounceData: JsonValue | null;
    }>(sql`
        SELECT
          e."to",
          e."latestStatus",
          e.subject,
          e."scheduledAt",
          e."createdAt",
          b.data as "bounceData"
        FROM "Email" e
        LEFT JOIN LATERAL (
          SELECT data
          FROM "EmailEvent"
          WHERE "emailId" = e.id AND "status" = 'BOUNCED'
          ORDER BY "createdAt" DESC
          LIMIT 1
        ) b ON true
        WHERE e."teamId" = ${context.team.id}
        ${
          data.status ? sql`AND e."latestStatus"::text = ${data.status}` : sql``
        }
        ${data.domain ? sql`AND e."domainId" = ${data.domain}` : sql``}
        ${data.apiId ? sql`AND e."apiId" = ${data.apiId}` : sql``}
        ${
          data.search
            ? sql`AND (
          e."subject" ILIKE ${`%${data.search}%`}
          OR EXISTS (
            SELECT 1 FROM unnest(e."to") AS email
            WHERE email ILIKE ${`%${data.search}%`}
          )
        )`
            : sql``
        }
        ORDER BY e."createdAt" DESC
        LIMIT 10000
      `)) as unknown as Array<{
      to: string[];
      latestStatus: EmailStatus;
      subject: string;
      scheduledAt: Date | null;
      createdAt: Date;
      bounceData: JsonValue | null;
    }>;

    return rows.map((email) => {
      const base = {
        to: email.to.join("; "),
        status: email.latestStatus,
        subject: email.subject,
        sentAt: (email.scheduledAt ?? email.createdAt).toISOString(),
      } as const;

      if (email.latestStatus !== "BOUNCED" || !email.bounceData) {
        return {
          ...base,
          bounceType: undefined,
          bounceSubType: undefined,
          bounceReason: undefined,
        };
      }

      const bounce = ensureBounceObject(email.bounceData);
      const bounceType = bounce?.bounceType?.toString().trim() || undefined;
      const bounceSubType = bounce?.bounceSubType
        ? bounce.bounceSubType.toString().trim().replace(/\s+/g, "")
        : undefined;
      const bounceReason = bounce
        ? getBounceReasonFromParsed(bounce)
        : undefined;

      return { ...base, bounceType, bounceSubType, bounceReason };
    });
  });

export const getEmail = createServerFn({ method: "GET" })
  .middleware([emailMiddleware])
  .handler(async ({ context }) => {
    const [email] = await drizzleDb
      .select({
        id: schema.email.id,
        createdAt: schema.email.createdAt,
        latestStatus: schema.email.latestStatus,
        subject: schema.email.subject,
        to: schema.email.to,
        from: schema.email.from,
        domainId: schema.email.domainId,
        text: schema.email.text,
        html: schema.email.html,
        scheduledAt: schema.email.scheduledAt,
      })
      .from(schema.email)
      .where(eq(schema.email.id, context.email.id))
      .limit(1);

    if (!email) {
      return null;
    }

    const emailEventRows = await drizzleDb
      .select()
      .from(schema.emailEvent)
      .where(eq(schema.emailEvent.emailId, context.email.id))
      .orderBy(desc(schema.emailEvent.status));

    // jsonb reads as `unknown` in Drizzle; the UI expects Prisma's JsonValue.
    const emailEvents = emailEventRows.map((event) => ({
      ...event,
      data: event.data as JsonValue,
    }));

    return { ...email, emailEvents };
  });

export const cancelEmail = createServerFn({ method: "POST" })
  .middleware([emailMiddleware])
  .handler(async ({ context }) => {
    await cancelEmailById(context.email.id);
  });

export const updateEmailScheduledAt = createServerFn({ method: "POST" })
  .middleware([emailMiddleware])
  .validator(z.object({ scheduledAt: z.string().datetime() }))
  .handler(async ({ data, context }) => {
    await updateEmail(context.email.id, { scheduledAt: data.scheduledAt });
  });
