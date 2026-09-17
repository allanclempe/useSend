import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit owns the schema and the migration history (issue #5).
 *
 * `src/server/drizzle/schema.ts` is the source of truth and is hand-authored.
 * It began life as `drizzle-kit pull` output taken from the Prisma-managed
 * database, so it still reads like generated code, but it is edited directly
 * now — there is no introspection step to regenerate it from.
 *
 * To change the schema: edit `schema.ts`, then `pnpm --filter=web db:generate`
 * to write a migration into `src/server/drizzle/migrations`. Review the SQL it
 * produces before committing it; drizzle-kit infers intent from a diff and
 * cannot tell a rename from a drop-and-add.
 *
 * `db:migrate` applies migrations and is the only command here that writes to a
 * database. See AGENTS.md for which databases it may be pointed at.
 *
 * There is deliberately no `casing` option. Columns in `schema.ts` are declared
 * without an explicit name, so the database name comes from the TS key, and the
 * runtime client in `src/server/drizzle/index.ts` passes no `casing` either —
 * meaning `userId` stays `userId`. This config used to say `snake_case`, which
 * was harmless while drizzle-kit was only ever used to introspect, but made
 * `generate` emit a schema of `user_id` columns that the app could not read.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/drizzle/schema.ts",
  out: "./src/server/drizzle/migrations",
  dbCredentials: {
    // eslint-disable-next-line no-undef
    url: process.env.DATABASE_URL!,
  },
});
