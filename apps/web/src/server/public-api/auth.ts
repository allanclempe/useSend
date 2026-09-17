import { Context } from "hono";
import { eq } from "drizzle-orm";
import { drizzleDb, schema } from "../drizzle";
import { UnsendApiError } from "./api-error";
import { getTeamAndApiKey } from "../service/api-service";
import { isSelfHosted } from "~/utils/common";
import { logger } from "../logger/log";

/**
 * Gets the team from the token. Also will check if the token is valid.
 */
export const getTeamFromToken = async (c: Context) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader) {
    throw new UnsendApiError({
      code: "UNAUTHORIZED",
      message: "No Authorization header provided",
    });
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    throw new UnsendApiError({
      code: "UNAUTHORIZED",
      message: "No Authorization header provided",
    });
  }

  const teamAndApiKey = await getTeamAndApiKey(token);

  if (!teamAndApiKey) {
    throw new UnsendApiError({
      code: "FORBIDDEN",
      message: "Invalid API token",
    });
  }

  const { team, apiKey } = teamAndApiKey;

  if (!team) {
    throw new UnsendApiError({
      code: "FORBIDDEN",
      message: "Invalid API token",
    });
  }

  // No await so it won't block the request. Need to be moved to a queue in future
  drizzleDb
    .update(schema.apiKey)
    .set({ lastUsed: new Date() })
    .where(eq(schema.apiKey.id, apiKey.id))
    .catch((err) =>
      logger.error({ err }, "Failed to update lastUsed on API key")
    );

  return { ...team, apiKeyId: apiKey.id, apiKey: { domainId: apiKey.domainId } };
};
