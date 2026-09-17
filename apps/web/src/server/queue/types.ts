/**
 * Driver-agnostic queue interface.
 *
 * Nothing outside `server/queue/` should import from `bullmq`. The surface here
 * is deliberately the intersection of what this codebase actually uses and what
 * Cloudflare Queues can provide, so the BullMQ driver can be swapped out without
 * touching call sites.
 */

/* eslint-disable no-unused-vars -- parameter names in type signatures */

/** A job as a handler sees it. */
export type QueueJob<T> = {
  readonly id?: string;
  readonly name: string;
  readonly data: T;
  /** Number of attempts already made; 0 on the first run. */
  readonly attemptsMade: number;
};

/** Most jobs in this codebase carry a team for logging context. */
export type TeamJob<T> = QueueJob<T & { teamId?: number }>;

export type BackoffStrategy = {
  type: "exponential" | "fixed";
  delay: number;
};

export type EnqueueOptions = {
  /**
   * Dedup key. Enqueueing again with the same id while the job still exists is
   * a no-op — this is what makes `emailId` usable as a job identity.
   */
  jobId?: string;
  /** Milliseconds before the job becomes available to a consumer. */
  delay?: number;
  attempts?: number;
  backoff?: BackoffStrategy;
};

/** Cron expression, or a fixed interval in milliseconds. */
export type ScheduleSpec = { cron: string; tz?: string } | { every: number };

/** Handle to a job that has already been enqueued. */
export type EnqueuedJob = {
  readonly id?: string;
  readonly delay: number;
  changeDelay(delayMs: number): Promise<void>;
  remove(): Promise<void>;
};

export type QueueStats = {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
};

export type BulkJob<T> = {
  name: string;
  data: T;
  options?: EnqueueOptions;
};

export interface Queue<T> {
  readonly name: string;
  enqueue(name: string, data: T, options?: EnqueueOptions): Promise<void>;
  enqueueBulk(jobs: Array<BulkJob<T>>): Promise<void>;
  /** Register (or update) a recurring job. Idempotent per `id`. */
  schedule(id: string, spec: ScheduleSpec): Promise<void>;
  getJob(id: string): Promise<EnqueuedJob | undefined>;
  getStats(): Promise<QueueStats>;
  close(): Promise<void>;
}

export type WorkerEvents<T> = {
  onCompleted?: (job: QueueJob<T>) => void;
  onFailed?: (job: QueueJob<T> | undefined, error: Error) => void;
  onError?: (error: Error) => void;
};

export type WorkerOptions<T> = WorkerEvents<T> & {
  concurrency?: number;
};

export interface Worker {
  /** Mutable: SES quota changes retune this at runtime. */
  concurrency: number;
  close(): Promise<void>;
}

export type JobHandler<T> = (job: QueueJob<T>) => Promise<void>;

/**
 * A queue backend. One implementation today (BullMQ); Cloudflare Queues will be
 * the second.
 */
export interface QueueDriver {
  createQueue<T>(name: string, defaults?: EnqueueOptions): Queue<T>;
  createWorker<T>(
    name: string,
    handler: JobHandler<T>,
    options?: WorkerOptions<T>,
  ): Worker;
}
