import { defineConfig } from "drizzle-kit";

/**
 * Drizzle is being introduced alongside Prisma (see references/serverless-migration.md
 * and issue #5). The schema is introspected from the live database with
 * `drizzle-kit pull` rather than hand-ported, so it cannot drift from what
 * Prisma's migrations actually produced.
 *
 * Prisma still owns migrations. Do not run `drizzle-kit push` or `generate`
 * against a real database while that is true.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/drizzle/schema.ts",
  out: "./src/server/drizzle",
  dbCredentials: {
    // eslint-disable-next-line no-undef
    url: process.env.DATABASE_URL!,
  },
  casing: "snake_case",
  introspect: { casing: "camel" },
});
