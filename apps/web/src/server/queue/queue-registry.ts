/**
 * Every Cloudflare Queue this Worker produces to or consumes from.
 *
 * Cloudflare Queues are **deploy-time configuration**: a queue and its consumer
 * are declared in `wrangler.jsonc` and bound to the Worker by name, and a
 * binding that was not declared simply is not on `env` at runtime. There is no
 * `createQueue` on Cloudflare — §4.1 of references/serverless-migration.md.
 *
 * That makes drift between this file and `wrangler.jsonc` a runtime failure on
 * a send path, which is the worst place to discover it. So this module is the
 * single source of truth, `queue-registry.unit.test.ts` asserts `wrangler.jsonc`
 * agrees with it, and the driver resolves bindings through `bindingNameFor` rather
 * than spelling binding names at call sites.
 *
 * Not every BullMQ queue appears here. Four are pure schedules and become Cron
 * Triggers with no queue at all (`CRON_ONLY_QUEUES`), and two collapse into
 * Durable Objects (§3). A queue is in this table only if messages actually flow
 * through it.
 */

import { CRON_TRIGGERS } from "./cron-registry";
import {
  CAMPAIGN_BATCH_QUEUE,
  CAMPAIGN_SCHEDULER_QUEUE,
  CONTACT_BULK_ADD_QUEUE,
  SES_WEBHOOK_QUEUE,
  WEBHOOK_DISPATCH_QUEUE,
} from "./queue-constants";
import {
  SEND_QUEUE_MAX_ATTEMPTS,
  SEND_QUEUE_MAX_CONCURRENCY,
  SEND_QUEUE_SUFFIXES,
  sendQueueName,
  SUPPORTED_SES_REGIONS,
} from "./ses-regions";

/**
 * Not a queue on Cloudflare at all: `webhook-dispatch` becomes one Durable
 * Object per `webhookId` (§3), because what it needs is ordering and a queue
 * cannot give it. Named here so a missing binding says that rather than
 * "unknown queue". BullMQ still uses the name under Node.
 */
const DURABLE_OBJECT_QUEUES: Record<string, string> = {
  [WEBHOOK_DISPATCH_QUEUE]: "the WEBHOOK_DISPATCHER Durable Object",
};

export type QueueDefinition = {
  /** The name `createQueue`/`createWorker` use — unchanged from BullMQ. */
  readonly name: string;
  /** The queue's name in the Cloudflare account, and in `wrangler.jsonc`. */
  readonly queueName: string;
  /** The producer binding on `env`. */
  readonly binding: string;
  /**
   * Total deliveries, first attempt included — BullMQ's `attempts`, not
   * Cloudflare's `max_retries`, which counts only the retries. The one place
   * that conversion happens is `maxRetriesFor`, because an off-by-one here is
   * invisible until a message dies one attempt early.
   */
  readonly maxAttempts: number;
  /** How long to wait before redelivering a failed message. */
  readonly retry: { readonly type: "exponential" | "fixed"; readonly delayMs: number };
  /** Messages handed to `queue()` in one invocation. Hard cap 100. */
  readonly maxBatchSize: number;
  /** Seconds the queue waits to fill a batch before delivering a short one. */
  readonly maxBatchTimeout: number;
  /**
   * Consumer invocations in flight. `null` lets Cloudflare autoscale, which is
   * right for everything except the SES-quota-bound send queues (§4.1).
   */
  readonly maxConcurrency: number | null;
};

/**
 * Queue names are account-scoped, so they carry the product name; binding names
 * are `env` keys and carry a `QUEUE_` prefix so a binding lookup can never
 * collide with `HYPERDRIVE`, `STORAGE` or `CACHE`.
 */
export function queueNameFor(name: string): string {
  return `usesend-${name}`;
}

