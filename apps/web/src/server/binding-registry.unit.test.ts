import { describe, expect, it } from "vitest";

import { readWranglerConfig } from "~/test/wrangler-config";
import {
  DURABLE_OBJECT_BINDINGS,
  DURABLE_OBJECT_CLASSES,
  KV_BINDINGS,
} from "./binding-registry";

/**
 * `binding-registry.ts` and `wrangler.jsonc` have to agree, and nothing else
 * enforces that.
 *
 * The queue registry has the same test for the same reason (§4.1): a binding
 * the code reads and the config does not declare is `undefined` at runtime, on
 * whatever path first touched it. Here it would be a cache read or a rate limit
 * check — one silently degrading, one failing a request.
 */

const config = readWranglerConfig();

const kvNamespaces = config.kv_namespaces ?? [];
const doBindings = config.durable_objects?.bindings ?? [];
const migrations = config.migrations ?? [];

describe("wrangler.jsonc agrees with the binding registry", () => {
  it("declares every KV namespace the code reads", () => {
    expect(kvNamespaces.map((namespace) => namespace.binding).sort()).toEqual(
      [...KV_BINDINGS].sort(),
    );
  });

  it("declares every Durable Object binding, bound to the right class", () => {
    expect(
      Object.fromEntries(
        doBindings.map((binding) => [binding.name, binding.class_name]),
      ),
    ).toEqual({ ...DURABLE_OBJECT_BINDINGS });
  });

  it("covers every Durable Object class with a migration", () => {
    const created = migrations.flatMap((migration) => [
      ...(migration.new_sqlite_classes ?? []),
      ...(migration.new_classes ?? []),
    ]);

    // Every class exactly once: a class listed in two migration tags is a
    // deploy error, and one listed in none never gets storage.
    expect(created.sort()).toEqual([...DURABLE_OBJECT_CLASSES].sort());
  });

  it("gives every migration a distinct tag", () => {
    const tags = migrations.map((migration) => migration.tag);
    expect(new Set(tags).size).toBe(tags.length);
  });
});
