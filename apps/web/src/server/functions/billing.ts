import { createServerFn } from "@tanstack/react-start";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import {
  createCheckoutSessionForTeam,
  getManageSessionUrl as getManageSessionUrlForTeam,
} from "~/server/billing/payments";
import { drizzleDb, schema } from "~/server/drizzle";
import {
  teamAdminMiddleware,
  teamMiddleware,
} from "~/server/functions/middleware";
import { TeamService } from "~/server/service/team-service";
import { getThisMonthUsage as getThisMonthUsageForTeam } from "~/server/service/usage-service";

/**
 * Billing, from `server/api/routers/billing.ts` (#9).
 *
 * The two Stripe redirects are `POST` because they are: each one creates a
 * session at Stripe before it can answer, so they were mutations in tRPC and
 * are mutations here. Only an admin may reach them, or the billing email — a
 * member who can change where the invoices go can change who the account
 * belongs to.
 */

export const createCheckoutSession = createServerFn({ method: "POST" })
  .middleware([teamAdminMiddleware])
  .handler(
    async ({ context }) =>
      (await createCheckoutSessionForTeam(context.team.id)).url,
  );

export const getManageSessionUrl = createServerFn({ method: "POST" })
  .middleware([teamAdminMiddleware])
  .handler(({ context }) => getManageSessionUrlForTeam(context.team.id));

export const getThisMonthUsage = createServerFn({ method: "GET" })
  .middleware([teamMiddleware])
  .handler(({ context }) => getThisMonthUsageForTeam(context.team.id));

export const getSubscriptionDetails = createServerFn({ method: "GET" })
  .middleware([teamMiddleware])
  .handler(async ({ context }) => {
    const [subscription] = await drizzleDb
      .select()
      .from(schema.subscription)
      .where(eq(schema.subscription.teamId, context.team.id))
      .orderBy(asc(schema.subscription.status))
      .limit(1);

    return subscription ?? null;
  });

export const updateBillingEmail = createServerFn({ method: "POST" })
  .middleware([teamAdminMiddleware])
  .validator(z.object({ billingEmail: z.string().email() }))
  .handler(async ({ data, context }) => {
    await TeamService.updateTeam(context.team.id, {
      billingEmail: data.billingEmail,
    });
  });
