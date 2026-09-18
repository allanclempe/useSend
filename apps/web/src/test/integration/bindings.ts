import type { DurableObjectState } from "@cloudflare/workers-types";

import type { DurableObjectState as ShimState } from "~/test/setup/cloudflare-workers-shim";
import { IdempotencyKeeper } from "~/worker/idempotency-keeper";
import { RateLimiter } from "~/worker/rate-limiter";
import { WebhookDispatcher } from "~/worker/webhook-dispatcher";
import {
  setAmbientWorkerBindings,
  type WorkerBindings,
} from "~/server/worker-bindings";

/**
 * Worker bindings for the integration suite, which runs under Node.
 *
 * **Why this exists.** Phase 10 (#12) deleted the Redis drivers, so there is
 * one cache driver, one rate limiter and one idempotency store, and all three
 * reach for a binding. Integration tests are not a Worker and have no bindings,
 * so before this the suite had nothing to run against. The three options were
 * an in-memory driver behind each seam, moving the suite onto
 * `@cloudflare/vitest-pool-workers`, or this: keep the drivers and supply the
 * bindings.
 *
 * This one is chosen because it is the only one that *strengthens* the suite.
 * The tests used to exercise `cache/redis-driver.ts` and friends — code that
 * was about to be deleted and had never run in production. They now exercise
 * `cache/kv-driver.ts`, both Durable Object drivers and the real
 * `RateLimiter`, `IdempotencyKeeper` and `WebhookDispatcher` classes, which is
 * what a deploy runs. An in-memory *driver* would have tested a fake instead,
 * and would have needed a branch in each seam to select it — the branch Phase
 * 10 exists to delete.
 *
 * **What is faked, precisely:** Durable Object storage and the KV namespace,
 * and nothing above them. Three differences from the real runtime, all
 * deliberate:
 *
 * - **Alarms never fire.** Nothing schedules them here. Both alarms are
 *   storage reclamation for entries that have already expired, and expiry is a
 *   field that is checked on read rather than something that happens, so no
 *   assertion depends on one — see `IdempotencyKeeper.alarm`.
 * - **KV is strongly consistent.** The real one is not, and `kv-driver.ts`
 *   documents where that shows. This is the optimistic reading, which is also
 *   what Redis did, so it does not change what the tests assert.
 * - **Only the bindings the Node-facing code needs are here.** No
 *   `HYPERDRIVE` (the suite uses `DATABASE_URL`), no `STORAGE` (which is how
 *   `isStorageConfigured()` stays false), and no queue producers — the four
 *   tests that enqueue stub the queue driver instead, which is what they
 *   already did.
 */

class MemoryStorage {
  private readonly entries = new Map<string, unknown>();
  private alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.entries.get(key);
    // Durable Object storage serialises, so a caller cannot hold a reference
    // into it and mutate what a later `get` returns.
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.entries.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }

  async deleteAll(): Promise<void> {
    this.entries.clear();
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

/**
 * The part worth reproducing: one object runs one thing at a time.
 *
 * `blockConcurrencyWhile` is load-bearing in all three classes — it is the
 * reason the Redis lock and its Lua release could be deleted rather than
 * ported. Chaining the callbacks gives the same guarantee in a single-threaded
 * test process, so a test that fires ten concurrent `begin` calls on one key
 * still sees exactly one of them win.
 */
class MemoryDurableObjectState implements ShimState {
  readonly storage = new MemoryStorage();
  private tail: Promise<unknown> = Promise.resolve();

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const result = this.tail.then(callback, callback);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/* eslint-disable no-unused-vars -- parameter names in a type signature */
type DurableObjectClass<T> = new (
  ctx: DurableObjectState,
  env: WorkerBindings,
) => T;
/* eslint-enable no-unused-vars */

class MemoryDurableObjectNamespace<T> {
  private readonly objects = new Map<string, T>();

  constructor(
    private readonly factory: DurableObjectClass<T>,
    private readonly env: () => WorkerBindings,
  ) {}

  /** The name *is* the id here. All three classes name their objects. */
  idFromName(name: string): string {
    return name;
  }

  get(id: string): T {
    let object = this.objects.get(id);

    if (!object) {
      // The real constructor, with a `ctx` that carries the parts of
      // `DurableObjectState` these three classes touch and nothing else — the
      // cast is the whole surface of the pretence.
      object = new this.factory(
        new MemoryDurableObjectState() as unknown as DurableObjectState,
        this.env(),
      );
      this.objects.set(id, object);
    }

    return object;
  }

  /** Every object that has been reached. Storage is per object, so this is it. */
  instances(): T[] {
    return [...this.objects.values()];
  }

  reset() {
    this.objects.clear();
  }
}

class MemoryKvNamespace {
  private readonly entries = new Map<
    string,
    { value: string; expiresAt: number | null }
  >();

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);

    if (!entry) {
      return null;
    }

    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }

    return entry.value;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    this.entries.set(key, {
      value,
      expiresAt: options?.expirationTtl
        ? Date.now() + options.expirationTtl * 1000
        : null,
    });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  reset() {
    this.entries.clear();
  }
}

const cache = new MemoryKvNamespace();

// `env` is read lazily so the three namespaces can be handed the same bindings
// object they are members of.
const bindingsRef: { current: WorkerBindings | undefined } = {
  current: undefined,
};
const env = () => bindingsRef.current!;

const rateLimiter = new MemoryDurableObjectNamespace(RateLimiter, env);
const idempotencyKeeper = new MemoryDurableObjectNamespace(
  IdempotencyKeeper,
  env,
);
const webhookDispatcher = new MemoryDurableObjectNamespace(
  WebhookDispatcher,
  env,
);

bindingsRef.current = {
  CACHE: cache,
  RATE_LIMITER: rateLimiter,
  IDEMPOTENCY_KEEPER: idempotencyKeeper,
  WEBHOOK_DISPATCHER: webhookDispatcher,
} as unknown as WorkerBindings;

/**
 * Publishes the bindings for the whole run. Called once, from the integration
 * suite's setup file.
 */
export function installWorkerBindings() {
  setAmbientWorkerBindings(bindingsRef.current);
}

/**
 * Throws away every cache entry, rate limit window, idempotency key and pending
 * webhook delivery. What `resetRedis`'s `flushdb` did, and it is called in the
 * same places.
 */
export function resetWorkerBindings() {
  cache.reset();
  rateLimiter.reset();
  idempotencyKeeper.reset();
  webhookDispatcher.reset();
}

/**
 * How many deliveries are queued on the webhook dispatchers, across every
 * `webhookId`.
 *
 * `WebhookQueueService.enqueueCall` hands a call to a Durable Object and
 * returns; the delivery itself happens on the object's alarm, which does not
 * fire here. So this counts what was handed over — the assertion the BullMQ
 * spy used to make.
 */
export async function pendingWebhookDeliveries(): Promise<number> {
  const depths = await Promise.all(
    webhookDispatcher.instances().map((object) => object.depth()),
  );

  return depths.reduce((total, depth) => total + depth, 0);
}
