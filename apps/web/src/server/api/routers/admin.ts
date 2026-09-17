import { type Plan } from "~/types/db";
import { and, desc, eq, exists, gte, ilike, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { env } from "~/env";

import { createTRPCRouter, adminProcedure } from "~/server/api/trpc";
import { SesSettingsService } from "~/server/service/ses-settings-service";
import { getAccount } from "~/server/aws/ses";
import { drizzleDb, schema } from "~/server/drizzle";
import { withUpdatedAt } from "~/server/drizzle/touch";
import { sendMail } from "~/server/mailer";
import { logger } from "~/server/logger/log";
import { UseSend } from "usesend-js";
import { isCloud } from "~/utils/common";
import { toPlainHtml } from "~/server/utils/email-content";
import { sesRegionSchema } from "~/lib/zod/ses-setting-schema";

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

export const adminRouter = createTRPCRouter({
  getSesSettings: adminProcedure.query(async () => {
    return SesSettingsService.getAllSettings();
  }),

  getDefaultSesRegion: adminProcedure.query(() => env.AWS_DEFAULT_REGION),

  getQuotaForRegion: adminProcedure
    .input(
      z.object({
        region: sesRegionSchema,
      }),
    )
    .query(async ({ input }) => {
      const acc = await getAccount(input.region);
      return acc.SendQuota?.MaxSendRate;
    }),

  addSesSettings: adminProcedure
    .input(
      z.object({
        region: sesRegionSchema,
        usesendUrl: z.string().url(),
        sendRate: z.number(),
        transactionalQuota: z.number(),
      }),
    )
    .mutation(async ({ input }) => {
      return SesSettingsService.createSesSetting({
        region: input.region,
        usesendUrl: input.usesendUrl,
        sendingRateLimit: input.sendRate,
        transactionalQuota: input.transactionalQuota,
      });
    }),

  updateSesSettings: adminProcedure
    .input(
      z.object({
        settingsId: z.string(),
        sendRate: z.number(),
        transactionalQuota: z.number(),
      }),
    )
    .mutation(async ({ input }) => {
      return SesSettingsService.updateSesSetting({
        id: input.settingsId,
        sendingRateLimit: input.sendRate,
        transactionalQuota: input.transactionalQuota,
      });
    }),

  getSetting: adminProcedure
    .input(
      z.object({
        region: z.string().optional().nullable(),
      }),
    )
    .query(async ({ input }) => {
      return SesSettingsService.getSetting(
        input.region ?? env.AWS_DEFAULT_REGION,
      );
    }),

  findUserByEmail: adminProcedure
    .input(
      z.object({
        email: z
          .string()
          .email()
          .transform((value) => value.toLowerCase()),
      }),
    )
    .mutation(async ({ input }) => {
      const [user] = await drizzleDb
        .select(waitlistUserSelection)
        .from(schema.user)
        .where(eq(schema.user.email, input.email))
        .limit(1);

      return user ?? null;
    }),

  updateUserWaitlist: adminProcedure
    .input(
      z.object({
        userId: z.number(),
        isWaitlisted: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      const [existingUser] = await drizzleDb
        .select(waitlistUserSelection)
        .from(schema.user)
        .where(eq(schema.user.id, input.userId))
        .limit(1);

      if (!existingUser) {
        throw new Error("User not found");
      }

      const [updatedUser] = await drizzleDb
        .update(schema.user)
        .set(withUpdatedAt({ isWaitlisted: input.isWaitlisted }))
        .where(eq(schema.user.id, input.userId))
        .returning(waitlistUserSelection);

      if (!updatedUser) {
        throw new Error("User not found");
      }

      const founderEmail = env.FOUNDER_EMAIL ?? undefined;
      const fallbackFrom = env.FROM_EMAIL ?? env.ADMIN_EMAIL ?? undefined;

      const shouldSendAcceptanceEmail =
        existingUser.isWaitlisted &&
        !input.isWaitlisted &&
        Boolean(updatedUser.email) &&
        (founderEmail || fallbackFrom);

      // Add user to contact book when removed from waitlist (cloud only)
      if (
        existingUser.isWaitlisted &&
        !input.isWaitlisted &&
        isCloud() &&
        env.CONTACT_BOOK_ID &&
        updatedUser.email
      ) {
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
                email: updatedUser.email,
                error: result.error,
              },
              "Failed to add user to contact book",
            );
          } else {
            logger.info(
              {
                userId: updatedUser.id,
                email: updatedUser.email,
                contactId: result.data?.contactId,
              },
              "Successfully added user to contact book",
            );
          }
        } catch (error) {
          logger.error(
            {
              userId: updatedUser.id,
              email: updatedUser.email,
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

        const text = `Hey ${userFirstName},\n\nThanks for hanging in while we reviewed your waitlist request. I've just moved your account off the waitlist, so you now have full access to useSend.\n\nGo ahead and log back in to start sending: ${env.NEXTAUTH_URL}\n\nIf anything feels unclear or you want help getting set up, reply to this email and it comes straight to me.\n\nCheers,\n${founderName}\n${replyTo}`;

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
    }),

  rejectWaitlistUser: adminProcedure
    .input(
      z.object({
        userId: z.number(),
      }),
    )
    .mutation(async ({ input }) => {
      const [user] = await drizzleDb
        .select(waitlistUserSelection)
        .from(schema.user)
        .where(eq(schema.user.id, input.userId))
        .limit(1);

      if (!user) {
        throw new Error("User not found");
      }

      if (!user.email) {
        throw new Error("User email is missing");
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
        "Sorry, We cannot proceed with this request at this time, this might affect useSend\u2019s sending reputation.",
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
    }),

  findTeam: adminProcedure
    .input(
      z.object({
        query: z
          .string({ required_error: "Search query is required" })
          .trim()
          .min(1, "Search query is required"),
      }),
    )
    .mutation(async ({ input }) => {
      const query = input.query.trim();

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
    }),

  updateTeamSettings: adminProcedure
    .input(
      z.object({
        teamId: z.number(),
        apiRateLimit: z.number().int().min(1).max(10_000),
        dailyEmailLimit: z.number().int().min(0).max(10_000_000),
        isBlocked: z.boolean(),
        plan: z.enum(["FREE", "BASIC"]),
      }),
    )
    .mutation(async ({ input }) => {
      const { teamId, ...data } = input;

      const [updatedTeam] = await drizzleDb
        .update(schema.team)
        .set(withUpdatedAt(data))
        .where(eq(schema.team.id, teamId))
        .returning({ id: schema.team.id });

      if (!updatedTeam) {
        throw new Error("Team not found");
      }

      const team = await findTeamForAdmin(eq(schema.team.id, teamId));

      if (!team) {
        throw new Error("Team not found");
      }

      return team;
    }),

  getEmailAnalytics: adminProcedure
    .input(
      z.object({
        timeframe: z.enum(["today", "thisMonth"]),
        paidOnly: z.boolean().optional(),
      }),
    )
    .query(async ({ input }) => {
      const timeframe = input.timeframe;
      const paidOnly = input.paidOnly ?? false;

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
        .innerJoin(
          schema.team,
          eq(schema.team.id, schema.dailyEmailUsage.teamId),
        )
        .where(
          and(
            timeframe === "today"
              ? eq(schema.dailyEmailUsage.date, today)
              : gte(schema.dailyEmailUsage.date, monthStart),
            paidOnly ? eq(schema.team.plan, "BASIC") : undefined,
          ),
        )
        .groupBy(
          schema.dailyEmailUsage.teamId,
          schema.team.name,
          schema.team.plan,
        )
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
    }),
});
