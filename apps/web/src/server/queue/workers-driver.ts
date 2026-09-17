/* eslint-disable no-unused-vars -- parameter names in the QueueDriver signature */

import { logger } from "../logger/log";
import { getWorkerBindings, type QueueProducer } from "../worker-bindings";
import { isDeclaredCron } from "./cron-registry";
import {
  nonQueueDestination,
  MAX_BATCH_BYTES,
  MAX_BATCH_MESSAGES,
  MAX_DELAY_SECONDS,
  MAX_MESSAGE_BYTES,
  queueDefinition,
  type QueueDefinition,
} from "./queue-registry";
import type {
  BulkJob,
  EnqueueOptions,
  EnqueuedJob,
  JobHandler,
  Queue,
  QueueDriver,
  QueueStats,
  ScheduleSpec,
  Worker,
  WorkerOptions,
} from "./types";

/**
 * The queue driver used inside a Cloudflare Worker.
 *
 * BullMQ cannot run here: its queues open a Redis socket in their constructor
 * and its workers hold a blocking connection open for the lifetime of the
 * process. Several service modules build both in `static` class fields, so
 * merely importing `campaign-service.ts` inside a Worker is enough to crash the
 * isolate at load time with "Disallowed operation called within global scope".
 *
 * Producing goes to a real Cloudflare Queue binding, resolved by name through
 * `queue-registry.ts`. Consuming does not happen here at all: a Cloudflare
 * consumer is a `queue()` export on the Worker, so `createWorker` *registers* a
 * handler that `src/worker/queue-consumer.ts` dispatches to, rather than
 * starting anything. Both halves of a BullMQ call site therefore keep working
 * unchanged — `createQueue(...).enqueue(...)` sends, `createWorker(name, fn)`
 * declares what runs.
 *
 * See references/serverless-migration.md §2 and §4.
 */

/** What actually goes on the wire. `data` is the payload call sites pass. */
export type QueueMessage<T> = {
  /** BullMQ's job name. Carried so handlers that branch on it still can. */
  name: string;
  /**
   * The logical queue this was sent to.
   *
   * Redundant on the way in — the consumer already has `batch.queue` — and
   * load-bearing on the way out: a message sitting in the shared dead letter
   * queue has lost every trace of where it came from, and this is the only
   * thing that makes one triageable. A couple of dozen bytes against 128 KB.
   */
  queue: string;
  data: T;
};

/**
 * Handlers registered by `createWorker`, keyed by logical queue name.
 *
 * Module-level state, which is safe here in a way a connection is not: this is
 * a plain Map of functions, built during module evaluation and never touched by
 * I/O, so it is not tied to the request that created it.
 */
const handlers = new Map<string, JobHandler<never>>();

export function registeredHandler(
  queueName: string,
): JobHandler<never> | undefined {
  return handlers.get(queueName);
}

export function registeredQueueNames(): string[] {
  return [...handlers.keys()];
}

function missingBinding(queue: QueueDefinition): Error {
  return new Error(
    `Queue "${queue.name}": binding ${queue.binding} is not on env. ` +
      `Declare a producer for "${queue.queueName}" in apps/web/wrangler.jsonc — ` +
      `Cloudflare Queues are deploy-time config, see references/serverless-migration.md §4.1.`,
  );
}

function notAQueue(name: string): Error {
  const destination = nonQueueDestination(name);
  const hint = destination
    ? ` "${name}" is ${destination}.`
    : ` Add it to server/queue/queue-registry.ts and to wrangler.jsonc.`;

  return new Error(`Queue "${name}" is not in the queue registry.${hint}`);
}

function resolve(name: string): {
  definition: QueueDefinition;
  producer: QueueProducer;
} {
  const definition = queueDefinition(name);
  if (!definition) {
    throw notAQueue(name);
  }

  const bindings = getWorkerBindings();
  const producer = bindings?.[definition.binding] as QueueProducer | undefined;
  if (!producer || typeof producer.send !== "function") {
    throw missingBinding(definition);
  }

  return { definition, producer };
}

