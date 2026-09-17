import handler from "@tanstack/react-start/server-entry";
import type { ExecutionContext } from "hono";
import type { MessageBatch } from "@cloudflare/workers-types";

import type { WorkerBindings } from "~/server/worker-bindings";
import { handleQueueBatch } from "./worker/queue-consumer";
import { routeWorkerRequest, withRequestScopes } from "./worker/routing";
import { handleScheduled } from "./worker/scheduled";

/**
 * The Worker. One entry, one bundle, everything useSend runs.
 *
 * `wrangler.jsonc` names this file as `main` and `vite.config.ts` names it as
 * TanStack Start's `server.entry`, which is what lets the dashboard, the Hono
 * public API, the queue consumer, the cron handler and the four Durable
 * Objects share a deploy. That is not a packaging compromise — on Cloudflare a
 * queue consumer *is* the `queue()` export on a Worker and a Durable Object
 * *is* a class exported from `main`, so splitting them would mean more than
 * one Worker, more than one set of bindings, and payload shapes free to drift
 * between the halves.
 *
 * The request routing lives in `worker/routing.ts`; this file exists to give
 * it the Start handler as its fall-through and to hold the exports Cloudflare
 * looks up by name.
 *
 * See references/serverless-migration.md §2, §7 and §9.
 */

/**
 * Durable Object classes have to be exported from the module `wrangler.jsonc`
 * names as `main` for it to bind them by class name.
 */
export { CampaignScheduler } from "./worker/campaign-scheduler";
export { IdempotencyKeeper } from "./worker/idempotency-keeper";
export { RateLimiter } from "./worker/rate-limiter";
export { WebhookDispatcher } from "./worker/webhook-dispatcher";

export default {
  async fetch(
    request: Request,
    env: WorkerBindings,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return withRequestScopes(env, ctx, async () =>
      routeWorkerRequest(request, env, ctx, (r) => handler.fetch(r)),
    );
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
