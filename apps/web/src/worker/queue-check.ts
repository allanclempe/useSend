/* eslint-disable no-unused-vars -- parameter names in type signatures */

import type { MessageBatch } from "@cloudflare/workers-types";
import { createQueue, createWorker, SES_WEBHOOK_QUEUE } from "~/server/queue";
import { CONTACT_BULK_ADD_QUEUE } from "~/server/queue/queue-constants";
import {
  withWorkerBindings,
  type WorkerBindings,
} from "~/server/worker-bindings";
import { WebhookQueueService } from "~/server/service/webhook-service";
import { handleQueueBatch } from "./queue-consumer";

export { WebhookDispatcher } from "./webhook-dispatcher";

/**
 * A fixture Worker, never deployed. Sibling of `compat-check.ts`.
 *
 * Phase 8 wires the queue seam to real Cloudflare Queue bindings, and the claim
 * worth checking against the real runtime rather than the documentation is that
 * a message enqueued through `createQueue(...).enqueue(...)` comes back out of
 * `createWorker(...)`'s handler — through `env`, through `workerd`'s queue
 * implementation, through the `queue()` export and the registry dispatch, with
 * its delay, its retries and its dead letter hop intact.
 *
 *   pnpm --filter=web queue:check
 *   curl -s -X POST 'http://localhost:8791/enqueue?count=3'
 *   curl -s http://localhost:8791/received | jq
 *
 * It also hosts the `WEBHOOK_DISPATCHER` Durable Object under the same class
 * and binding name the real Worker uses, so `/webhook-deliver` exercises the
 * ordering guarantee that replaced the Redis lock (§3) against pre-seeded
 * `WebhookCall` rows.
 *
 * This runs the production code: the real driver, the real registry, the real
 * `handleQueueBatch`, the real dispatcher. The only thing that is a fixture is
 * the queue handler, and the
 * way it gets there is worth stating plainly, because it is order-dependent:
 * `./queue-consumer` imports the service modules that call `createWorker` for
 * each real queue, and ES modules evaluate imports before the importing
 * module's body — so the `createWorker` calls below run last and replace those
 * registrations for the duration of this Worker. Nothing here can affect the
 * real Worker, which never imports this file.
 */

type Probe = {
  id: string;
  name: string;
  queue: string;
  attemptsMade: number;
  data: unknown;
  at: number;
};

/**
 * Module scope, which is the point: a consumer invocation is a separate
 * invocation from the `fetch` that produced the message, so the only way to see
 * one from the other is state that outlives both. It survives because
 * `wrangler dev` keeps one isolate alive; a deployed Worker must never rely on
 * this, which is the other half of what makes this a fixture.
 */
const received: Probe[] = [];

type ProbeJob = { label: string; failUntilAttempt?: number };

function record(queueName: string) {
  return async (job: {
    id?: string;
    name: string;
    data: ProbeJob;
    attemptsMade: number;
  }) => {
    received.push({
      id: job.id ?? "",
      name: job.name,
      queue: queueName,
      attemptsMade: job.attemptsMade,
      data: job.data,
      at: Date.now(),
    });

    // Proves two things the driver cannot prove on its own: that a thrown
    // handler retries rather than acks, and that `attemptsMade` counts prior
    // attempts the way BullMQ's did.
    const failUntil = job.data?.failUntilAttempt ?? 0;
    if (job.attemptsMade < failUntil) {
      throw new Error(`probe failure at attempt ${job.attemptsMade}`);
    }
  };
}

createWorker<ProbeJob>(SES_WEBHOOK_QUEUE, record(SES_WEBHOOK_QUEUE));
createWorker<ProbeJob>(CONTACT_BULK_ADD_QUEUE, record(CONTACT_BULK_ADD_QUEUE));

const fastQueue = createQueue<ProbeJob>(SES_WEBHOOK_QUEUE);
const deadLetterQueue = createQueue<ProbeJob>(CONTACT_BULK_ADD_QUEUE);

export default {
  async fetch(request: Request, env: WorkerBindings): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/received") {
      return Response.json({ count: received.length, received });
    }

    if (url.pathname === "/reset") {
      received.length = 0;
      return Response.json({ ok: true });
    }

    // Bindings are only readable inside a handler, which is why every enqueue
    // below runs in here rather than at module scope.
    return await withWorkerBindings(env, async () => {
      switch (url.pathname) {
        case "/enqueue": {
          const count = Number(url.searchParams.get("count") ?? "1");
          const delay = Number(url.searchParams.get("delay") ?? "0");
          const failUntilAttempt = Number(
            url.searchParams.get("failUntilAttempt") ?? "0",
          );

          for (let i = 0; i < count; i++) {
            await fastQueue.enqueue(
              `probe-${i}`,
              { label: `probe-${i}`, failUntilAttempt },
              delay > 0 ? { delay } : undefined,
            );
          }

          return Response.json({ enqueued: count, delay, failUntilAttempt });
        }

        case "/enqueue-bulk": {
          const count = Number(url.searchParams.get("count") ?? "250");

          await fastQueue.enqueueBulk(
            Array.from({ length: count }, (_, i) => ({
              name: `bulk-${i}`,
              data: { label: `bulk-${i}` },
            })),
          );

          return Response.json({ enqueued: count });
        }

        case "/enqueue-poison": {
          // Never succeeds, so it exhausts `max_retries` and Cloudflare hands
          // it to the dead letter queue. `contact-bulk-add` is used because its
          // retry schedule is the shortest in the registry: 10s then 20s.
          await deadLetterQueue.enqueue("poison", {
            label: "poison",
            failUntilAttempt: 99,
          });

          return Response.json({ enqueued: 1 });
        }

        case "/webhook-deliver": {
          // Hands a set of pre-seeded WebhookCall rows to the dispatcher for
          // one webhook. They go to one Durable Object, which is the claim
          // under test: single-threaded per object id, so deliveries to one
          // endpoint cannot overlap however fast they are handed over.
          const webhookId = url.searchParams.get("webhookId") ?? "";
          const teamId = Number(url.searchParams.get("teamId") ?? "1");
          const callIds = (url.searchParams.get("calls") ?? "")
            .split(",")
            .filter(Boolean);

          // In parallel on purpose: if ordering came from the caller rather
          // than from the object, this is where it would break.
          await Promise.all(
            callIds.map((callId) =>
              WebhookQueueService.enqueueCall(callId, webhookId, teamId),
            ),
          );

          return Response.json({ handedOver: callIds });
        }

        case "/enqueue-oversized": {
          try {
            await fastQueue.enqueue("oversized", {
              label: "x".repeat(200_000),
            });
            return Response.json({ rejected: false });
          } catch (error) {
            return Response.json({
              rejected: true,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }

        default:
          return Response.json({
            routes: [
              "POST /enqueue?count=&delay=&failUntilAttempt=",
              "POST /enqueue-bulk?count=",
              "POST /enqueue-poison",
              "POST /enqueue-oversized",
              "POST /webhook-deliver?webhookId=&teamId=&calls=",
              "GET /received",
              "POST /reset",
            ],
          });
      }
    });
  },

  async queue(
    batch: MessageBatch<unknown>,
    env: WorkerBindings,
    ctx: { waitUntil: (promise: Promise<unknown>) => void },
  ): Promise<void> {
    await handleQueueBatch(batch, env, ctx);
  },
};
