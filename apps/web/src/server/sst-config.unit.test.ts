import { beforeAll, describe, expect, it } from "vitest";

import { runSstProgram, type SstProgram } from "~/test/sst-program";
import { readWranglerConfig } from "~/test/wrangler-config";
import { DURABLE_OBJECT_BINDINGS, KV_BINDINGS } from "./binding-registry";
import { DURABLE_OBJECT_MIGRATIONS } from "./durable-object-migrations";
import { CRON_EXPRESSIONS } from "./queue/cron-registry";
import {
  DEAD_LETTER_QUEUE_NAME,
  maxRetriesFor,
  QUEUES,
} from "./queue/queue-registry";

/**
 * The repo root `sst.config.ts` and `apps/web/wrangler.jsonc` have to describe
 * the same Worker.
 *
 * They coexist on purpose for one PR (#130 A): `wrangler.jsonc` still drives
 * `vite dev` and `wrangler deploy`, and the SST program is not deployed by
 * anything. The whole value of that arrangement is that the two can be diffed
 * — a reviewer gets to ask one question instead of reading 456 lines of JSONC
 * against 250 lines of TypeScript. This is that diff.
 *
 * It is not a text comparison. `sst-program.ts` runs `run()` with recording
 * stubs, so what is asserted below is what the program actually declares, loops
 * and all.
 *
 * ## The differences that are real, and why each one is allowed
 *
 * SST names resources per stage, with a random suffix, and nothing in the app
 * may depend on those names. Three do not matter and one does:
 *
 *   - **R2 bucket name.** `wrangler.jsonc` says `usesend`; SST will say
 *     `usesend-<stage>-storage-<random>`. Nothing reads it — the app reaches
 *     the bucket through the `STORAGE` binding — so only the binding is
 *     asserted.
 *   - **KV namespace id** and **Hyperdrive id.** Placeholders in
 *     `wrangler.jsonc` (`REPLACE_WITH_…`) that a human pastes in after running
 *     a `wrangler … create`. Under SST they are outputs of the deploy, which is
 *     the improvement. Bindings asserted, ids not.
 *   - **Queue names do matter**, and are therefore pinned rather than
 *     generated: the consumer resolves its `QueueDefinition` from
 *     `MessageBatch.queue`, which is the account-level queue name. A generated
 *     name would break `queueDefinitionByQueueName` silently, at runtime, on
 *     the SES event path. So the test asserts them exactly.
 *
 * The Worker's own script name is per-stage under SST and fixed (`usesend`) in
 * `wrangler.jsonc`. Nothing reads it either; what matters is that consumers and
 * crons all name the *same* script, and that is asserted as a shape.
 */

let program: SstProgram;

const wrangler = readWranglerConfig();
const wranglerConsumers = wrangler.queues?.consumers ?? [];
const wranglerProducers = wrangler.queues?.producers ?? [];

beforeAll(async () => {
  program = await runSstProgram("test");
});

describe("sst.config.ts describes the same Worker as wrangler.jsonc", () => {
  it("deploys one Cloudflare app", () => {
    expect(program.app.name).toBe(wrangler.name ?? "usesend");
    expect(program.app.home).toBe("cloudflare");
  });

  it("sets the same compatibility date and flags", () => {
    expect(program.worker.compatibilityDate).toBe(wrangler.compatibility_date);
    expect(program.worker.compatibilityFlags).toEqual(
      wrangler.compatibility_flags,
    );
  });

  it("keeps observability on", () => {
    expect(program.worker.observability).toEqual(wrangler.observability);
  });

  it("builds the app from apps/web", () => {
    // `wrangler.jsonc` lives in `apps/web` and names `src/server.ts`; the SST
    // program is at the repo root and points the site component at the same
    // directory. The entry itself is the framework's, not ours.
    expect(program.worker.path).toBe("apps/web");
  });
});

