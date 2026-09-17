import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { drizzleDb, schema } from "~/server/drizzle";
import { z } from "zod";

import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";

export const invitationRouter = createTRPCRouter({
  getUserInvites: protectedProcedure
    .input(
      z.object({
        inviteId: z.string().optional().nullable(),
      })
    )
    .query(async ({ ctx, input }) => {
      if (!ctx.session.user.email) {
        return [];
      }

      const rows = await drizzleDb
        .select({ invite: schema.teamInvite, team: schema.team })
        .from(schema.teamInvite)
        .innerJoin(schema.team, eq(schema.team.id, schema.teamInvite.teamId))
        .where(
          input.inviteId
            ? eq(schema.teamInvite.id, input.inviteId)
            : eq(schema.teamInvite.email, ctx.session.user.email),
        );

      // Reshaped to Prisma's nested include so the join page is unchanged.
      return rows.map(({ invite, team }) => ({ ...invite, team }));
    }),

  getInvite: protectedProcedure
    .input(z.object({ inviteId: z.string() }))
    .query(async ({ input }) => {
      const [invite] = await drizzleDb
        .select()
        .from(schema.teamInvite)
        .where(eq(schema.teamInvite.id, input.inviteId))
        .limit(1);

      return invite ?? null;
    }),

  acceptTeamInvite: protectedProcedure
    .input(z.object({ inviteId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const [invite] = await drizzleDb
        .select()
        .from(schema.teamInvite)
        .where(eq(schema.teamInvite.id, input.inviteId))
        .limit(1);

      if (!invite) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Invite not found",
        });
      }

      // Both writes in one transaction: accepting an invite must not leave the
      // invite consumed without the membership, or vice versa.
      await drizzleDb.transaction(async (tx) => {
        await tx.insert(schema.teamUser).values({
          teamId: invite.teamId,
          userId: ctx.session.user.id,
          role: invite.role,
        });

        await tx
          .delete(schema.teamInvite)
          .where(eq(schema.teamInvite.id, input.inviteId));
      });
      // No need to invalidate cache here again

      return true;
    }),
});
