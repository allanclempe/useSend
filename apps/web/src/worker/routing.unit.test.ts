import { describe, expect, it } from "vitest";

import { isPublicApiRequest } from "./routing";

/**
 * The Hono app is the external contract, and the only thing standing between a
 * documented endpoint and a 404 is which paths this predicate claims. It
 * narrowed from `/api` to `/api/v1` when the dashboard moved onto the same
 * Worker (#9), so the cases that matter are the ones on either side of that
 * line.
 */
describe("isPublicApiRequest", () => {
  it.each([
    "/api/v1",
    "/api/v1/emails",
    "/api/v1/domains/4",
    "/api/v1/doc",
    "/api/v1/ui",
  ])("routes %s to the public API", (pathname) => {
    expect(isPublicApiRequest(new URL(`https://app.usesend.com${pathname}`))).toBe(
      true,
    );
  });

  it.each([
    "/",
    "/dashboard",
    "/api/health",
    "/api/auth/callback/github",
    "/api/webhook/stripe",
    "/storage/logo.png",
  ])("leaves %s to the app", (pathname) => {
    expect(isPublicApiRequest(new URL(`https://app.usesend.com${pathname}`))).toBe(
      false,
    );
  });

  it("does not match a path that merely starts with the same characters", () => {
    expect(
      isPublicApiRequest(new URL("https://app.usesend.com/api/v11/emails")),
    ).toBe(false);
  });
});
