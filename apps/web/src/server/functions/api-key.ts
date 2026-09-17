import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { drizzleDb, schema } from "~/server/drizzle";
import {
  apiKeyMiddleware,
  teamMiddleware,
} from "~/server/functions/middleware";
import {
  addApiKey,
  deleteApiKey as deleteApiKeyService,
  updateApiKey as updateApiKeyService,
} from "~/server/service/api-service";
import { ApiPermission } from "~/types/db";

/**
 * API keys, from `server/api/routers/api.ts` (#9).
 *
 * The router was mounted as `apiKey` in the tRPC root and this module is named
 * for that rather than for its file — `server/functions/api.ts` would sit one
 * directory away from `server/api/` and mean something else entirely.
 *
 * The token itself is only ever returned once, by `createToken`; everything
 * after that works from `partialToken`.
 */

export const createToken = createServerFn({ method: "POST" })
  .middleware([teamMiddleware])
  .validator(
    z.object({
      name: z.string(),
      permission: z.nativeEnum(ApiPermission),
      domainId: z.number().int().positive().optional(),
    }),
  )
  .handler(({ data, context }) =>
    addApiKey({
      name: data.name,
      permission: data.permission,
      teamId: context.team.id,
      domainId: data.domainId,
    }),
  );

export const getApiKeys = createServerFn({ method: "GET" })
  .middleware([teamMiddleware])
  .handler(async ({ context }) => {
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
      .where(eq(schema.apiKey.teamId, context.team.id))
      .orderBy(desc(schema.apiKey.createdAt));

    // Reshaped to Prisma's nested include so the settings page is unchanged.
    return rows.map(({ domainName, ...key }) => ({
      ...key,
      domain: domainName === null ? null : { name: domainName },
    }));
  });

export const updateApiKey = createServerFn({ method: "POST" })
  .middleware([apiKeyMiddleware])
  .validator(
    z.object({
      name: z.string().min(1).optional(),
      domainId: z.number().int().positive().nullable().optional(),
    }),
  )
  .handler(({ data, context }) =>
    updateApiKeyService({
      id: context.apiKey.id,
      teamId: context.team.id,
      name: data.name,
      domainId: data.domainId,
    }),
  );

export const deleteApiKey = createServerFn({ method: "POST" })
  .middleware([apiKeyMiddleware])
  .handler(({ context }) => deleteApiKeyService(context.apiKey.id));
