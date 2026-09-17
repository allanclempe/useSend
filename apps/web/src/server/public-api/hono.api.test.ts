import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnsendApiError } from "~/server/public-api/api-error";

const { mockGetTeamFromToken, mockRateLimit } = vi.hoisted(() => ({
  mockGetTeamFromToken: vi.fn(),
  mockRateLimit: (() => {
    /**
     * An in-memory fixed window, not a mocked Redis client.
     *
     * The middleware no longer knows which backend it is on, so the test mocks
     * the seam. It also means these tests exercise the real limiting
     * arithmetic — count, remaining, reset, limited — rather than asserting
     * against canned `INCR` return values.
     */
    const windows = new Map<string, { count: number; expiresAt: number }>();

    return {
      windows,
      consume: vi.fn(
        async (
          bucket: string,
          window: { limit: number; windowSeconds: number },
        ) => {
          const now = Date.now();
          const existing = windows.get(bucket);
          const current =
            existing && existing.expiresAt > now
              ? existing
              : { count: 0, expiresAt: now + window.windowSeconds * 1000 };

          current.count += 1;
          windows.set(bucket, current);

          return {
            count: current.count,
            limit: window.limit,
            remaining: Math.max(0, window.limit - current.count),
            resetSeconds: Math.max(
              1,
              Math.ceil((current.expiresAt - now) / 1000),
            ),
            limited: current.count > window.limit,
          };
        },
      ),
    };
  })(),
}));

vi.mock("~/server/public-api/auth", () => ({
  getTeamFromToken: mockGetTeamFromToken,
}));

vi.mock("~/server/rate-limit", () => ({
  rateLimitBucket: { api: (teamId: number) => `api:team:${teamId}` },
  consumeRateLimit: (bucket: string, window: unknown) =>
    mockRateLimit.consume(bucket, window as never),
  consumeRateLimitFailOpen: (bucket: string, window: unknown) =>
    mockRateLimit.consume(bucket, window as never),
}));

vi.mock("~/utils/common", () => ({
  isSelfHosted: () => false,
}));

import { getApp } from "~/server/public-api/hono";

describe("public API Hono middleware", () => {
  beforeEach(() => {
    mockGetTeamFromToken.mockReset();
    mockRateLimit.windows.clear();
    mockRateLimit.consume.mockClear();
  });

  it("applies auth and rate limit headers", async () => {
    mockGetTeamFromToken.mockResolvedValue({
      id: 1,
      apiRateLimit: 2,
      apiKeyId: 11,
      apiKey: { domainId: null },
    });

    const app = getApp();
    app.get("/v1/ping", (c) => c.json({ ok: true }));

    const response = await app.request("http://localhost/api/v1/ping", {
      headers: {
        Authorization: "Bearer test-key",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("X-RateLimit-Limit")).toBe("2");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("1");
  });

  it("returns 429 when limit is exceeded", async () => {
    mockGetTeamFromToken.mockResolvedValue({
      id: 1,
      apiRateLimit: 2,
      apiKeyId: 11,
      apiKey: { domainId: null },
    });
    const app = getApp();
    app.get("/v1/ping", (c) => c.json({ ok: true }));

    const call = () =>
      app.request("http://localhost/api/v1/ping", {
        headers: {
          Authorization: "Bearer test-key",
        },
      });

    // A limit of two, exceeded by the third request in the same window.
    await call();
    await call();
    const response = await call();

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: "RATE_LIMITED",
      },
    });
  });

  it("returns auth error from middleware", async () => {
    mockGetTeamFromToken.mockRejectedValue(
      new UnsendApiError({
        code: "UNAUTHORIZED",
        message: "No Authorization header provided",
      }),
    );

    const app = getApp();
    app.get("/v1/ping", (c) => c.json({ ok: true }));

    const response = await app.request("http://localhost/api/v1/ping");

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: "UNAUTHORIZED",
      },
    });
  });
});
