import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { drizzleDb, schema } from "~/server/drizzle";
import { ApiPermission } from "~/types/db";

import {
  apiKeyProcedure,
  createTRPCRouter,
  teamProcedure,
} from "~/server/api/trpc";
import {
  addApiKey,
  deleteApiKey,
  updateApiKey,
} from "~/server/service/api-service";

export const apiRouter = createTRPCRouter({
  createToken: teamProcedure
    .input(
      z.object({
        name: z.string(),
        permission: z.nativeEnum(ApiPermission),
        domainId: z.number().int().positive().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return await addApiKey({
        name: input.name,
        permission: input.permission,
        teamId: ctx.team.id,
        domainId: input.domainId,
      });
    }),

  getApiKeys: teamProcedure.query(async ({ ctx }) => {
    const rows = await drizzleDb
      .select({
        id: schema.apiKey.id,
        name: schema.apiKey.name,
        permission: schema.apiKey.permission,
        partialToken: schema.apiKey.partialToken,
        lastUsed: schema.apiKey.lastUsed,
        createdAt: schema.apiKey.createdAt,
        domainId: schema.apiKey.domainId,
        domainName: schema.domain.name,
      })
      .from(schema.apiKey)
      .leftJoin(schema.domain, eq(schema.domain.id, schema.apiKey.domainId))
      .where(eq(schema.apiKey.teamId, ctx.team.id))
      .orderBy(desc(schema.apiKey.createdAt));

    // Reshaped to Prisma's nested include so the settings page is unchanged.
    const keys = rows.map(({ domainName, ...key }) => ({
      ...key,
      domain: domainName === null ? null : { name: domainName },
    }));

    return keys;
  }),

  updateApiKey: apiKeyProcedure
    .input(
      z.object({
        name: z.string().min(1).optional(),
        domainId: z.number().int().positive().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return await updateApiKey({
        id: input.id,
        teamId: ctx.team.id,
        name: input.name,
        domainId: input.domainId,
      });
    }),

  deleteApiKey: apiKeyProcedure.mutation(async ({ input }) => {
    return deleteApiKey(input.id);
  }),
});
