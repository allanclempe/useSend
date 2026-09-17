import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { Context, Next } from "hono";
import { handleError } from "./api-error";
import { env } from "~/env";
import {
  consumeRateLimitFailOpen,
  rateLimitBucket,
} from "~/server/rate-limit";
import { getTeamFromToken } from "~/server/public-api/auth";
import { isSelfHosted } from "~/utils/common";
import { UnsendApiError } from "./api-error";
import { Team, ApiKey } from "~/types/db";
import { logger } from "../logger/log";
import {
  startTrace,
  TRACEPARENT_HEADER,
  withTraceContext,
} from "../logger/trace-context";

// Define AppEnv for Hono context
export type AppEnv = {
  Variables: {
    team: Team & { apiKeyId: number; apiKey: { domainId: number | null } };
  };
};

export function getApp() {
  const app = new OpenAPIHono<AppEnv>().basePath("/api");

  app.onError(handleError);

  // Trace context. First middleware on purpose: everything after it — auth,
  // rate limiting, handlers, and every queue message they produce — logs under
  // one trace_id, which is what makes an API → queue → consumer hop followable
  // (#18). An inbound `traceparent` continues the caller's trace.
  app.use("*", async (c: Context<AppEnv>, next: Next) => {
    await withTraceContext(
      startTrace(c.req.header(TRACEPARENT_HEADER)),
      async () => {
        await next();
      },
    );
  });

  // Auth and Team Middleware (runs before rate limiter)
  app.use("*", async (c: Context<AppEnv>, next: Next) => {
    if (
      c.req.path.startsWith("/api/v1/doc") ||
      c.req.path.startsWith("/api/v1/ui") ||
      c.req.path === "/api/health"
    ) {
      return next();
    }

    try {
      const team = await getTeamFromToken(c as any);
      c.set("team", team);
    } catch (error) {
      if (error instanceof UnsendApiError) {
        throw error;
      }
      logger.error({ err: error }, "Error in getTeamFromToken middleware");
      throw new UnsendApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Authentication failed",
      });
    }
    await next();
  });

  // Custom Rate Limiter Middleware
  const RATE_LIMIT_WINDOW_SECONDS = 1;

  app.use("*", async (c: Context<AppEnv>, next: Next) => {
    // Skip for self-hosted, or if team is not set (e.g. for public/doc paths not caught earlier)
    // or if the path is one of the explicitly skipped paths for auth.
    if (
      isSelfHosted() ||
      !c.var.team || // Team should be set by auth middleware for protected routes
      c.req.path.startsWith("/api/v1/doc") ||
      c.req.path.startsWith("/api/v1/ui") ||
      c.req.path === "/api/health"
    ) {
      return next();
    }

    const team = c.var.team;
    const limit = team.apiRateLimit ?? 2; // Default limit from your previous setup

    // Fail open: a limiter that is down should not take the API down with it.
    // The reasoning, and the one call site that does not do this, are in
    // `server/rate-limit/index.ts`.
    const result = await consumeRateLimitFailOpen(
      rateLimitBucket.api(team.id),
      { limit, windowSeconds: RATE_LIMIT_WINDOW_SECONDS },
      (error) => logger.error({ err: error }, "Rate limiter failed"),
    );

    if (!result) {
      return next();
    }

    const resetTime = Math.floor(Date.now() / 1000) + result.resetSeconds;

    c.res.headers.set("X-RateLimit-Limit", String(result.limit));
    c.res.headers.set("X-RateLimit-Remaining", String(result.remaining));
    c.res.headers.set("X-RateLimit-Reset", String(resetTime));

    if (result.limited) {
      c.res.headers.set("Retry-After", String(result.resetSeconds));
      throw new UnsendApiError({
        code: "RATE_LIMITED",
        message: `Rate limit exceeded. Try again in ${result.resetSeconds} seconds.`,
      });
    }

    await next();
  });

  // The OpenAPI documentation will be available at /doc
  app.doc("/v1/doc", (c) => ({
    openapi: "3.0.0",
    info: {
      version: "1.0.0",
      title: "useSend API",
    },
    servers: [{ url: `${env.APP_URL}/api` }],
  }));

  app.openAPIRegistry.registerComponent("securitySchemes", "Bearer", {
    type: "http",
    scheme: "bearer",
  });

  app.get("/v1/ui", swaggerUI({ url: "/api/v1/doc" }));

  return app;
}

export type PublicAPIApp = OpenAPIHono<AppEnv>;
