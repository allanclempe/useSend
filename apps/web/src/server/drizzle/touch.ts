/**
 * Stamps `updatedAt` on a Drizzle write payload.
 *
 * 15 models declare `@updatedAt`, which Prisma maintained client-side — the
 * columns have no database default and there are no triggers, so every write
 * has to supply it.
 *
 * **Use this on inserts as well as updates.** Today an insert cannot forget it
 * (all 15 columns are NOT NULL with no default, so TypeScript refuses to
 * compile), while an update that forgets it fails silently and lets the
 * timestamp go stale. Applying the helper only to updates would be correct but
 * relies on that NOT NULL guarantee holding forever — one nullable timestamp
 * added later and inserts go quiet too. One rule is cheaper to keep than a rule
 * with a caveat.
 */
export function withUpdatedAt<T extends Record<string, unknown>>(
  data: T,
): T & { updatedAt: Date } {
  return { ...data, updatedAt: new Date() };
}
