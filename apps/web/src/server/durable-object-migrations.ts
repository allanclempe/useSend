/**
 * The Durable Object migration ledger, in order.
 *
 * Cloudflare does not diff Durable Object classes: it applies *migrations*, and
 * a migration is identified by its `tag`. The account remembers the last tag a
 * script was deployed with, and the next deploy must present the history after
 * that tag and no more. So this list is append-only and the order is load
 * bearing — editing an existing entry, reordering two, or reusing a tag is a
 * deploy that either fails with `Actor migration tag precondition failed` or
 * silently creates a second namespace for a class that already has one.
 *
 * It lives here, next to `binding-registry.ts`, rather than in either of the
 * two files that need it, because both need the *same* one:
 *
 *   - `sst.config.ts` passes it to the Worker as `migrations`, which is
 *     Wrangler's top-level `migrations` shape — SST reads the script's current
 *     tag and uploads only the pending entries.
 *   - `wrangler.jsonc` declares the same ledger under `migrations`, in
 *     snake_case, and `binding-registry.unit.test.ts` asserts the two agree.
 *
 * The field names below are SST's (`newSqliteClasses`); the snake_case
 * (`new_sqlite_classes`) that Wrangler wants is the same data, and the test is
 * what keeps the translation honest.
 *
 * Every class is SQLite backed. SQLite-backed storage is the only option for a
 * new class, and it is what the pricing in §12 of
 * references/serverless-migration.md assumes.
 */
export type DurableObjectMigration = {
  /** Unique, and never reused. Cloudflare keys the account's state on it. */
  readonly tag: string;
  /** Classes created by this migration, on the SQLite storage backend. */
  readonly newSqliteClasses?: readonly string[];
  /** Classes removed by this migration. Drops their storage. */
  readonly deletedClasses?: readonly string[];
  /** Kept when a class is renamed; the original `newSqliteClasses` stays. */
  readonly renamedClasses?: readonly {
    readonly from: string;
    readonly to: string;
  }[];
};

export const DURABLE_OBJECT_MIGRATIONS: readonly DurableObjectMigration[] = [
  { tag: "v1", newSqliteClasses: ["WebhookDispatcher", "CampaignScheduler"] },
  { tag: "v2", newSqliteClasses: ["RateLimiter"] },
  { tag: "v3", newSqliteClasses: ["IdempotencyKeeper"] },
];

/**
 * Every class the ledger has ever created and not deleted.
 *
 * Renames are applied in order, so a class that was created as `Counter` and
 * renamed to `CounterV2` reports as `CounterV2` — which is the name that has to
 * match `DURABLE_OBJECT_BINDINGS` and the exported class in the Worker.
 */
export function migratedDurableObjectClasses(
  migrations: readonly DurableObjectMigration[] = DURABLE_OBJECT_MIGRATIONS,
): readonly string[] {
  const live = new Set<string>();

  for (const migration of migrations) {
    for (const className of migration.newSqliteClasses ?? []) {
      live.add(className);
    }
    for (const { from, to } of migration.renamedClasses ?? []) {
      live.delete(from);
      live.add(to);
    }
    for (const className of migration.deletedClasses ?? []) {
      live.delete(className);
    }
  }

  return [...live];
}
