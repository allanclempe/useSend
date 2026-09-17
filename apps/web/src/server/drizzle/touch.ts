/**
 * Stamps `updatedAt` on a Drizzle update payload.
 *
 * 15 models declare `@updatedAt`, which Prisma maintained client-side — the
 * columns have no database default and there are no triggers. So every Drizzle
 * `.set()` has to supply it, and forgetting fails **silently**: the row updates
 * fine and the timestamp just goes stale. (Inserts fail loudly instead, since
 * the column is NOT NULL with no default.)
 *
 * Wrapping every update in this keeps that from being 15 models' worth of
 * things to remember.
 */
export function withUpdatedAt<T extends Record<string, unknown>>(
  data: T,
): T & { updatedAt: Date } {
  return { ...data, updatedAt: new Date() };
}
