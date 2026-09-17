import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnsendApiError } from "~/server/public-api/api-error";

const {
  mockGetTeamFromToken,
  mockRateLimit,
  mockGetContactBook,
  mockUpdateContactBook,
} = vi.hoisted(() => ({
  mockGetTeamFromToken: vi.fn(),
  mockRateLimit: (() => {
    /**
     * An in-memory fixed window, not a mocked Redis client — the middleware no
     * longer knows which backend it is on, so the test mocks the seam.
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
  mockGetContactBook: vi.fn(),
  mockUpdateContactBook: vi.fn(),
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

// The route layer is what is under test here; whether the lookup is actually
// scoped to the team is covered by update-contact-book.integration.test.ts.
vi.mock("~/server/public-api/api-utils", () => ({
  getContactBook: mockGetContactBook,
}));

vi.mock("~/server/service/contact-book-service", () => ({
  updateContactBook: mockUpdateContactBook,
}));

vi.mock("~/utils/common", () => ({
  isSelfHosted: () => false,
}));

import { getApp } from "~/server/public-api/hono";
import updateContactBookRoute from "~/server/public-api/api/contacts/update-contact-book";

function buildContactBook(overrides?: Record<string, unknown>) {
  return {
    id: "cb_1",
    name: "Newsletter",
    teamId: 1,
    properties: {},
    emoji: "📙",
    doubleOptInEnabled: true,
    doubleOptInFrom: null,
    doubleOptInSubject: "Please confirm your subscription",
    doubleOptInContent: '{"type":"doc"}',
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("PATCH /v1/contactBooks/{contactBookId}", () => {
  beforeEach(() => {
    mockGetTeamFromToken.mockReset();
    mockRateLimit.windows.clear();
    mockRateLimit.consume.mockClear();
    mockGetContactBook.mockReset();
    mockUpdateContactBook.mockReset();

    mockGetTeamFromToken.mockResolvedValue({
      id: 1,
      apiRateLimit: 20,
      apiKeyId: 11,
      apiKey: { domainId: null },
    });


    mockGetContactBook.mockResolvedValue({
      id: "cb_1",
      teamId: 1,
    });
  });

  it("updates contact book name", async () => {
    mockUpdateContactBook.mockResolvedValue(
      buildContactBook({
        name: "Leads",
      }),
    );

    const app = getApp();
    updateContactBookRoute(app);

    const response = await app.request(
      "http://localhost/api/v1/contactBooks/cb_1",
      {
        method: "PATCH",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Leads",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(mockGetContactBook).toHaveBeenCalledWith(
      expect.anything(),
      1,
    );
    expect(mockUpdateContactBook).toHaveBeenCalledWith("cb_1", {
      name: "Leads",
    });

    const body = await response.json();
    expect(body).toMatchObject({
      id: "cb_1",
      name: "Leads",
      properties: {},
    });
  });

  it("updates double opt-in optional fields", async () => {
    mockUpdateContactBook.mockResolvedValue(
      buildContactBook({
        doubleOptInEnabled: false,
        doubleOptInFrom: "Marketing <hello@example.com>",
        doubleOptInSubject: "Confirm your subscription",
        doubleOptInContent: '{"type":"doc","content":[]}',
      }),
    );

    const app = getApp();
    updateContactBookRoute(app);

    const response = await app.request(
      "http://localhost/api/v1/contactBooks/cb_1",
      {
        method: "PATCH",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          doubleOptInEnabled: false,
          doubleOptInFrom: "Marketing <hello@example.com>",
          doubleOptInSubject: "Confirm your subscription",
          doubleOptInContent: '{"type":"doc","content":[]}',
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(mockUpdateContactBook).toHaveBeenCalledWith("cb_1", {
      doubleOptInEnabled: false,
      doubleOptInFrom: "Marketing <hello@example.com>",
      doubleOptInSubject: "Confirm your subscription",
      doubleOptInContent: '{"type":"doc","content":[]}',
    });
  });

  it("allows empty JSON body and forwards no-op update", async () => {
    mockUpdateContactBook.mockResolvedValue(buildContactBook());

    const app = getApp();
    updateContactBookRoute(app);

    const response = await app.request(
      "http://localhost/api/v1/contactBooks/cb_1",
      {
        method: "PATCH",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );

    expect(response.status).toBe(200);
    expect(mockUpdateContactBook).toHaveBeenCalledWith("cb_1", {});
  });

  it("returns BAD_REQUEST when name is empty", async () => {
    const app = getApp();
    updateContactBookRoute(app);

    const response = await app.request(
      "http://localhost/api/v1/contactBooks/cb_1",
      {
        method: "PATCH",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "",
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(mockUpdateContactBook).not.toHaveBeenCalled();

    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        name: "ZodError",
        issues: [
          expect.objectContaining({
            path: ["name"],
          }),
        ],
      },
    });
  });

  it("returns service errors from update", async () => {
    mockUpdateContactBook.mockRejectedValue(
      new UnsendApiError({
        code: "BAD_REQUEST",
        message:
          "Double opt-in email content must include the {{doubleOptInUrl}} placeholder",
      }),
    );

    const app = getApp();
    updateContactBookRoute(app);

    const response = await app.request(
      "http://localhost/api/v1/contactBooks/cb_1",
      {
        method: "PATCH",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          doubleOptInContent: '{"type":"doc","content":[]}',
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(mockUpdateContactBook).toHaveBeenCalledTimes(1);

    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: "BAD_REQUEST",
        message:
          "Double opt-in email content must include the {{doubleOptInUrl}} placeholder",
      },
    });
  });
});
