import { AsyncLocalStorage } from "node:async_hooks";
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
export function createDrizzleClient(connectionString: string, max: number) {
  const client = postgres(connectionString, { max });

  return {
    db: drizzle(client, { schema: { ...schema, ...relations } }),
    close: () => client.end({ timeout: 5 }),
  };
}

type DrizzleClient = ReturnType<typeof createDrizzleClient>["db"];

// eslint-disable-next-line no-undef
const globalForDrizzle = globalThis as unknown as {
  drizzle: DrizzleClient | undefined;
};

/**
 * A Worker cannot share a database connection between requests.
 *
 * Workers ties every I/O object to the request that created it; touching a
 * socket from a later request fails with "Cannot perform I/O on behalf of a
 * different request". A module-level client therefore works for exactly one
 * request and then poisons every request after it. The Worker entry point
 * builds a client per request and puts it here; `AsyncLocalStorage` is the same
 * mechanism `withLogger` already uses to carry per-request context.
 */
const requestScopedDb = new AsyncLocalStorage<DrizzleClient>();

export function withDrizzleClient<T>(client: DrizzleClient, fn: () => T): T {
  return requestScopedDb.run(client, fn);
}

/**
 * Built on first use, not at module load: `postgres-js` opens its first socket
 * as soon as the client is constructed, and Workers forbid I/O in global scope.
 */
function nodeClient(): DrizzleClient {
  if (!globalForDrizzle.drizzle) {
    logger.info("Creating Drizzle client");
    globalForDrizzle.drizzle = createDrizzleClient(
      env.DATABASE_URL,
      // One Node process holds the pool; a Worker gets one connection per
      // request instead, from the branch above.
      env.NODE_ENV === "production" ? 10 : 5,
    ).db;
  }
  return globalForDrizzle.drizzle;
}

function getClient(): DrizzleClient {
  return requestScopedDb.getStore() ?? nodeClient();
}

// eslint-disable-next-line no-undef
export const drizzleDb: DrizzleClient = new Proxy({} as DrizzleClient, {
  get(_target, prop) {
    const client = getClient();
    const value = (client as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
  has: (_target, prop) => prop in (getClient() as object),
});

export { schema, relations };
