import { sql } from "drizzle-orm";
import { drizzleDb } from "~/server/drizzle";
import { getRedis } from "~/server/redis";

export const integrationEnabled = process.env.RUN_INTEGRATION === "true";

export async function resetDatabase() {
  const rows = await drizzleDb.execute<{ tablename: string }>(sql`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename != '_prisma_migrations'
  `);

  if (rows.length === 0) {
    return;
  }

  const tables = rows.map((row) => `"public"."${row.tablename}"`).join(", ");

  await drizzleDb.execute(
    sql.raw(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE;`),
  );
}

export async function resetRedis() {
  await getRedis().flushdb();
}

export async function closeIntegrationConnections() {
  // The Drizzle client is deliberately left open. postgres-js `end()` is
  // terminal, and the client is a module-level singleton shared by every file
  // in the single-fork run — the first afterAll to close it would fail every
  // file after it. Prisma's `$disconnect` used to be called here; it was safe
  // only because it reconnected lazily.
  const redis = getRedis();
  if (redis.status !== "end") {
    await redis.quit();
  }
}
