/* eslint-disable no-unused-vars -- parameter names in type signatures */

import type { Message, MessageBatch } from "@cloudflare/workers-types";
import { createDrizzleClient, withDrizzleClient } from "~/server/drizzle";
import { logger } from "~/server/logger/log";
import {
  DEAD_LETTER_QUEUE_NAME,
  queueDefinitionByQueueName,
  retryDelaySeconds,
  type QueueDefinition,
} from "~/server/queue/queue-registry";
import {
  registeredHandler,
  registeredWorkerEvents,
  type QueueMessage,
} from "~/server/queue/workers-driver";
import { withWorkerBindings, type WorkerBindings } from "~/server/worker-bindings";

/**
 * These imports are the consumer registration.
 *
 * On BullMQ a consumer starts because a module was imported and its `static`
 * field ran `createWorker`. That is still true here — the Workers driver turns
 * `createWorker` into a registration in a Map — but the Worker entry point only
 * imports the Hono app, so nothing else would pull these in. Importing them
 * here is what puts a handler behind each declared consumer, and a queue whose
 * module is missing from this list fails loudly on its first message rather
 * than quietly dropping it.
 */
import "~/server/jobs/campaign-scheduler-job";
import "~/server/service/campaign-service";
import "~/server/service/contact-queue-service";
import "~/server/service/ses-hook-parser";
// `webhook-service` is deliberately absent: on Workers webhook delivery is the
// WEBHOOK_DISPATCHER Durable Object, not a queue, and it registers no consumer.

/**
 * The `queue()` export: one handler for every consumer this Worker declares.
 *
 * Cloudflare gives a Worker a single `queue()` entry point and identifies the
 * source queue on the batch, so dispatch is ours to do. `queue-registry.ts`
 * maps the Cloudflare queue name back to the logical name the codebase uses,
 * and the driver holds the handler that `createWorker` registered for it.
 *
 * See references/serverless-migration.md §2 and §4.4.
 */
export async function handleQueueBatch(
  batch: MessageBatch<unknown>,
  env: WorkerBindings,
  // Structural, not `ExecutionContext`: Hono and `@cloudflare/workers-types`
  // each declare one and they are not assignable to each other. `waitUntil` is
  // the only thing this needs from either.
  ctx: { waitUntil: (promise: Promise<unknown>) => void },
): Promise<void> {
  if (batch.queue === DEAD_LETTER_QUEUE_NAME) {
    reportDeadLetters(batch);
    return;
  }

  const definition = queueDefinitionByQueueName(batch.queue);
  const handler = definition ? registeredHandler(definition.name) : undefined;

  if (!definition || !handler) {
    // Retrying buys time to ship the missing handler instead of burning the
    // message's attempts against a consumer that cannot possibly succeed.
    batch.retryAll();
    logger.error(
      { queue: batch.queue, count: batch.messages.length },
      "No handler registered for queue; messages retried",
    );
    return;
  }

  // Per invocation, not per isolate — the same rule as `fetch`. A queue
  // invocation is a request as far as Workers' I/O ownership is concerned, so
  // a connection cached across invocations fails on the second one.
  const { db, close } = createDrizzleClient(env.HYPERDRIVE.connectionString, 1);

  try {
    await withWorkerBindings(env, () =>
      withDrizzleClient(db, async () => {
        // Concurrently, not in sequence: a full SES batch is 100 messages and
        // running them one after another would spend the whole 30s budget
        // waiting on Neon. `postgres-js` serialises the queries onto the one
        // connection anyway, so this bounds latency without multiplying
        // connections. `allSettled` because each message acks or retries on its
        // own — one poisoned message must not retry the other 99.
        await Promise.allSettled(
          batch.messages.map((message) =>
            handleMessage(definition, handler, message),
          ),
        );
      }),
    );
  } finally {
    ctx.waitUntil(close());
  }
}

async function handleMessage(
  definition: QueueDefinition,
  handler: (job: never) => Promise<void>,
  message: Message<unknown>,
): Promise<void> {
  const envelope = message.body as QueueMessage<unknown>;
  // `attempts` counts deliveries and is 1 the first time; BullMQ's
  // `attemptsMade` counts prior attempts and is 0. Handlers read the latter.
  const attemptsMade = Math.max(0, (message.attempts ?? 1) - 1);

  const job = {
    id: message.id,
    name: envelope?.name ?? definition.name,
    data: envelope?.data,
    attemptsMade,
  };

  const events = registeredWorkerEvents(definition.name);

  try {
    await handler(job as never);
    message.ack();
    events?.onCompleted?.(job as never);
  } catch (error) {
    // Cloudflare moves a message to the dead letter queue once it has been
    // retried `max_retries` times, so there is deliberately no attempt cap
    // here — capping it locally would ack a failure and lose the message.
    message.retry({ delaySeconds: retryDelaySeconds(definition, attemptsMade) });

    logger.error(
      {
        err: error,
        queue: definition.queueName,
        messageId: message.id,
        attemptsMade,
      },
      "Queue message failed; retrying",
    );

    events?.onFailed?.(
      job as never,
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/**
 * The dead letter queue's consumer.
 *
 * A message arrives here only after its own queue exhausted `max_retries`, so
 * there is nothing left to try — the job is to make sure it is visible. One
 * error record per message is the alerting path §11 settled on: Workers Logs
 * ingests and indexes these, and an alert is a query over them.
 *
 * Acked, not retried. A DLQ that retries is a queue.
 */
function reportDeadLetters(batch: MessageBatch<unknown>): void {
  for (const message of batch.messages) {
    const envelope = message.body as QueueMessage<unknown>;

    logger.error(
      {
        messageId: message.id,
        queue: envelope?.queue,
        jobName: envelope?.name,
        attempts: message.attempts,
        timestamp: message.timestamp,
      },
      "Message exhausted its retries and reached the dead letter queue",
    );
  }

  batch.ackAll();
}
