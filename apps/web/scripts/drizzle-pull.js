#!/usr/bin/env node
/**
 * Introspects the database into src/server/drizzle/schema.ts, then applies the two
 * fixups drizzle-kit cannot express in config.
 *
 * Run this rather than `drizzle-kit pull` directly, or the fixups are lost on
 * the next regenerate. See issue #5.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";

const SCHEMA = "src/server/drizzle/schema.ts";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

try {
  execFileSync("npx", ["drizzle-kit", "pull"], { stdio: "inherit" });
} catch {
  console.error(
    "\ndrizzle-kit pull failed. Is the database up and migrated?\n" +
      "  pnpm test:infra:up\n" +
      "  pnpm --filter=web test:integration:prepare:local\n" +
      "  DATABASE_URL=postgresql://usesend:password@127.0.0.1:54329/usesend_test \\\n" +
      "    pnpm --filter=web db:drizzle-pull",
  );
  process.exit(1);
}

let schema = readFileSync(SCHEMA, "utf8");

// 1. Timestamps must be Date, not string.
//
// drizzle-kit defaults to mode:'string'. Prisma hands back Date objects and the
// codebase does date arithmetic on them all over (scheduledAt, lastSentAt,
// createdAt cutoffs). Leaving these as strings would break silently at runtime
// rather than at the type level in some places, so normalise at generation time.
const before = (schema.match(/mode: 'string'/g) ?? []).length;
schema = schema.replaceAll("mode: 'string'", "mode: 'date'");

// 2. Repair mangled empty-array defaults.
//
// drizzle-kit 0.31 mis-parses a Postgres `ARRAY[]::...` default: it strips the
// leading `AR` and emits the remainder as a value. The exact shape depends on
// the element type, and only one of them fails loudly:
//
//   integer[] -> .default([RAY])    undefined identifier, does not compile
//   text[]    -> .default(["RAY"])  compiles fine, silently wrong default
//
// The quoted form is the dangerous one — it typechecks and would write the
// string "RAY" into the column on any insert that omits the field.
const arrayDefaults = (schema.match(/\.default\(\["?RAY"?\]\)/g) ?? []).length;
schema = schema.replace(/\.default\(\["?RAY"?\]\)/g, ".default([])");

// 3. Drop Prisma's bookkeeping table.
//
// _prisma_migrations belongs to Prisma's migration engine, not to the domain.
// Prisma still owns migrations; this table should never be read through Drizzle.
const removed = schema.includes('pgTable("_prisma_migrations"');
schema = schema.replace(
  /export const prismaMigrations = pgTable\("_prisma_migrations",[\s\S]*?\n\}\);\n\n/,
  "",
);

// 4. Mark the file as generated.
//
// It is regenerated wholesale by this script, so hand edits are lost and there
// is nothing useful to lint — removing _prisma_migrations above also orphans
// whichever imports only it used.
schema =
  `// GENERATED FILE — do not edit.\n` +
  `// Regenerate with: pnpm --filter=web db:drizzle-pull\n` +
  `// Introspected from the live database; see scripts/drizzle-pull.js for the\n` +
  `// fixups applied on top of drizzle-kit's output.\n` +
  `/* eslint-disable */\n\n` +
  schema;

writeFileSync(SCHEMA, schema);

// Drizzle migrations are not in use — Prisma owns the migration history, so the
// generated SQL snapshot and meta journal are noise and would only invite a
// stray `drizzle-kit migrate`.
if (existsSync("src/server/drizzle/meta")) {
  rmSync("src/server/drizzle/meta", { recursive: true, force: true });
}
for (const file of readdirSync("src/server/drizzle")) {
  if (file.endsWith(".sql")) rmSync(`src/server/drizzle/${file}`);
}

console.log(
  `\nfixups: ${before} timestamps → mode:'date'` +
    `; ${arrayDefaults} mangled array default(s) repaired` +
    `; _prisma_migrations ${removed ? "removed" : "not present"}`,
);
