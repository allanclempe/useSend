import type { ExecutionContext } from "hono";
import type { MessageBatch } from "@cloudflare/workers-types";
import app from "~/server/public-api";
import { createDrizzleClient, withDrizzleClient } from "~/server/drizzle";
import {
  withWorkerBindings,
  type WorkerBindings,
} from "~/server/worker-bindings";
import { handleQueueBatch } from "./queue-consumer";
import { handleScheduled } from "./scheduled";
import { handleStorageRequest, isStorageRequest } from "./storage-routes";

/**
 * Durable Object classes have to be exported from the Worker's entry module for
 * `wrangler.jsonc` to bind them by class name.
 */
export { CampaignScheduler } from "./campaign-scheduler";
export { WebhookDispatcher } from "./webhook-dispatcher";

/**
 * The public API, served from a Cloudflare Worker.
 *
 * `server/public-api/hono.ts` is already Hono, so there is nothing to rewrite:
 * this file exists to give the Hono app a `fetch` handler, a database
 * connection and its bindings. The API's routes, request shapes and responses
 * are the external contract and are untouched.
 *
 * The same Worker is also the consumer for every queue it declares. That is not
 * a packaging compromise — a Cloudflare Queues consumer *is* a `queue()` export
 * on a Worker, and putting it here means producer and consumer share one
 * bundle, one set of bindings and one deploy, so a payload shape cannot drift
 * between the two halves.
 *
 * See references/serverless-migration.md §2 and §7.
 */
export default {
  async fetch(
    request: Request,
    env: WorkerBindings,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Per request, not per isolate. Workers ties an I/O object to the request
    // that opened it, so a connection cached across requests fails on the
    // second one with "Cannot perform I/O on behalf of a different request".
    // Hyperdrive does the pooling this would otherwise be doing.
    const { db, close } = createDrizzleClient(env.HYPERDRIVE.connectionString, 1);

    try {
      return await withWorkerBindings(env, () =>
        withDrizzleClient(db, () => {
          const url = new URL(request.url);

          // Outside the Hono app on purpose — see storage-routes.ts.
          if (isStorageRequest(url)) {
            return handleStorageRequest(request, url);
          }

          return app.fetch(request, env, ctx);
        }),
      );
    } finally {
      // Not awaited: `getTeamFromToken` deliberately leaves the `lastUsed`
      // write floating, and closing out of band gives it a chance to land.
      // The socket is torn down with the request context either way.
      ctx.waitUntil(close());
    }
  },

  async queue(
    batch: MessageBatch<unknown>,
    env: WorkerBindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    await handleQueueBatch(batch, env, ctx);
  },

  async scheduled(
    controller: { cron: string; scheduledTime: number },
    env: WorkerBindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    await handleScheduled(controller, env, ctx);
  },
};