export function bindingNameFor(name: string): string {
  return `QUEUE_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

function define(
  name: string,
  options: Omit<QueueDefinition, "name" | "queueName" | "binding">,
): QueueDefinition {
  return {
    name,
    queueName: queueNameFor(name),
    binding: bindingNameFor(name),
    ...options,
  };
}

/**
 * One dead letter queue for everything.
 *
 * Per-queue DLQs would be eight more queues to declare, eight more consumers to
 * write and eight places to look when something fails; the message itself
 * records which queue it came from. `queue-consumer.ts` consumes this one and
 * logs each message at error severity, which is the alerting path §11 settled
 * on — Workers Logs, not an OTLP exporter in the request path.
 */
export const DEAD_LETTER_QUEUE_NAME = queueNameFor("dead-letter");

/**
 * The send queues, one pair per supported SES region.
 *
 * Derived rather than written out because the set is data, and because the
 * whole of §4.1 is that this list is fixed at deploy time: a region a user adds
 * in the admin UI that is not in `SUPPORTED_SES_REGIONS` has no queue, no
 * consumer and no binding, and sending from it fails at the seam with a message
 * that says so.
 *
 * `maxBatchSize` is 1. A send renders, builds MIME and calls SES, so two in one
 * invocation would share a 30s CPU budget and a 1000-subrequest cap — and
 * batching buys nothing here anyway, since each message is one SES call.
 */
const SEND_QUEUES: readonly QueueDefinition[] = SUPPORTED_SES_REGIONS.flatMap(
  (region) =>
    SEND_QUEUE_SUFFIXES.map((suffix) =>
      define(sendQueueName(region, suffix), {
        maxAttempts: SEND_QUEUE_MAX_ATTEMPTS,
        retry: { type: "exponential", delayMs: 30_000 },
        maxBatchSize: 1,
        maxBatchTimeout: 1,
        maxConcurrency: SEND_QUEUE_MAX_CONCURRENCY,
      }),
    ),
);

export const QUEUES: readonly QueueDefinition[] = [
  /**
   * The SES event pipeline — 78% of all queue load in §12, and the reason the
   * batch settings here are the largest in the table. A full batch is one
   * multi-row INSERT rather than 100 round trips to Neon.
   */
  define(SES_WEBHOOK_QUEUE, {
    maxAttempts: 5,
    retry: { type: "exponential", delayMs: 5_000 },
    maxBatchSize: 100,
    maxBatchTimeout: 5,
    maxConcurrency: null,
  }),
  /**
   * One message per contact today. The batch is small because each message does
   * its own upsert; the page-and-continue work in §4.3 changes what a message
   * means here, not how many arrive at once.
   */
  define(CONTACT_BULK_ADD_QUEUE, {
    maxAttempts: 3,
    retry: { type: "exponential", delayMs: 10_000 },
    maxBatchSize: 25,
    maxBatchTimeout: 2,
    maxConcurrency: null,
  }),
  /**
   * Campaign fan-out. `maxBatchSize` is 1 deliberately: a batch message renders
   * up to `batchSize` emails, and two of those in one invocation would share a
   * 30s CPU budget and a 1000-subrequest cap (§4.3, §12).
   */
  define(CAMPAIGN_BATCH_QUEUE, {
    maxAttempts: 3,
    retry: { type: "exponential", delayMs: 30_000 },
    maxBatchSize: 1,
    maxBatchTimeout: 1,
    maxConcurrency: null,
  }),
  /**
   * The campaign scheduler's tick. The Durable Object alarm sends here and a
   * consumer does the sweep, because the alarm must not hold a database
   * connection (§4.2).
   *
   * One attempt, no retry: the next tick is 30 seconds away and is a better
   * retry than redelivering a stale one. `maxConcurrency` is 1 for the same
   * reason the BullMQ worker ran at concurrency 1 — two sweeps at once would
   * queue every campaign batch twice.
   */
  define(CAMPAIGN_SCHEDULER_QUEUE, {
    maxAttempts: 1,
    retry: { type: "fixed", delayMs: 0 },
    maxBatchSize: 1,
    maxBatchTimeout: 1,
    maxConcurrency: 1,
  }),
  ...SEND_QUEUES,
];

const byName = new Map(QUEUES.map((queue) => [queue.name, queue]));
const byQueueName = new Map(QUEUES.map((queue) => [queue.queueName, queue]));

export function queueDefinition(name: string): QueueDefinition | undefined {
  return byName.get(name);
}

/** Reverse lookup for the consumer: `MessageBatch.queue` is the CF name. */
export function queueDefinitionByQueueName(
  queueName: string,
): QueueDefinition | undefined {
  return byQueueName.get(queueName);
}

/**
 * Queues that exist in the BullMQ world as a scheduling mechanism only — they
 * carry one recurring job and never a real message. On Cloudflare they are Cron
 * Triggers and have no queue, so asking for a producer binding for one is a
 * mistake worth naming rather than a missing-binding error to puzzle over.
 */
export const CRON_ONLY_QUEUES: readonly string[] = Object.keys(CRON_TRIGGERS);

/** Where a name that is not a queue actually went, for the error message. */
export function nonQueueDestination(name: string): string | undefined {
  if (CRON_ONLY_QUEUES.includes(name)) {
    return "a Cron Trigger on Cloudflare, not a queue; it carries a schedule, never a message";
  }
  return DURABLE_OBJECT_QUEUES[name];
}

/** Cloudflare counts retries, not attempts. Convert in exactly one place. */
export function maxRetriesFor(queue: QueueDefinition): number {
  return queue.maxAttempts - 1;
}

/**
 * How long to hold a failed message before redelivering it.
 *
 * `attemptsMade` is 0 on the first delivery, so the first retry waits
 * `delayMs`, matching BullMQ's exponential strategy. Cloudflare's own
 * `retry_delay` is a flat per-consumer number, so this is applied per message
 * at `retry()` time instead — the only way to get a growing backoff.
 */
export function retryDelaySeconds(
  queue: QueueDefinition,
  attemptsMade: number,
): number {
  const delayMs =
    queue.retry.type === "fixed"
      ? queue.retry.delayMs
      : queue.retry.delayMs * 2 ** Math.max(0, attemptsMade);

  // Queues cap a per-message delay at 12 hours, same as `delaySeconds` on send.
  return Math.min(Math.ceil(delayMs / 1000), MAX_DELAY_SECONDS);
}

/** Cloudflare Queues limits, quoted here so the driver reads as prose. */
export const MAX_DELAY_SECONDS = 43_200; // 12 hours
export const MAX_MESSAGE_BYTES = 128 * 1024;
export const MAX_BATCH_MESSAGES = 100;
export const MAX_BATCH_BYTES = 256 * 1024;