describe("bindings", () => {
  const byType = (type: string) =>
    program.worker.bindings
      .filter((binding) => binding.type === type)
      .map((binding) => binding.name)
      .sort();

  it("binds the same KV namespaces", () => {
    expect(byType("kv_namespace")).toEqual(
      (wrangler.kv_namespaces ?? []).map((kv) => kv.binding).sort(),
    );
    expect(byType("kv_namespace")).toEqual([...KV_BINDINGS].sort());
  });

  it("binds R2 and Hyperdrive", () => {
    expect(byType("r2_bucket")).toEqual(["STORAGE"]);
    expect(byType("hyperdrive")).toEqual(["HYPERDRIVE"]);
  });

  it("binds every Durable Object to the same class", () => {
    const declared = Object.fromEntries(
      program.worker.bindings
        .filter((binding) => binding.type === "durable_object_namespace")
        .map((binding) => [binding.name, binding.properties.className]),
    );

    expect(declared).toEqual(
      Object.fromEntries(
        (wrangler.durable_objects?.bindings ?? []).map((binding) => [
          binding.name,
          binding.class_name,
        ]),
      ),
    );
    expect(declared).toEqual({ ...DURABLE_OBJECT_BINDINGS });
  });

  it("binds a Durable Object to this same script, not another one", () => {
    // An explicit `scriptName` would bind to a *different* Worker's namespace.
    // `wrangler.jsonc` omits `script_name` for the same reason.
    for (const binding of program.worker.bindings) {
      if (binding.type !== "durable_object_namespace") continue;
      expect(binding.properties.scriptName).toBeUndefined();
    }
  });

  it("binds a queue producer for every queue wrangler.jsonc declares", () => {
    const declared = program.worker.bindings
      .filter((binding) => binding.type === "queue")
      .map((binding) => ({
        binding: binding.name,
        queue: binding.properties.queueName,
      }));

    expect(declared).toEqual(
      wranglerProducers.map((producer) => ({
        binding: producer.binding,
        queue: producer.queue,
      })),
    );
  });

  it("adds nothing to env that wrangler.jsonc does not declare", () => {
    // `SST_RESOURCE_App` is SST's own and has no wrangler equivalent; every
    // other binding has to be accounted for above.
    const wranglerBindings = [
      ...(wrangler.kv_namespaces ?? []).map((kv) => kv.binding),
      ...(wrangler.durable_objects?.bindings ?? []).map(
        (binding) => binding.name,
      ),
      ...wranglerProducers.map((producer) => producer.binding),
      "HYPERDRIVE",
      "STORAGE",
    ].sort();

    expect(
      program.worker.bindings
        .map((binding) => binding.name)
        .filter((name) => name !== "SST_RESOURCE_App")
        .sort(),
    ).toEqual(wranglerBindings);
  });
});

describe("durable object migrations", () => {
  it("carries the same ledger, in the same order", () => {
    expect(
      program.worker.migrations.map((migration) => ({
        tag: migration.tag,
        new_sqlite_classes: migration.newSqliteClasses,
      })),
    ).toEqual(
      (wrangler.migrations ?? []).map((migration) => ({
        tag: migration.tag,
        new_sqlite_classes: migration.new_sqlite_classes,
      })),
    );
  });

  it("is the ledger module, not a second copy of it", () => {
    expect(program.worker.migrations).toEqual(
      DURABLE_OBJECT_MIGRATIONS.map((migration) => ({ ...migration })),
    );
  });
});

describe("queues", () => {
  it("creates every queue wrangler.jsonc declares, under the same name", () => {
    const declared = program.queues.map((queue) => queue.queueName).sort();
    const expected = [
      ...QUEUES.map((queue) => queue.queueName),
      DEAD_LETTER_QUEUE_NAME,
    ].sort();

    expect(declared).toEqual(expected);
    // Every queue wrangler.jsonc consumes exists in the program too.
    expect(declared).toEqual(
      wranglerConsumers.map((consumer) => consumer.queue).sort(),
    );
  });

  it("names no queue after the stage", () => {
    // The stage handed to the program is "test". If any queue name picked it
    // up, `queueDefinitionByQueueName` would miss at runtime.
    for (const queue of program.queues) {
      expect(queue.queueName).not.toContain("test");
      expect(queue.queueName.startsWith("usesend-")).toBe(true);
    }
  });

  it("declares no producer binding for the dead letter queue", () => {
    // Nothing enqueues to it; Cloudflare does, on a message's last failure.
    // `wrangler.jsonc` leaves it out of `producers` for the same reason.
    expect(
      program.worker.bindings.filter(
        (binding) => binding.properties.queueName === DEAD_LETTER_QUEUE_NAME,
      ),
    ).toEqual([]);
    expect(
      wranglerProducers.filter(
        (producer) => producer.queue === DEAD_LETTER_QUEUE_NAME,
      ),
    ).toEqual([]);
  });
});

