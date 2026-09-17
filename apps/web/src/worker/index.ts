import type { ExecutionContext } from "hono";
import app from "~/server/public-api";
import { createDrizzleClient, withDrizzleClient } from "~/server/drizzle";
import type { WorkerBindings } from "./bindings";

/**
 * The public API, served from a Cloudflare Worker.
 *
 * `server/public-api/hono.ts` is already Hono, so there is nothing to rewrite:
 * this file exists to give the Hono app a `fetch` handler and a database
 * connection. The API's routes, request shapes and responses are the external
 * contract and are untouched.
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
    // Hyperdrive does the pooling that this would otherwise be doing.
    const { db, close } = createDrizzleClient(env.HYPERDRIVE.connectionString, 1);

    try {
      return await withDrizzleClient(db, () => app.fetch(request, env, ctx));
    } finally {
      // Not awaited: `getTeamFromToken` deliberately leaves the `lastUsed`
      // write floating, and closing out of band gives it a chance to land.
      // The socket is torn down with the request context either way.
      ctx.waitUntil(close());
    }
  },
};
