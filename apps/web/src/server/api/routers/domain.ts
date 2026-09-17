import { z } from "zod";

import {
  createTRPCRouter,
  teamProcedure,
  protectedProcedure,
  domainProcedure,
} from "~/server/api/trpc";
import { and, eq } from "drizzle-orm";
import { drizzleDb, schema } from "~/server/drizzle";
import { withUpdatedAt } from "~/server/drizzle/touch";
import {
  createDomain,
  deleteDomain,
  getDomain,
  getDomains,
  updateDomain,
} from "~/server/service/domain-service";
import { sendEmail } from "~/server/service/email-service";
import { SesSettingsService } from "~/server/service/ses-settings-service";
import {
  getValidSesRegions,
  sesRegionSchema,
} from "~/lib/zod/ses-setting-schema";

export const domainRouter = createTRPCRouter({
  getAvailableRegions: protectedProcedure.query(async () => {
    const settings = await SesSettingsService.getAllSettings();
    return getValidSesRegions(settings.map((setting) => setting.region));
  }),

  createDomain: teamProcedure
    .input(z.object({ name: z.string(), region: sesRegionSchema }))
    .mutation(async ({ ctx, input }) => {
      return createDomain(
        ctx.team.id,
        input.name,
        input.region,
        ctx.team.sesTenantId ?? undefined
      );
    }),

  startVerification: domainProcedure.mutation(async ({ input }) => {
    await drizzleDb
      .update(schema.domain)
      .set(withUpdatedAt({ isVerifying: true }))
      .where(eq(schema.domain.id, input.id));
  }),

  domains: teamProcedure.query(async ({ ctx }) => {
    return getDomains(ctx.team.id);
  }),

  getDomain: domainProcedure.query(async ({ input, ctx }) => {
    return getDomain(input.id, ctx.team.id);
  }),

  updateDomain: domainProcedure
    .input(
      z.object({
        clickTracking: z.boolean().optional(),
        openTracking: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      return updateDomain(input.id, {
        clickTracking: input.clickTracking,
        openTracking: input.openTracking,
      });
    }),

  deleteDomain: domainProcedure.mutation(async ({ input }) => {
    await deleteDomain(input.id);
    return { success: true };
  }),

  sendTestEmailFromDomain: domainProcedure.mutation(
    async ({
      ctx: {
        session: { user },
        team,
      },
      input,
    }) => {
      const [domain] = await drizzleDb
        .select()
        .from(schema.domain)
        .where(
          and(eq(schema.domain.id, input.id), eq(schema.domain.teamId, team.id)),
        )
        .limit(1);

      if (!domain) {
        throw new Error("Domain not found");
      }

      if (!user.email) {
        throw new Error("User email not found");
      }

      return sendEmail({
        teamId: team.id,
        to: user.email,
        from: `hello@${domain.name}`,
        subject: "useSend test email",
        text: "hello,\n\nuseSend is the best open source sending platform\n\ncheck out https://usesend.com",
        html: "<p>hello,</p><p>useSend is the best open source sending platform<p><p>check out <a href='https://usesend.com'>usesend.com</a>",
      });
    }
  ),
});
