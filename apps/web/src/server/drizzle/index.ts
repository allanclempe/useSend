import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "~/env";
import { logger } from "../logger/log";
import * as relations from "./relations";
import * as schema from "./schema";

/**
 * Drizzle client (issue #5).
 *
 * `postgres-js` rather than the Neon HTTP driver: there are interactive
 * transactions and a `pg_advisory_xact_lock` in the auth path, neither of which
 * neon-http supports. See references/serverless-migration.md §5.
 */
const createDrizzleClient = () => {
  logger.info("Creating Drizzle client");

  const client = postgres(env.DATABASE_URL, {
    // Workers/serverless will run one connection per isolate; this keeps the
    // Node process from holding a large idle pool in the meantime.
    max: env.NODE_ENV === "production" ? 10 : 5,
  });

  return drizzle(client, { schema: { ...schema, ...relations } });
};

// eslint-disable-next-line no-undef
const globalForDrizzle = globalThis as unknown as {
  drizzle: ReturnType<typeof createDrizzleClient> | undefined;
};

export const drizzleDb = globalForDrizzle.drizzle ?? createDrizzleClient();

globalForDrizzle.drizzle = drizzleDb;

export { schema, relations };
