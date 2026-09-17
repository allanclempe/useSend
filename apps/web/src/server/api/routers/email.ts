import { Email, EmailStatus, type JsonValue } from "~/types/db";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { format, subDays } from "date-fns";
import { z } from "zod";
import { DEFAULT_QUERY_LIMIT } from "~/lib/constants";
import { BOUNCE_ERROR_MESSAGES } from "@usesend/lib/src";
import type { SesBounce } from "~/types/aws-types";

import {
  createTRPCRouter,
  emailProcedure,
  teamProcedure,
} from "~/server/api/trpc";
import { drizzleDb, schema } from "~/server/drizzle";
import { cancelEmail, updateEmail } from "~/server/service/email-service";

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
    | "Transient"
    | "Permanent"
    | "Undetermined"
    | "";
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

export const emailRouter = createTRPCRouter({
  emails: teamProcedure
    .input(
      z.object({
        page: z.number().optional(),
        status: z.enum(statuses).optional().nullable(),
        domain: z.number().optional(),
        search: z.string().optional().nullable(),
        apiId: z.number().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const page = input.page || 1;
      const limit = DEFAULT_QUERY_LIMIT;
      const offset = (page - 1) * limit;

      // The recipient search has to stay raw — it unnests a text[] column, and
      // there is no query-builder form of that.
      const matchesSearch = input.search
        ? or(
            ilike(schema.email.subject, `%${input.search}%`),
            sql`EXISTS (
              SELECT 1 FROM unnest(${schema.email.to}) AS recipient
              WHERE recipient ILIKE ${`%${input.search}%`}
            )`,
          )
        : undefined;

      const emails = (await drizzleDb
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
            eq(schema.email.teamId, ctx.team.id),
            input.status
              ? eq(schema.email.latestStatus, input.status)
              : undefined,
            input.domain ? eq(schema.email.domainId, input.domain) : undefined,
            input.apiId ? eq(schema.email.apiId, input.apiId) : undefined,
            matchesSearch,
          ),
        )
        .orderBy(desc(schema.email.createdAt))
        .limit(limit)
        .offset(offset)) as unknown as Array<Email>;

      return { emails };
    }),

  exportEmails: teamProcedure
    .input(
      z.object({
        status: z.enum(statuses).optional().nullable(),
        domain: z.number().optional(),
        search: z.string().optional().nullable(),
        apiId: z.number().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Kept raw: the LEFT JOIN LATERAL that pulls each email's most recent
      // BOUNCED event has no query-builder equivalent.
      const emails = (await drizzleDb.execute<
        {
          to: string[];
          latestStatus: EmailStatus;
          subject: string;
          scheduledAt: Date | null;
          createdAt: Date;
          bounceData: JsonValue | null;
        }
      >(sql`
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
        WHERE e."teamId" = ${ctx.team.id}
        ${
          input.status
            ? sql`AND e."latestStatus"::text = ${input.status}`
            : sql``
        }
        ${
          input.domain
            ? sql`AND e."domainId" = ${input.domain}`
            : sql``
        }
        ${
          input.apiId
            ? sql`AND e."apiId" = ${input.apiId}`
            : sql``
        }
        ${
          input.search
            ? sql`AND (
          e."subject" ILIKE ${`%${input.search}%`}
          OR EXISTS (
            SELECT 1 FROM unnest(e."to") AS email
            WHERE email ILIKE ${`%${input.search}%`}
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

      return emails.map((email) => {
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
    }),

  getEmail: emailProcedure.query(async ({ input }) => {
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
      .where(eq(schema.email.id, input.id))
      .limit(1);

    if (!email) {
      return null;
    }

    const emailEventRows = await drizzleDb
      .select()
      .from(schema.emailEvent)
      .where(eq(schema.emailEvent.emailId, input.id))
      .orderBy(desc(schema.emailEvent.status));

    // jsonb reads as `unknown` in Drizzle; the UI expects Prisma's JsonValue.
    const emailEvents = emailEventRows.map((event) => ({
      ...event,
      data: event.data as JsonValue,
    }));

    const result = { ...email, emailEvents };

    return result;
  }),

  cancelEmail: emailProcedure.mutation(async ({ input }) => {
    await cancelEmail(input.id);
  }),

  updateEmailScheduledAt: emailProcedure
    .input(z.object({ scheduledAt: z.string().datetime() }))
    .mutation(async ({ input }) => {
      await updateEmail(input.id, { scheduledAt: input.scheduledAt });
    }),
});
