import { randomUUID } from "crypto";
import { getChildLogger, withLogger } from "../logger/log";
import {
  currentTraceparent,
  startTrace,
  withTraceContext,
} from "../logger/trace-context";
import { bullmqDriver } from "./bullmq-driver";
import { workersDriver } from "./workers-driver";
import { isWorkersRuntime } from "../runtime";
import type {
  BulkJob,
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
 *
 * BullMQ on Node, and a Workers driver inside a Worker isolate, where BullMQ's
 * Redis sockets and blocking consumers cannot run at all.
 */
const driver = isWorkersRuntime() ? workersDriver : bullmqDriver;

/**
 * Trace context rides on the message body as a W3C `traceparent`.
 *
 * The queue is the one hop where the trace would otherwise be lost: the
 * producer's async context ends the moment the message is written, so the
 * consumer would start with nothing to correlate against. Carrying it in the
 * seam rather than at the call sites means every queue in the codebase gets it
 * for free, and the Cloudflare Queues driver inherits it — the field is just
 * another key on the message body, which any backend can carry.
 *
 * It is stripped again before the handler sees the job, so nothing downstream
 * has to know it was ever there (#18). Two places can still see it:
 *
 * - A message enqueued inside a trace carries one extra key. Nothing validates
 *   job payloads strictly and nothing derives identity from them — dedup is
 *   `options.jobId`, never the body — but a test that mocks the *driver* and
 *   asserts an exact payload will see the field if the enqueue ran inside a
 *   trace, and none do today only because they run outside one.
 * - Messages in flight across a deploy. Either direction is safe: an old
 *   message simply has no field to extract, and an old consumer ignores a key
 *   it does not destructure.
 */
const TRACEPARENT_FIELD = "__traceparent";

function injectTrace<T>(data: T): T {
  const traceparent = currentTraceparent();
  if (!traceparent || typeof data !== "object" || data === null) {
    return data;
  }
  return { ...(data as object), [TRACEPARENT_FIELD]: traceparent } as T;
}

function extractTrace<T>(data: T): {
  data: T;
  traceparent: string | undefined;
} {
  if (
    typeof data !== "object" ||
    data === null ||
    !(TRACEPARENT_FIELD in data)
  ) {
    return { data, traceparent: undefined };
  }
  const { [TRACEPARENT_FIELD]: traceparent, ...rest } = data as Record<
    string,
    unknown
  >;
  return {
    data: rest as T,
    traceparent: typeof traceparent === "string" ? traceparent : undefined,
  };
}

export function createQueue<T>(
  name: string,
  defaults?: EnqueueOptions,
): Queue<T> {
  const queue = driver.createQueue<T>(name, defaults);

  return {
    get name() {
      return queue.name;
    },
    enqueue: (jobName: string, data: T, options?: EnqueueOptions) =>
      queue.enqueue(jobName, injectTrace(data), options),
    enqueueBulk: (jobs: Array<BulkJob<T>>) =>
      queue.enqueueBulk(
        jobs.map((job) => ({ ...job, data: injectTrace(job.data) })),
      ),
    schedule: (id: string, spec: Parameters<Queue<T>["schedule"]>[1]) =>
      queue.schedule(id, spec),
    getJob: (id: string) => queue.getJob(id),
    getStats: () => queue.getStats(),
    close: () => queue.close(),
  };
}

export function createWorker<T>(
  name: string,
  handler: JobHandler<T>,
  options?: WorkerOptions<T>,
): Worker {
  return driver.createWorker<T>(
    name,
    async (job) => {
      const { data, traceparent } = extractTrace(job.data);
      return await withTraceContext(startTrace(traceparent), () =>
        handler(traceparent ? { ...job, data } : job),
      );
    },
    options,
  );
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
