import { customAlphabet } from "nanoid";

/**
 * Generates primary keys for tables that Prisma declared as `@default(cuid())`.
 *
 * Prisma generated those client-side — the columns have no database default —
 * so every Drizzle insert into one of the 13 affected tables has to supply an
 * id explicitly. Centralised here so that stays one decision rather than 13.
 *
 * nanoid rather than a cuid package: it is already a dependency, so this adds
 * nothing to the bundle (which the Workers migration cares about), and the
 * original `cuid` package is deprecated.
 *
 * The alphabet is restricted to lowercase alphanumerics — nanoid's default
 * includes `-` and `_`, and these ids appear in URLs and API responses where
 * looking like the cuids they sit alongside is worth more than two extra bits
 * per character. 24 chars over 36 symbols is ~124 bits of entropy.
 *
 * Existing rows keep their cuids. Nothing validates or parses the format —
 * checked across the app, the public API schemas and the SDK — so the two
 * coexist safely in the same column.
 */
export const createId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 24);