/**
 * Cloudflare rejects a message over 128 KB, and it does so at send time with a
 * message that names neither the queue nor the payload. Failing here instead
 * keeps §4.4's rule enforceable: message bodies are ID references, never email
 * bodies or attachments.
 */
function encoded(queueName: string, message: QueueMessage<unknown>): {
  body: QueueMessage<unknown>;
  bytes: number;
} {
  const bytes = new TextEncoder().encode(JSON.stringify(message)).length;

  if (bytes > MAX_MESSAGE_BYTES) {
    throw new Error(
      `Queue "${queueName}": message is ${bytes} bytes, over Cloudflare's ${MAX_MESSAGE_BYTES} byte limit. ` +
        `Queue payloads are ID references — store the body and pass its id (§4.4).`,
    );
  }

  return { body: message, bytes };
}

/**
 * `delay` is milliseconds at the seam because BullMQ's is; Cloudflare's is
 * whole seconds. Rounding up rather than down so a sub-second delay is still a
 * delay, and refusing anything past 12 hours rather than silently clamping it —
 * a scheduled send that far out belongs on the §4.5 sweeper, not on a queue.
 */
function delaySecondsFor(
  queueName: string,
  delayMs: number | undefined,
): number | undefined {
  if (delayMs === undefined || delayMs <= 0) {
    return undefined;
  }

  const seconds = Math.ceil(delayMs / 1000);
  if (seconds > MAX_DELAY_SECONDS) {
    throw new Error(
      `Queue "${queueName}": a ${seconds}s delay is past Cloudflare's ${MAX_DELAY_SECONDS}s (12 hour) maximum. ` +
        `Anything further out is a database row the scheduler sweeps, not a delayed message (§4.5).`,
    );
  }

  return seconds;
}

class WorkersQueue<T> implements Queue<T> {
  constructor(public readonly name: string) {}

  /**
   * `options.jobId` is dropped, and that is a real behaviour change rather than
   * an omission. It is BullMQ's dedup key — enqueueing the same id twice while
   * the job still exists is a no-op — and Cloudflare Queues has no equivalent
   * at all. AGENTS.md already says not to build on it for that reason. Until
   * §4.4 puts an idempotency guard in each handler, a duplicate enqueue on this
   * driver is a duplicate delivery.
   */
  async enqueue(name: string, data: T, options?: EnqueueOptions): Promise<void> {
    const { definition, producer } = resolve(this.name);
    const { body } = encoded(this.name, { name, queue: this.name, data });
    const delaySeconds = delaySecondsFor(this.name, options?.delay);

    await producer.send(body, {
      contentType: "json",
      ...(delaySeconds !== undefined ? { delaySeconds } : {}),
    });

    logger.debug(
      { queue: definition.queueName, jobName: name },
      "Enqueued message",
    );
  }

  async enqueueBulk(jobs: Array<BulkJob<T>>): Promise<void> {
    if (jobs.length === 0) {
      return;
    }

    const { definition, producer } = resolve(this.name);

    const messages = jobs.map((job) => {
      const { body, bytes } = encoded(this.name, {
        name: job.name,
        queue: this.name,
        data: job.data,
      });
      const delaySeconds = delaySecondsFor(this.name, job.options?.delay);

      return {
        bytes,
        message: {
          body,
          ...(delaySeconds !== undefined ? { delaySeconds } : {}),
        },
      };
    });

    // `sendBatch` caps at 100 messages and 256 KB per call. Splitting here
    // rather than at the call sites is the point of the seam: `queueBulk`
    // hands over a whole campaign batch and should not have to know either
    // number.
    let batch: Array<(typeof messages)[number]["message"]> = [];
    let batchBytes = 0;

    const flush = async () => {
      if (batch.length > 0) {
        await producer.sendBatch(batch);
        batch = [];
        batchBytes = 0;
      }
    };

    for (const { message, bytes } of messages) {
      if (
        batch.length >= MAX_BATCH_MESSAGES ||
        batchBytes + bytes > MAX_BATCH_BYTES
      ) {
        await flush();
      }
      batch.push(message);
      batchBytes += bytes;
    }

    await flush();

    logger.debug(
      { queue: definition.queueName, count: jobs.length },
      "Enqueued messages in bulk",
    );
  }

