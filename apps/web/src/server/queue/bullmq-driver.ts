import {
  Job,
  Queue as BullQueue,
  Worker as BullWorker,
  type JobsOptions,
} from "bullmq";
import { getRedis, BULL_PREFIX } from "../redis";
import { DEFAULT_QUEUE_OPTIONS } from "./queue-constants";
import type {
  BulkJob,
  EnqueueOptions,
  EnqueuedJob,
  JobHandler,
  Queue,
  QueueDriver,
  QueueJob,
  QueueStats,
  ScheduleSpec,
  Worker,
  WorkerOptions,
} from "./types";

/** BullMQ's `Job` narrowed to the driver-agnostic shape handlers receive. */
function toQueueJob<T>(job: Job<T>): QueueJob<T> {
  return {
    id: job.id,
    name: job.name,
    data: job.data,
    attemptsMade: job.attemptsMade,
  };
}

function toJobsOptions(options?: EnqueueOptions): JobsOptions {
  return {
    // Retention is a driver concern, not something call sites should specify.
    ...DEFAULT_QUEUE_OPTIONS,
    ...(options?.jobId !== undefined ? { jobId: options.jobId } : {}),
    ...(options?.delay !== undefined ? { delay: options.delay } : {}),
    ...(options?.attempts !== undefined ? { attempts: options.attempts } : {}),
    ...(options?.backoff !== undefined ? { backoff: options.backoff } : {}),
  };
}

class BullMQQueue<T> implements Queue<T> {
  private readonly queue: BullQueue<T, unknown, string, T, unknown, string>;

  constructor(
    public readonly name: string,
    private readonly defaults?: EnqueueOptions,
  ) {
    this.queue = new BullQueue<T, unknown, string, T, unknown, string>(name, {
      connection: getRedis(),
      prefix: BULL_PREFIX,
      skipVersionCheck: true,
      defaultJobOptions: toJobsOptions(defaults),
    });
  }

  private opts(options?: EnqueueOptions): JobsOptions {
    return toJobsOptions({ ...this.defaults, ...options });
  }

  async enqueue(name: string, data: T, options?: EnqueueOptions) {
    await this.queue.add(name, data, this.opts(options));
  }

  async enqueueBulk(jobs: Array<BulkJob<T>>) {
    if (jobs.length === 0) {
      return;
    }
    await this.queue.addBulk(
      jobs.map((job) => ({
        name: job.name,
        data: job.data,
        opts: this.opts(job.options),
      })),
    );
  }

  async schedule(id: string, spec: ScheduleSpec) {
    const repeat =
      "cron" in spec ? { pattern: spec.cron, tz: spec.tz } : { every: spec.every };

    await this.queue.upsertJobScheduler(id, repeat, {
      opts: toJobsOptions(this.defaults),
    });
  }

  async getJob(id: string): Promise<EnqueuedJob | undefined> {
    const job = await this.queue.getJob(id);
    if (!job) {
      return undefined;
    }

    return {
      id: job.id,
      delay: job.delay,
      changeDelay: (delayMs: number) => job.changeDelay(delayMs),
      remove: async () => {
        await job.remove();
      },
    };
  }

  async getStats(): Promise<QueueStats> {
    const counts = await this.queue.getJobCounts(
      "waiting",
      "active",
      "completed",
      "failed",
    );

    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
    };
  }

  async close() {
    await this.queue.close();
  }
}

class BullMQWorker<T> implements Worker {
  private readonly worker: BullWorker<T>;

  constructor(name: string, handler: JobHandler<T>, options?: WorkerOptions<T>) {
    this.worker = new BullWorker<T>(
      name,
      async (job: Job<T>) => {
        await handler(toQueueJob(job));
      },
      {
        connection: getRedis(),
        prefix: BULL_PREFIX,
        skipVersionCheck: true,
        ...(options?.concurrency !== undefined
          ? { concurrency: options.concurrency }
          : {}),
      },
    );

    const { onCompleted, onFailed, onError } = options ?? {};

    if (onCompleted) {
      this.worker.on("completed", (job) => onCompleted(toQueueJob(job)));
    }
    if (onFailed) {
      this.worker.on("failed", (job, error) =>
        onFailed(job ? toQueueJob(job) : undefined, error),
      );
    }
    if (onError) {
      this.worker.on("error", onError);
    }
  }

  get concurrency() {
    return this.worker.concurrency;
  }

  set concurrency(value: number) {
    this.worker.concurrency = value;
  }

  async close() {
    await this.worker.close();
  }
}

export const bullmqDriver: QueueDriver = {
  createQueue: (name, defaults) => new BullMQQueue(name, defaults),
  createWorker: (name, handler, options) =>
    new BullMQWorker(name, handler, options),
};
