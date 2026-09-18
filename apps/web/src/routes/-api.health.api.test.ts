import { describe, expect, it } from "vitest";

import { Route } from "./api.health";

/**
 * Carried over from `app/api/health/route.api.test.ts` when Phase 7 deleted
 * `src/app` (#9).
 *
 * The handler is reached through `Route.options` rather than exported on its
 * own, because a file route's server handlers are declared inline and the
 * point of the test is that *this route* answers — an exported function that
 * nothing is wired to would assert nothing.
 *
 * The assertion is deliberately the exact body: uptime checks are configured
 * against it outside this repository, so it is an interface and not an
 * implementation detail.
 */
/**
 * `handlers` is declared as either a record of methods or a factory returning
 * one; this route uses the record form, and the cast picks that branch.
 */
type GetHandler = () => Response | Promise<Response>;

describe("health route", () => {
  it("returns healthy response", async () => {
    const handlers = Route.options.server?.handlers as
      | { GET?: GetHandler }
      | undefined;
    const handler = handlers?.GET;

    expect(handler).toBeTypeOf("function");

    const response = await handler!();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ data: "Healthy" });
  });
});