  /**
   * Cron Triggers are declared in `wrangler.jsonc`, so there is nothing to
   * create here. What is left is worth doing: check that the expression is one
   * the deployment actually declares.
   *
   * A cron nobody declared never fires, and the failure is invisible — a
   * cleanup job simply stops running and nothing says so for a month. Throwing
   * at registration surfaces it at isolate startup instead, which is loud and
   * immediate. `cron-registry.ts` is what the job modules read their expression
   * from, so in practice this can only fail if the two registries drift.
   */
  async schedule(id: string, spec: ScheduleSpec): Promise<void> {
    if (!("cron" in spec)) {
      throw new Error(
        `Queue "${this.name}": schedule "${id}" is an interval, and Cron Triggers ` +
          `floor at one minute. Sub-minute ticks are Durable Object alarms (§4.2).`,
      );
    }

    if (!isDeclaredCron(spec.cron)) {
      throw new Error(
        `Queue "${this.name}": schedule "${id}" uses cron "${spec.cron}", which is not ` +
          `in server/queue/cron-registry.ts and so is not a Cron Trigger in wrangler.jsonc. ` +
          `It would never fire.`,
      );
    }
  }

  async getJob(_id: string): Promise<EnqueuedJob | undefined> {
    // Cloudflare Queues has no equivalent and never will: a queued message
    // cannot be looked up, moved or withdrawn. §4.5 replaces the two callers
    // with plain database writes.
    return undefined;
  }

  async getStats(): Promise<QueueStats> {
    // Queue depth is a GraphQL Analytics API query against an account, not
    // something a Worker can read from a binding. The one caller is a contact
    // import progress readout.
    return { waiting: 0, active: 0, completed: 0, failed: 0 };
  }

  async close(): Promise<void> {}
}

/**
 * Registers a consumer handler. Nothing is started: a Cloudflare Queues
 * consumer is the `queue()` export on the Worker, declared in `wrangler.jsonc`,
 * and `src/worker/queue-consumer.ts` looks handlers up here by queue name.
 */
class WorkersWorker implements Worker {
  /**
   * `max_concurrency` is deploy-time config on the consumer (§4.1, decision 1),
   * so the setter is deliberately inert. It stays writable because
   * `EmailQueueService.initializeQueue` retunes it when an SES quota changes,
   * and that call is not worth branching on the runtime for — but it now does
   * nothing until a deploy, which is the decision that was made.
   */
  concurrency = 0;

  constructor(
    name: string,
    handler: JobHandler<never>,
    private readonly options?: WorkerOptions<never>,
  ) {
    handlers.set(name, handler);
    this.concurrency = options?.concurrency ?? 0;
  }

  events() {
    return this.options;
  }

  async close(): Promise<void> {}
}

const workers = new Map<string, WorkersWorker>();

/** The `onCompleted` / `onFailed` callbacks a call site passed to `createWorker`. */
export function registeredWorkerEvents(
  queueName: string,
): WorkerOptions<never> | undefined {
  return workers.get(queueName)?.events();
}

export const workersDriver: QueueDriver = {
  createQueue: <T>(name: string, _defaults?: EnqueueOptions): Queue<T> =>
    new WorkersQueue<T>(name),
  createWorker: <T>(
    name: string,
    handler: JobHandler<T>,
    options?: WorkerOptions<T>,
  ): Worker => {
    const worker = new WorkersWorker(
      name,
      handler as JobHandler<never>,
      options as WorkerOptions<never>,
    );
    workers.set(name, worker);
    return worker;
  },
};
