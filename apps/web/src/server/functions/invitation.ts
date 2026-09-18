import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { notFound } from "~/server/app-error";
import { drizzleDb, schema } from "~/server/drizzle";
import { protectedMiddleware } from "~/server/functions/middleware";

/**
 * Team invites as the invitee sees them, from
 * `server/api/routers/invitiation.ts` — spelling fixed on the way over (#9).
 *
 * All three are `protectedMiddleware` and not `teamMiddleware`, and that is
 * the point: someone accepting an invite has no team yet, so requiring one
 * would lock out exactly the people these are for. The scoping is the
 * invitee's own email address instead.
 */

export const getUserInvites = createServerFn({ method: "GET" })
  .middleware([protectedMiddleware])
  .validator(z.object({ inviteId: z.string().optional().nullable() }))
  .handler(async ({ data, context }) => {
    if (!context.user.email) {
      return [];
    }

    const rows = await drizzleDb
      .select({ invite: schema.teamInvite, team: schema.team })
      .from(schema.teamInvite)
      .innerJoin(schema.team, eq(schema.team.id, schema.teamInvite.teamId))
      .where(
        data.inviteId
          ? eq(schema.teamInvite.id, data.inviteId)
          : eq(schema.teamInvite.email, context.user.email),
      );

    // Reshaped to Prisma's nested include so the join page is unchanged.
    return rows.map(({ invite, team }) => ({ ...invite, team }));
  });

export const getInvite = createServerFn({ method: "GET" })
  .middleware([protectedMiddleware])
  .validator(z.object({ inviteId: z.string() }))
  .handler(async ({ data }) => {
    const [invite] = await drizzleDb
      .select()
      .from(schema.teamInvite)
      .where(eq(schema.teamInvite.id, data.inviteId))
      .limit(1);

    return invite ?? null;
  });

export const acceptTeamInvite = createServerFn({ method: "POST" })
  .middleware([protectedMiddleware])
  .validator(z.object({ inviteId: z.string() }))
  .handler(async ({ data, context }) => {
    const [invite] = await drizzleDb
      .select()
      .from(schema.teamInvite)
      .where(eq(schema.teamInvite.id, data.inviteId))
      .limit(1);

    if (!invite) {
      throw notFound("Invite not found");
    }

    // Both writes in one transaction: accepting an invite must not leave the
    // invite consumed without the membership, or vice versa.
    await drizzleDb.transaction(async (tx) => {
      await tx.insert(schema.teamUser).values({
        teamId: invite.teamId,
        userId: context.user.id,
        role: invite.role,
      });

      await tx
        .delete(schema.teamInvite)
        .where(eq(schema.teamInvite.id, data.inviteId));
    });

    return true;
  });