describe("consumers", () => {
  const consumerFor = (queueName: string) =>
    program.consumers.find((consumer) => consumer.queueName === queueName);

  it("gives every queue exactly one consumer on the one Worker", () => {
    expect(
      program.consumers.map((consumer) => consumer.queueName).sort(),
    ).toEqual(wranglerConsumers.map((consumer) => consumer.queue).sort());

    // The reason consumers are raw `cloudflare.QueueConsumer` resources rather
    // than `Queue.subscribe()`: one script serves all 32 of them.
    const scripts = new Set(program.consumers.map((c) => c.scriptName));
    expect([...scripts]).toEqual([program.worker.scriptName]);

    for (const consumer of program.consumers) {
      expect(consumer.type).toBe("worker");
    }
  });

  it("matches wrangler.jsonc's batch, retry and concurrency settings", () => {
    for (const wranglerConsumer of wranglerConsumers) {
      const consumer = consumerFor(wranglerConsumer.queue);
      expect(
        consumer,
        `no consumer for ${wranglerConsumer.queue}`,
      ).toBeDefined();

      expect(consumer!.settings.batchSize).toBe(
        wranglerConsumer.max_batch_size,
      );
      // Wrangler takes `max_batch_timeout` in seconds; the API takes
      // milliseconds. This is the only unit conversion in the translation.
      expect(consumer!.settings.maxWaitTimeMs).toBe(
        (wranglerConsumer.max_batch_timeout ?? 0) * 1000,
      );
      expect(consumer!.settings.maxRetries).toBe(wranglerConsumer.max_retries);
      expect(consumer!.settings.maxConcurrency).toBe(
        wranglerConsumer.max_concurrency,
      );
      expect(consumer!.deadLetterQueue).toBe(
        wranglerConsumer.dead_letter_queue,
      );
    }
  });

  it("derives those settings from the registry, not from a second copy", () => {
    for (const queue of QUEUES) {
      const consumer = consumerFor(queue.queueName)!;

      expect(consumer.settings.batchSize).toBe(queue.maxBatchSize);
      expect(consumer.settings.maxWaitTimeMs).toBe(
        queue.maxBatchTimeout * 1000,
      );
      expect(consumer.settings.maxRetries).toBe(maxRetriesFor(queue));
      expect(consumer.settings.maxConcurrency).toBe(
        queue.maxConcurrency ?? undefined,
      );
      expect(consumer.deadLetterQueue).toBe(DEAD_LETTER_QUEUE_NAME);
    }
  });

  it("does not dead-letter the dead letter queue", () => {
    const consumer = consumerFor(DEAD_LETTER_QUEUE_NAME)!;

    expect(consumer.deadLetterQueue).toBeUndefined();
    expect(consumer.settings.maxRetries).toBe(0);
  });
});

describe("cron triggers", () => {
  it("declares exactly the registry's expressions", () => {
    expect([...program.crons].sort()).toEqual([...CRON_EXPRESSIONS].sort());
  });

  it("declares exactly wrangler.jsonc's expressions", () => {
    expect([...program.crons].sort()).toEqual(
      [...(wrangler.triggers?.crons ?? [])].sort(),
    );
  });
});

describe("what the program adds that wrangler.jsonc cannot say", () => {
  it("takes the database connection from a secret, not from the file", () => {
    // `wrangler.jsonc` can only carry `localConnectionString`, which is dev
    // only; the deployed Hyperdrive id is pasted in by hand. Under SST the
    // origin is derived from one secret and the id is an output.
    expect(program.resources).toContainEqual({
      type: "sst.Secret",
      name: "DatabaseUrl",
      args: {},
    });

    const hyperdrive = program.resources.find(
      (resource) => resource.type === "sst.cloudflare.Hyperdrive",
    );
    expect(hyperdrive?.name).toBe("HYPERDRIVE");
    expect(hyperdrive?.args.origin).toEqual({
      scheme: "postgres",
      host: "localhost",
      port: 54320,
      database: "neondb",
      user: "neon",
      password: "npg",
    });
  });
});
