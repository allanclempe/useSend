import { createFileRoute } from "@tanstack/react-router";

/**
 * `GET /api/health` — is this Worker up?
 *
 * A server route rather than a Hono route: `server/public-api` is the external
 * contract and this is not part of it. The Hono middleware still names the
 * path, because it has to exempt it from API-key auth and rate limiting in the
 * case where a request reaches it — but nothing there answers it, and nothing
 * there ever did. It was a Next.js route handler before (#9).
 *
 * It deliberately touches nothing: no database, no bindings. A health check
 * that fails when Postgres is slow turns one degraded dependency into a
 * removed-from-the-load-balancer outage.
 */
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: () => Response.json({ data: "Healthy" }),
    },
  },
});
