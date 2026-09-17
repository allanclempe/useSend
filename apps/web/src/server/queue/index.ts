import { randomUUID } from "crypto";
import { getChildLogger, withLogger } from "../logger/log";
import { bullmqDriver } from "./bullmq-driver";
import type {
  EnqueueOptions,
  JobHandler,
  Queue,
  QueueJob,
  TeamJob,
  Worker,
  WorkerOptions,
} from "./types";

export * from "./types";
export * from "./queue-constants";

/**
 * The active queue backend. Swapping this for a Cloudflare Queues driver is the
 * whole point of the seam — see references/serverless-migration.md.
 */
const driver = bullmqDriver;

export function createQueue<T>(
  name: string,
  defaults?: EnqueueOptions,
): Queue<T> {
  return driver.createQueue<T>(name, defaults);
}

export function createWorker<T>(
  name: string,
  handler: JobHandler<T>,
  options?: WorkerOptions<T>,
): Worker {
  return driver.createWorker<T>(name, handler, options);
}

/**
 * Wraps a job handler so every log line inside it carries team and job context.
 */
export function createWorkerHandler<T>(
  // eslint-disable-next-line no-unused-vars -- parameter name in a type signature
  handler: (job: TeamJob<T>) => Promise<void>,
): JobHandler<T & { teamId?: number }> {
  return async (job: QueueJob<T & { teamId?: number }>) => {
    return await withLogger(
      getChildLogger({
        teamId: job.data.teamId,
        queueId: job.id ?? randomUUID(),
      }),
      async () => {
        return await handler(job);
      },
    );
  };
}
