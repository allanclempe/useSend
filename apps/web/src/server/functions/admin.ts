import { createServerFn } from "@tanstack/react-start";
import {
  and,
  desc,
  eq,
  exists,
  gte,
  ilike,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { UseSend } from "usesend-js";
import { z } from "zod";

import { env } from "~/env";
import { sesRegionSchema } from "~/lib/zod/ses-setting-schema";
import { notFound } from "~/server/app-error";
import { getAccount } from "~/server/aws/ses";
import { drizzleDb, schema } from "~/server/drizzle";
import { withUpdatedAt } from "~/server/drizzle/touch";
import { instanceAdminMiddleware } from "~/server/functions/middleware";
import { logger } from "~/server/logger/log";
import { maskEmail } from "~/server/logger/redact";
import { sendMail } from "~/server/mailer";
import { SesSettingsService } from "~/server/service/ses-settings-service";
import { toPlainHtml } from "~/server/utils/email-content";
import type { Plan } from "~/types/db";
import { isCloud } from "~/utils/common";

/**
 * `server/api/routers/admin.ts`, as server functions (#9).
 *
 * Whoever runs this installation, not whoever runs a team: every function here
 * takes `instanceAdminMiddleware`, and none of them so much as mentions a team
 * id, because at this rung there isn't one. That is the whole security model of
 * the area — an admin screen that reads any of this without the middleware
 * behind it is a data leak rather than a bug in a page.
 *
 * `getSesSettings` was ported ahead of the rest because the dashboard cannot
 * boot without it: `_dashboard.tsx` asks whether SES has ever been configured
 * and shows the set-up form instead of the app when it has not. The remainder —
 * team administration, the waitlist and email analytics — is cloud-only
 * tooling, one screen each.
 */

const waitlistUserSelection = {
  id: schema.user.id,
  email: schema.user.email,
  name: schema.user.name,
  isWaitlisted: schema.user.isWaitlisted,
  createdAt: schema.user.createdAt,
} as const;

function formatDisplayNameFromEmail(email: string) {
  const localPart = email.split("@")[0] ?? email;
  const pieces = localPart.split(/[._-]+/).filter(Boolean);
  if (pieces.length === 0) {
    return localPart;
  }
  return pieces
    .map((piece) => piece.charAt(0).toUpperCase() + piece.slice(1))
    .join(" ");
}

/**
 * Loads a team with the nested shape the admin UI expects.
 *
 * Uses Drizzle's relational query API rather than joins: teamUsers and domains
 * are both one-to-many, so a single joined query would multiply rows and need
 * reassembling by hand.
 */
async function findTeamForAdmin(where: SQL | undefined) {
  const team = await drizzleDb.query.team.findFirst({
    where,
    columns: {
      id: true,
      name: true,
      plan: true,
      apiRateLimit: true,
      dailyEmailLimit: true,
      isBlocked: true,
      billingEmail: true,
      createdAt: true,
    },
    with: {
      teamUsers: {
        columns: { role: true },
        with: {
          user: { columns: { id: true, email: true, name: true } },
        },
      },
      domains: {
        columns: { id: true, name: true, status: true, isVerifying: true },
      },
    },
  });

  return team ?? null;
}

export const getSesSettings = createServerFn({ method: "GET" })
  .middleware([instanceAdminMiddleware])
  .handler(() => SesSettingsService.getAllSettings());

export const getDefaultSesRegion = createServerFn({ method: "GET" })
  .middleware([instanceAdminMiddleware])
  .handler(() => env.AWS_DEFAULT_REGION);

/**
 * `MaxSendRate` is `number | undefined` at SES and the set-up form uses the
 * answer as an input default. `undefined` is not serialisable through Start,
 * so the absence is `null` here and the form supplies its own fallback.
 */
export const getQuotaForRegion = createServerFn({ method: "GET" })
  .middleware([instanceAdminMiddleware])
  .validator(z.object({ region: sesRegionSchema }))
  .handler(async ({ data }) => {
    const account = await getAccount(data.region);
    return account.SendQuota?.MaxSendRate ?? null;
  });

export const getSetting = createServerFn({ method: "GET" })
  .middleware([instanceAdminMiddleware])
  .validator(z.object({ region: z.string().optional().nullable() }))
  .handler(({ data }) =>
    SesSettingsService.getSetting(data.region ?? env.AWS_DEFAULT_REGION),
  );

export const addSesSettings = createServerFn({ method: "POST" })
  .middleware([instanceAdminMiddleware])
  .validator(
    z.object({
      region: sesRegionSchema,
      usesendUrl: z.string().url(),
      sendRate: z.number(),
      transactionalQuota: z.number(),
    }),
  )
  .handler(({ data }) =>
    SesSettingsService.createSesSetting({
      region: data.region,
      usesendUrl: data.usesendUrl,
      sendingRateLimit: data.sendRate,
      transactionalQuota: data.transactionalQuota,
    }),
  );

export const updateSesSettings = createServerFn({ method: "POST" })
  .middleware([instanceAdminMiddleware])
  .validator(
    z.object({
      settingsId: z.string(),
      sendRate: z.number(),
      transactionalQuota: z.number(),
    }),
  )
  .handler(({ data }) =>
    SesSettingsService.updateSesSetting({
      id: data.settingsId,
      sendingRateLimit: data.sendRate,
      transactionalQuota: data.transactionalQuota,
    }),
  );

/**
 * `findUserByEmail` and `findTeam` only read, and are still `POST`.
 *
 * Not habit carried over from tRPC's `.mutation()`: a `GET` server function
 * encodes its input in the URL, and the input to both of these is somebody's
 * email address — the team lookup matches on member email too. Keeping it in
 * the body keeps it out of the browser's history and out of every access log
 * between the page and the Worker, which is the same reason `maskEmail` exists
 * on the logging side.
 */
export const findUserByEmail = createServerFn({ method: "POST" })
  .middleware([instanceAdminMiddleware])
  .validator(
    z.object({
      email: z
        .string()
        .email()
        .transform((value) => value.toLowerCase()),
    }),
  )
  .handler(async ({ data }) => {
    const [user] = await drizzleDb
      .select(waitlistUserSelection)
      .from(schema.user)
      .where(eq(schema.user.email, data.email))
      .limit(1);

    return user ?? null;
  });

export const updateUserWaitlist = createServerFn({ method: "POST" })
  .middleware([instanceAdminMiddleware])
  .validator(z.object({ userId: z.number(), isWaitlisted: z.boolean() }))
  .handler(async ({ data }) => {
    const [existingUser] = await drizzleDb
      .select(waitlistUserSelection)
      .from(schema.user)
      .where(eq(schema.user.id, data.userId))
      .limit(1);

    if (!existingUser) {
      throw notFound("User not found");
    }

    const [updatedUser] = await drizzleDb
      .update(schema.user)
      .set(withUpdatedAt({ isWaitlisted: data.isWaitlisted }))
      .where(eq(schema.user.id, data.userId))
      .returning(waitlistUserSelection);

    if (!updatedUser) {
      throw notFound("User not found");
    }

    const founderEmail = env.FOUNDER_EMAIL ?? undefined;
    const fallbackFrom = env.FROM_EMAIL ?? env.ADMIN_EMAIL ?? undefined;

    // Both the welcome mail and the contact-book write hang off the same
    // one-way transition, so it is named once rather than spelled out twice.
    const letThrough = existingUser.isWaitlisted && !data.isWaitlisted;

    const shouldSendAcceptanceEmail =
      letThrough && Boolean(updatedUser.email) && (founderEmail || fallbackFrom);

    // Add user to contact book when removed from waitlist (cloud only)
    if (letThrough && isCloud() && env.CONTACT_BOOK_ID && updatedUser.email) {
      try {
        const client = new UseSend(env.USESEND_API_KEY);

        // Split name into first and last name if available
        const firstName = updatedUser.name || "";

        const result = await client.contacts.create(env.CONTACT_BOOK_ID, {
          email: updatedUser.email,
          firstName: firstName,
        });

        if (result.error) {
          logger.error(
            {
              userId: updatedUser.id,
              email: maskEmail(updatedUser.email),
              error: result.error,
            },
            "Failed to add user to contact book",
          );
        } else {
          logger.info(
            {
              userId: updatedUser.id,
              email: maskEmail(updatedUser.email),
              contactId: result.data?.contactId,
            },
            "Successfully added user to contact book",
          );
        }
      } catch (error) {
        logger.error(
          {
            userId: updatedUser.id,
            email: maskEmail(updatedUser.email),
            error,
          },
          "Error adding user to contact book",
        );
      }
    }

    if (shouldSendAcceptanceEmail) {
      const recipient = updatedUser.email as string;
      const replyTo = founderEmail ?? fallbackFrom;
      const fromOverride = founderEmail ?? undefined;
      const founderName = replyTo
        ? formatDisplayNameFromEmail(replyTo)
        : "Founder";
      const userFirstName =
        updatedUser.name?.split(" ")[0] ?? updatedUser.name ?? recipient;

      const text = `Hey ${userFirstName},\n\nThanks for hanging in while we reviewed your waitlist request. I've just moved your account off the waitlist, so you now have full access to useSend.\n\nGo ahead and log back in to start sending: ${env.APP_URL}\n\nIf anything feels unclear or you want help getting set up, reply to this email and it comes straight to me.\n\nCheers,\n${founderName}\n${replyTo}`;

      try {
        await sendMail(
          recipient,
          "useSend: You're off the waitlist",
          text,
          toPlainHtml(text),
          replyTo,
          fromOverride,
        );
      } catch (error) {
        logger.error(
          { userId: updatedUser.id, error },
          "Failed to send waitlist acceptance email",
        );
      }
    }

    return updatedUser;
  });

export const rejectWaitlistUser = createServerFn({ method: "POST" })
  .middleware([instanceAdminMiddleware])
  .validator(z.object({ userId: z.number() }))
  .handler(async ({ data }) => {
    const [user] = await drizzleDb
      .select(waitlistUserSelection)
      .from(schema.user)
      .where(eq(schema.user.id, data.userId))
      .limit(1);

    if (!user) {
      throw notFound("User not found");
    }

    if (!user.email) {
      throw notFound("User email is missing");
    }

    const founderEmail = env.FOUNDER_EMAIL ?? undefined;
    const fallbackFrom = env.FROM_EMAIL ?? env.ADMIN_EMAIL ?? undefined;

    const replyTo = founderEmail ?? fallbackFrom;

    if (!replyTo) {
      throw new Error("No sender email configured");
    }

    const fromOverride = founderEmail ?? undefined;

    const text = [
      "Hello,",
      "",
      "Sorry, We cannot proceed with this request at this time, this might affect useSend’s sending reputation.",
      "",
      "",
      "cheers,",
      "koushik - useSend.com",
    ].join("\n");

    try {
      await sendMail(
        user.email,
        "useSend: Waitlist request update",
        text,
        toPlainHtml(text),
        replyTo,
        fromOverride,
      );
    } catch (error) {
      logger.error(
        { userId: user.id, error },
        "Failed to send waitlist rejection email",
      );
      throw new Error("Failed to send waitlist rejection email");
    }

    return { sent: true };
  });

export const findTeam = createServerFn({ method: "POST" })
  .middleware([instanceAdminMiddleware])
  .validator(
    z.object({
      query: z
        .string({
          required_error:
            "Enter a team ID, name, domain, member email, or subscription ID",
        })
        .trim()
        .min(
          1,
          "Enter a team ID, name, domain, member email, or subscription ID",
        ),
    }),
  )
  .handler(async ({ data }) => {
    const query = data.query.trim();

    let numericId: number | null = null;
    if (/^\d+$/.test(query)) {
      numericId = Number(query);
    }

    let team = numericId
      ? ((await findTeamForAdmin(eq(schema.team.id, numericId))) ?? null)
      : null;

    if (!team) {
      // Prisma's relation filters become EXISTS subqueries rather than joins,
      // so a team with several matching domains still yields one row.
      team =
        (await findTeamForAdmin(
          or(
            ilike(schema.team.name, query),
            ilike(schema.team.billingEmail, query),
            exists(
              drizzleDb
                .select({ one: sql`1` })
                .from(schema.teamUser)
                .innerJoin(
                  schema.user,
                  eq(schema.user.id, schema.teamUser.userId),
                )
                .where(
                  and(
                    eq(schema.teamUser.teamId, schema.team.id),
                    ilike(schema.user.email, query),
                  ),
                ),
            ),
            exists(
              drizzleDb
                .select({ one: sql`1` })
                .from(schema.domain)
                .where(
                  and(
                    eq(schema.domain.teamId, schema.team.id),
                    ilike(schema.domain.name, query),
                  ),
                ),
            ),
            exists(
              drizzleDb
                .select({ one: sql`1` })
                .from(schema.subscription)
                .where(
                  and(
                    eq(schema.subscription.teamId, schema.team.id),
                    ilike(schema.subscription.id, query),
                  ),
                ),
            ),
          ),
        )) ?? null;
    }

    return team ?? null;
  });

export const updateTeamSettings = createServerFn({ method: "POST" })
  .middleware([instanceAdminMiddleware])
  .validator(
    z.object({
      teamId: z.number(),
      apiRateLimit: z.number().int().min(1).max(10_000),
      dailyEmailLimit: z.number().int().min(0).max(10_000_000),
      isBlocked: z.boolean(),
      plan: z.enum(["FREE", "BASIC"]),
    }),
  )
  .handler(async ({ data }) => {
    const { teamId, ...values } = data;

    const [updatedTeam] = await drizzleDb
      .update(schema.team)
      .set(withUpdatedAt(values))
      .where(eq(schema.team.id, teamId))
      .returning({ id: schema.team.id });

    if (!updatedTeam) {
      throw notFound("Team not found");
    }

    const team = await findTeamForAdmin(eq(schema.team.id, teamId));

    if (!team) {
      throw notFound("Team not found");
    }

    return team;
  });

export const getEmailAnalytics = createServerFn({ method: "GET" })
  .middleware([instanceAdminMiddleware])
  .validator(
    z.object({
      timeframe: z.enum(["today", "thisMonth"]),
      paidOnly: z.boolean().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const timeframe = data.timeframe;
    const paidOnly = data.paidOnly ?? false;

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const monthStartDate = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const monthStart = monthStartDate.toISOString().slice(0, 10);

    type EmailAnalyticsRow = {
      teamId: number;
      name: string;
      plan: Plan;
      sent: number;
      delivered: number;
      opened: number;
      clicked: number;
      bounced: number;
      complained: number;
      hardBounced: number;
    };

    // A grouped join with per-column sums, expressible in the query builder.
    // The ::integer casts stay: SUM over an integer column returns bigint,
    // which postgres-js hands back as a string.
    const sum = (column: AnyPgColumn) => sql<number>`SUM(${column})::integer`;

    const rows: EmailAnalyticsRow[] = await drizzleDb
      .select({
        teamId: schema.dailyEmailUsage.teamId,
        name: schema.team.name,
        plan: schema.team.plan,
        sent: sum(schema.dailyEmailUsage.sent),
        delivered: sum(schema.dailyEmailUsage.delivered),
        opened: sum(schema.dailyEmailUsage.opened),
        clicked: sum(schema.dailyEmailUsage.clicked),
        bounced: sum(schema.dailyEmailUsage.bounced),
        complained: sum(schema.dailyEmailUsage.complained),
        hardBounced: sum(schema.dailyEmailUsage.hardBounced),
      })
      .from(schema.dailyEmailUsage)
      .innerJoin(schema.team, eq(schema.team.id, schema.dailyEmailUsage.teamId))
      .where(
        and(
          timeframe === "today"
            ? eq(schema.dailyEmailUsage.date, today)
            : gte(schema.dailyEmailUsage.date, monthStart),
          paidOnly ? eq(schema.team.plan, "BASIC") : undefined,
        ),
      )
      .groupBy(schema.dailyEmailUsage.teamId, schema.team.name, schema.team.plan)
      .orderBy(desc(sum(schema.dailyEmailUsage.sent)));

    const totals = rows.reduce(
      (acc, row) => {
        acc.sent += row.sent;
        acc.delivered += row.delivered;
        acc.opened += row.opened;
        acc.clicked += row.clicked;
        acc.bounced += row.bounced;
        acc.complained += row.complained;
        acc.hardBounced += row.hardBounced;
        return acc;
      },
      {
        sent: 0,
        delivered: 0,
        opened: 0,
        clicked: 0,
        bounced: 0,
        complained: 0,
        hardBounced: 0,
      },
    );

    return {
      rows,
      totals,
      timeframe,
      paidOnly,
      periodStart: timeframe === "today" ? today : monthStart,
    };
  });
