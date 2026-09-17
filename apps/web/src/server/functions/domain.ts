import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";

import {
  getValidSesRegions,
  sesRegionSchema,
} from "~/lib/zod/ses-setting-schema";
import { badRequest } from "~/server/app-error";
import { drizzleDb, schema } from "~/server/drizzle";
import { withUpdatedAt } from "~/server/drizzle/touch";
import {
  domainMiddleware,
  protectedMiddleware,
  teamMiddleware,
} from "~/server/functions/middleware";
import {
  createDomain as createDomainForTeam,
  deleteDomain as deleteDomainById,
  getDomain as getDomainForTeam,
  getDomains as getDomainsForTeam,
  updateDomain as updateDomainById,
} from "~/server/service/domain-service";
import { sendEmail } from "~/server/service/email-service";
import { SesSettingsService } from "~/server/service/ses-settings-service";

/**
 * Sending domains, from `server/api/routers/domain.ts` (#9).
 *
 * The service functions this wraps carry the same names as the functions it
 * exports, so each one is imported under an alias. The exported name is the
 * one the dashboard calls; the alias is an implementation detail.
 *
 * `getAvailableRegions` is the odd one out at `protectedMiddleware`: it lists
 * the regions this *installation* has SES credentials for, which is a property
 * of the deployment rather than of anybody's team, and the add-domain dialog
 * needs it before a team is in play.
 */

export const getAvailableRegions = createServerFn({ method: "GET" })
  .middleware([protectedMiddleware])
  .handler(async () => {
    const settings = await SesSettingsService.getAllSettings();
    return getValidSesRegions(settings.map((setting) => setting.region));
  });

export const createDomain = createServerFn({ method: "POST" })
  .middleware([teamMiddleware])
  .validator(z.object({ name: z.string(), region: sesRegionSchema }))
  .handler(({ data, context }) =>
    createDomainForTeam(
      context.team.id,
      data.name,
      data.region,
      context.team.sesTenantId ?? undefined,
    ),
  );

export const startVerification = createServerFn({ method: "POST" })
  .middleware([domainMiddleware])
  .handler(async ({ context }) => {
    await drizzleDb
      .update(schema.domain)
      .set(withUpdatedAt({ isVerifying: true }))
      .where(eq(schema.domain.id, context.domain.id));
  });

export const domains = createServerFn({ method: "GET" })
  .middleware([teamMiddleware])
  .handler(({ context }) => getDomainsForTeam(context.team.id));

export const getDomain = createServerFn({ method: "GET" })
  .middleware([domainMiddleware])
  .handler(({ context }) =>
    getDomainForTeam(context.domain.id, context.team.id),
  );

export const updateDomain = createServerFn({ method: "POST" })
  .middleware([domainMiddleware])
  .validator(
    z.object({
      clickTracking: z.boolean().optional(),
      openTracking: z.boolean().optional(),
    }),
  )
  .handler(({ data, context }) =>
    updateDomainById(context.domain.id, {
      clickTracking: data.clickTracking,
      openTracking: data.openTracking,
    }),
  );

export const deleteDomain = createServerFn({ method: "POST" })
  .middleware([domainMiddleware])
  .handler(async ({ context }) => {
    await deleteDomainById(context.domain.id);
    return { success: true };
  });

/**
 * The "send yourself a test" button on the domain page.
 *
 * tRPC re-ran the domain lookup here even though `domainProcedure` had just
 * done it; `context.domain` is the row from that same query, so the second one
 * is gone.
 */
export const sendTestEmailFromDomain = createServerFn({ method: "POST" })
  .middleware([domainMiddleware])
  .handler(({ context }) => {
    const { user, team, domain } = context;

    if (!user.email) {
      throw badRequest("User email not found");
    }

    return sendEmail({
      teamId: team.id,
      to: user.email,
      from: `hello@${domain.name}`,
      subject: "useSend test email",
      text: "hello,\n\nuseSend is the best open source sending platform\n\ncheck out https://usesend.com",
      html: "<p>hello,</p><p>useSend is the best open source sending platform<p><p>check out <a href='https://usesend.com'>usesend.com</a>",
    });
  });
