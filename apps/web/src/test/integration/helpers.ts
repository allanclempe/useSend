import { sql } from "drizzle-orm";
import { drizzleDb } from "~/server/drizzle";
import { installWorkerBindings } from "./bindings";

export { pendingWebhookDeliveries, resetWorkerBindings } from "./bindings";

/**
 * Publishes the in-memory Worker bindings for the whole run.
 *
 * Here rather than in a vitest `setupFiles` entry, and the difference is not
 * cosmetic: `bindings.ts` imports the three Durable Object classes, which pull
 * in a large part of the server module graph. A setup file is evaluated
 * *before* the test module, so every one of those modules would already be in
 * the registry by the time a test file's hoisted `vi.mock` calls ran, and the
 * mocks would silently not apply. Imported from here, the whole graph loads
 * after the test file's mocks are registered — which is also why this module,
 * and not `bindings.ts`, is what tests import.
 */
installWorkerBindings();

export const integrationEnabled = process.env.RUN_INTEGRATION === "true";

export async function resetDatabase() {
  // Every table in `public` is a domain table. drizzle-kit keeps its migration
  // journal in a separate `drizzle` schema, so unlike Prisma's
  // `_prisma_migrations` there is no bookkeeping table to exclude here.
  const rows = await drizzleDb.execute<{ tablename: string }>(sql`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
  `);

  if (rows.length === 0) {
    return;
  }

  const tables = rows.map((row) => `"public"."${row.tablename}"`).join(", ");

  await drizzleDb.execute(
    sql.raw(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE;`),
  );
}

export async function closeIntegrationConnections() {
  // The Drizzle client is deliberately left open. postgres-js `end()` is
  // terminal, and the client is a module-level singleton shared by every file
  // in the single-fork run — the first afterAll to close it would fail every
  // file after it. Prisma's `$disconnect` used to be called here; it was safe
  // only because it reconnected lazily.
  //
  // There is nothing else left to close. This used to quit the Redis
  // connection, which was the only other socket a test file opened; the cache,
  // the rate limiter and the idempotency store are Durable Objects and KV now,
  // and in this process they are memory (#12).
}
