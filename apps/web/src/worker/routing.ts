import type { ExecutionContext } from "hono";
import app from "~/server/public-api";
import { createDrizzleClient, withDrizzleClient } from "~/server/drizzle";
import {
  withWorkerBindings,
  type WorkerBindings,
} from "~/server/worker-bindings";
import {
  handleSesCallbackRequest,
  isSesCallbackRequest,
} from "~/server/service/ses-callback";
import { handleStorageRequest, isStorageRequest } from "./storage-routes";

/**
 * Everything the Worker serves that is not the dashboard.
 *
 * `src/server.ts` is the entry point — it owns the `fetch`, `queue` and
 * `scheduled` exports and the four Durable Object classes, because a Durable
 * Object can only be bound by a class name exported from the module
 * `wrangler.jsonc` names as `main`. This file is what its `fetch` calls first,
 * and the dashboard is the fall-through when nothing here claims the request.
 *
 * The split exists so the routing order is written down once, in one place, in
 * the order it is evaluated:
 *
 *   1. `/storage/*`      — the R2 upload/download proxy (§7, decision 4)
 *   2. the SES callback  — SNS posts here, at a path `ses-settings-service`
 *                          subscribed the topic to, so it cannot move
 *   3. `/api/v1/*`, `/api/health` — the Hono public API, the external contract
 *   4. everything else   — TanStack Start
 *
 * See references/serverless-migration.md §2, §7 and §9.
 */

/**
 * Paths the Hono app owns. Everything else under `/api` belongs to the app.
 *
 * `/api/v1` and nothing else. The Hono app is mounted at `/api` and used to
 * receive every unmatched path with it, answering a JSON 404; narrowing it to
 * the documented prefix is what lets `/api/health`, `/api/auth/*` and the
 * other route handlers that used to be Next.js files live as server routes.
 * No documented endpoint moves — `/api/v1/doc` and `/api/v1/ui` are under the
 * prefix too.
 */
export function isPublicApiRequest(url: URL): boolean {
  return url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/");
}

export type FallbackFetch = (request: Request) => Response | Promise<Response>;

/**
 * Runs `fn` with the per-request Worker scopes in place.
 *
 * The database client is built per request, not per isolate: Workers ties an
 * I/O object to the request that opened it, so a connection cached across
 * requests fails on the second one with "Cannot perform I/O on behalf of a
 * different request". Hyperdrive does the pooling this would otherwise be
 * doing.
 */
export async function withRequestScopes<T>(
  env: WorkerBindings,
  ctx: ExecutionContext,
  fn: () => Promise<T>,
): Promise<T> {
  const { db, close } = createDrizzleClient(env.HYPERDRIVE.connectionString, 1);

  try {
    return await withWorkerBindings(env, () => withDrizzleClient(db, fn));
  } finally {
    // Not awaited: `getTeamFromToken` deliberately leaves the `lastUsed` write
    // floating, and closing out of band gives it a chance to land. The socket
    // is torn down with the request context either way.
    ctx.waitUntil(close());
  }
}

/**
 * Routes one request, already inside the per-request scopes.
 *
 * `fallback` is the dashboard. Passing it in rather than importing it keeps
 * this module free of the Start handler, which only exists once Vite has
 * built the route tree — so the fixture Workers and the unit tests can import
 * the routing without pulling a build artifact in behind it.
 */
export function routeWorkerRequest(
  request: Request,
  env: WorkerBindings,
  ctx: ExecutionContext,
  fallback: FallbackFetch,
): Response | Promise<Response> {
  const url = new URL(request.url);

  if (isStorageRequest(url)) {
    return handleStorageRequest(request, url);
  }

  if (isSesCallbackRequest(url)) {
    return handleSesCallbackRequest(request);
  }

  if (isPublicApiRequest(url)) {
    return app.fetch(request, env, ctx);
  }

  return fallback(request);
}
