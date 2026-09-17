import type { ExecutionContext } from "hono";
import app from "~/server/public-api";
import { createDrizzleClient, withDrizzleClient } from "~/server/drizzle";
import {
  withWorkerBindings,
  type WorkerBindings,
} from "~/server/worker-bindings";
import { handleStorageRequest, isStorageRequest } from "./storage-routes";

/**
 * The public API, served from a Cloudflare Worker.
 *
 * `server/public-api/hono.ts` is already Hono, so there is nothing to rewrite:
 * this file exists to give the Hono app a `fetch` handler, a database
 * connection and its bindings. The API's routes, request shapes and responses
 * are the external contract and are untouched.
 *
 * See references/serverless-migration.md §7.
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
};
