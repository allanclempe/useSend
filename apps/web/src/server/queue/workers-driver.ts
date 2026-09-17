/* eslint-disable no-unused-vars -- parameter names in the QueueDriver signature */

import { logger } from "../logger/log";
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
 * This driver makes the module graph loadable. Producing is not wired up yet —
 * Cloudflare Queue bindings arrive with Phase 8 (§9) — so `enqueue` fails loudly
 * rather than dropping a job on the floor. Read paths, which is everything the
 * public API does that does not send, work unchanged.
 */

function notWiredYet(queueName: string, operation: string): Error {
  return new Error(
    `Queue "${queueName}": ${operation} is not available in the Worker runtime yet. ` +
      `Cloudflare Queue bindings land in Phase 8 — see references/serverless-migration.md §2.`,
  );
}

class WorkersQueue<T> implements Queue<T> {
  constructor(public readonly name: string) {}

  async enqueue(): Promise<void> {
    throw notWiredYet(this.name, "enqueue");
  }

  async enqueueBulk(jobs: Array<BulkJob<T>>): Promise<void> {
    if (jobs.length === 0) {
      return;
    }
    throw notWiredYet(this.name, "enqueueBulk");
  }

  async schedule(_id: string, _spec: ScheduleSpec): Promise<void> {
    throw notWiredYet(this.name, "schedule");
  }

  async getJob(_id: string): Promise<EnqueuedJob | undefined> {
    // Cloudflare Queues has no equivalent and never will: a queued message
    // cannot be looked up, moved or withdrawn. §4.5 replaces the two callers
    // with plain database writes.
    return undefined;
  }

  async getStats(): Promise<QueueStats> {
    return { waiting: 0, active: 0, completed: 0, failed: 0 };
  }

  async close(): Promise<void> {}
}

/**
 * Consumers are not started by importing a module in the Worker runtime. A
 * Cloudflare Queues consumer is a `queue()` export on a Worker, declared in
 * `wrangler.jsonc`, not a constructor side effect.
 */
class WorkersWorker implements Worker {
  concurrency = 0;

  constructor(name: string) {
    logger.debug(
      { queue: name },
      "Queue consumer not started: the Worker runtime declares consumers in wrangler.jsonc",
    );
  }

  async close(): Promise<void> {}
}

export const workersDriver: QueueDriver = {
  createQueue: <T>(name: string, _defaults?: EnqueueOptions): Queue<T> =>
    new WorkersQueue<T>(name),
  createWorker: <T>(
    name: string,
    _handler: JobHandler<T>,
    _options?: WorkerOptions<T>,
  ): Worker => new WorkersWorker(name),
};
