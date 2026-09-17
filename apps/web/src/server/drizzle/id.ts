import { customAlphabet } from "nanoid";

const BODY_LENGTH = 24;
const generate = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", BODY_LENGTH);

/**
 * Generates primary keys for tables Prisma declared as `@default(cuid())`.
 *
 * Prisma generated those client-side — the columns have no database default —
 * so every Drizzle insert into one of the 13 affected tables supplies an id.
 * Centralised here so that stays one decision rather than 13.
 *
 * Shaped to match the cuid1 values already in those columns: 25 lowercase
 * alphanumeric characters, leading `c`. Ids appear in URLs, API responses and
 * customer integrations, so new rows should not be distinguishable from old
 * ones at a glance.
 *
 * It is a matching *shape*, not a real cuid. Generating genuine cuid1 would
 * mean the deprecated `cuid` package, which fingerprints using `os.hostname()`
 * and so does not survive the move to Workers. Backfilling the existing values
 * instead is not on the table — they are externally referenced. nanoid is
 * already a dependency, runs anywhere, and 24 random characters over 36 symbols
 * is ~124 bits, well clear of collision risk.
 *
 * Nothing validates or parses the format — checked across the app, the public
 * API zod schemas and the SDK — so the two coexist safely regardless.
 */
export const createId = () => `c${generate()}`;
