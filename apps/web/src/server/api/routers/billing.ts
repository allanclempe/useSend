import { DailyEmailUsage, EmailUsageType, Subscription } from "~/types/db";
import { TRPCError } from "@trpc/server";
import { format, sub } from "date-fns";
import { z } from "zod";
import { getThisMonthUsage } from "~/server/service/usage-service";

import {
  apiKeyProcedure,
  createTRPCRouter,
  teamAdminProcedure,
  teamProcedure,
} from "~/server/api/trpc";
import {
  createCheckoutSessionForTeam,
  getManageSessionUrl,
} from "~/server/billing/payments";
import { asc, eq } from "drizzle-orm";
import { drizzleDb, schema } from "~/server/drizzle";
import { TeamService } from "~/server/service/team-service";

export const billingRouter = createTRPCRouter({
  createCheckoutSession: teamAdminProcedure.mutation(async ({ ctx }) => {
    return (await createCheckoutSessionForTeam(ctx.team.id)).url;
  }),

  getManageSessionUrl: teamAdminProcedure.mutation(async ({ ctx }) => {
    return await getManageSessionUrl(ctx.team.id);
  }),

  getThisMonthUsage: teamProcedure.query(async ({ ctx }) => {
    return await getThisMonthUsage(ctx.team.id);
  }),

  getSubscriptionDetails: teamProcedure.query(async ({ ctx }) => {
    const [subscription] = await drizzleDb
      .select()
      .from(schema.subscription)
      .where(eq(schema.subscription.teamId, ctx.team.id))
      .orderBy(asc(schema.subscription.status))
      .limit(1);

    return subscription ?? null;
  }),

  updateBillingEmail: teamAdminProcedure
    .input(
      z.object({
        billingEmail: z.string().email(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { billingEmail } = input;

      await TeamService.updateTeam(ctx.team.id, { billingEmail });
    }),
});
