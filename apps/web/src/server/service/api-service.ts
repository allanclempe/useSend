import { ApiPermission } from "~/types/db";
import { and, eq } from "drizzle-orm";
import { drizzleDb, schema } from "../drizzle";
import { withUpdatedAt } from "../drizzle/touch";
import { randomBytes } from "crypto";
import { smallNanoid } from "../nanoid";
import { createSecureHash, verifySecureHash } from "../crypto";
import { logger } from "../logger/log";

export async function addApiKey({
  name,
  permission,
  teamId,
  domainId,
}: {
  name: string;
  permission: ApiPermission;
  teamId: number;
  domainId?: number;
}) {
  try {
    // Validate domain ownership if domainId is provided
    if (domainId !== undefined) {
      const [domain] = await drizzleDb
        .select({ id: schema.domain.id })
        .from(schema.domain)
        .where(
          and(eq(schema.domain.id, domainId), eq(schema.domain.teamId, teamId)),
        )
        .limit(1);

      if (!domain) {
        throw new Error("DOMAIN_NOT_FOUND");
      }
    }

    const clientId = smallNanoid(10);
    const token = randomBytes(16).toString("hex");
    const hashedToken = await createSecureHash(token);

    const apiKey = `us_${clientId}_${token}`;

    await drizzleDb.insert(schema.apiKey).values(
      withUpdatedAt({
        name,
        permission: permission,
        teamId,
        domainId,
        tokenHash: hashedToken,
        partialToken: `${apiKey.slice(0, 6)}...${apiKey.slice(-3)}`,
        clientId,
      }),
    );
    return apiKey;
  } catch (error) {
    logger.error({ err: error }, "Error adding API key");
    throw error;
  }
}

export async function getTeamAndApiKey(apiKey: string) {
  const [, clientId, token] = apiKey.split("_") as [string, string, string];

  const [row] = await drizzleDb
    .select({
      apiKey: schema.apiKey,
      domainId: schema.domain.id,
      domainName: schema.domain.name,
    })
    .from(schema.apiKey)
    .leftJoin(schema.domain, eq(schema.domain.id, schema.apiKey.domainId))
    .where(eq(schema.apiKey.clientId, clientId))
    .limit(1);

  if (!row) {
    return null;
  }

  // Reshaped to Prisma's nested include for the public API auth path.
  const apiKeyRow = {
    ...row.apiKey,
    domain:
      row.domainId === null ? null : { id: row.domainId, name: row.domainName! },
  };

  try {
    const isValid = await verifySecureHash(token, apiKeyRow.tokenHash);
    if (!isValid) {
      return null;
    }

    const [team] = await drizzleDb
      .select()
      .from(schema.team)
      .where(eq(schema.team.id, apiKeyRow.teamId))
      .limit(1);

    return { team: team ?? null, apiKey: apiKeyRow };
  } catch (error) {
    logger.error({ err: error }, "Error verifying API key");
    return null;
  }
}

export async function updateApiKey({
  id,
  teamId,
  name,
  domainId,
}: {
  id: number;
  teamId: number;
  name?: string;
  domainId?: number | null;
}) {
  try {
    if (domainId !== undefined && domainId !== null) {
      const [domain] = await drizzleDb
        .select({ id: schema.domain.id })
        .from(schema.domain)
        .where(
          and(eq(schema.domain.id, domainId), eq(schema.domain.teamId, teamId)),
        )
        .limit(1);

      if (!domain) {
        throw new Error("DOMAIN_NOT_FOUND");
      }
    }

    const [updated] = await drizzleDb
      .update(schema.apiKey)
      .set(
        withUpdatedAt({
          ...(name !== undefined && { name }),
          ...(domainId !== undefined && { domainId }),
        }),
      )
      .where(and(eq(schema.apiKey.id, id), eq(schema.apiKey.teamId, teamId)))
      .returning();

    if (!updated) {
      throw new Error("API key not found");
    }

    return updated;
  } catch (error) {
    logger.error({ err: error }, "Error updating API key");
    throw error;
  }
}

export async function deleteApiKey(id: number) {
  try {
    await drizzleDb.delete(schema.apiKey).where(eq(schema.apiKey.id, id));
  } catch (error) {
    logger.error({ err: error }, "Error deleting API key");
    throw error;
  }
}
