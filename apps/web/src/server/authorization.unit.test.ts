import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockTeamUserFindFirst, mockSelectRows, mockGetSession, mocks } =
  vi.hoisted(() => ({
    mockTeamUserFindFirst: vi.fn(),
    mockSelectRows: vi.fn(),
    mockGetSession: vi.fn(),
    mocks: { adminEmail: undefined as string | undefined, isCloud: true },
  }));

/**
 * Only the Drizzle client is faked, so the real conditions are still built —
 * `where` is captured so a test can assert the team filter actually reached
 * the query rather than trusting that it did.
 */
const capturedWhere: { value: unknown } = { value: undefined };

vi.mock("~/server/drizzle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/server/drizzle")>();
  const chain = {
    select: () => chain,
    from: () => chain,
    where: (condition: unknown) => {
      capturedWhere.value = condition;
      return chain;
    },
    limit: () => mockSelectRows(),
    query: { teamUser: { findFirst: mockTeamUserFindFirst } },
  };
  return { ...actual, drizzleDb: chain };
});

vi.mock("~/server/auth", () => ({
  getServerAuthSession: mockGetSession,
}));

vi.mock("~/env", async (importOriginal) => {
  const actual = await importOriginal<{ env: Record<string, unknown> }>();
  return {
    // eslint-disable-next-line no-undef
    env: new Proxy(actual.env, {
      get: (target, property) =>
        property === "ADMIN_EMAIL"
          ? mocks.adminEmail
          : Reflect.get(target, property),
    }),
  };
});

vi.mock("~/env.public", async (importOriginal) => {
  const actual = await importOriginal<{ publicEnv: Record<string, unknown> }>();
  return {
    // eslint-disable-next-line no-undef
    publicEnv: new Proxy(actual.publicEnv, {
      get: (target, property) =>
        property === "NEXT_PUBLIC_IS_CLOUD"
          ? mocks.isCloud
          : Reflect.get(target, property),
    }),
  };
});

import { AppError } from "~/server/app-error";
import {
  requireActiveUser,
  requireCampaign,
  requireDomain,
  requireInstanceAdmin,
  requireTeam,
  requireTeamAdmin,
  requireUser,
} from "~/server/authorization";

const headers = new Headers();

const baseUser = {
  id: 1,
  email: "user@example.com",
  isBetaUser: true,
  isAdmin: false,
  isWaitlisted: false,
};

function signedInAs(user: Partial<typeof baseUser> = {}) {
  mockGetSession.mockResolvedValue({ user: { ...baseUser, ...user } });
}

/** Pulls every column name referenced by a Drizzle SQL condition. */
function collectColumnNames(condition: unknown): string[] {
  const names: string[] = [];

  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.name === "string" && node.table) {
      names.push(node.name);
    }
    for (const chunk of node.queryChunks ?? []) visit(chunk);
  };

  visit(condition);
  return names;
}

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return error instanceof AppError ? error.code : `not an AppError: ${error}`;
  }
}

describe("authorization", () => {
  beforeEach(() => {
    mockTeamUserFindFirst.mockReset();
    mockSelectRows.mockReset();
    mockGetSession.mockReset();
    capturedWhere.value = undefined;
    mocks.adminEmail = undefined;
    mocks.isCloud = true;
  });

  describe("the ladder", () => {
    it("refuses an anonymous caller", async () => {
      mockGetSession.mockResolvedValue(null);

      expect(await codeOf(requireUser(headers))).toBe("UNAUTHORIZED");
    });

    it("admits a waitlisted user to requireUser but not requireActiveUser", async () => {
      signedInAs({ isWaitlisted: true });

      await expect(requireUser(headers)).resolves.toMatchObject({ id: 1 });
      expect(await codeOf(requireActiveUser(headers))).toBe("UNAUTHORIZED");
    });

    it("loads the team without leaking the joined row into teamUser", async () => {
      signedInAs();
      mockTeamUserFindFirst.mockResolvedValue({
        teamId: 10,
        userId: 1,
        role: "ADMIN",
        team: { id: 10, name: "Acme" },
      });

      const context = await requireTeam(headers);

      expect(context.team).toEqual({ id: 10, name: "Acme" });
      expect(context.teamUser.role).toBe("ADMIN");
      // Callers spread `teamUser` into update payloads; the joined `team` must
      // not travel with it.
      expect(context.teamUser).not.toHaveProperty("team");
    });

    it("reports a user with no team as NOT_FOUND", async () => {
      signedInAs();
      mockTeamUserFindFirst.mockResolvedValue(null);

      expect(await codeOf(requireTeam(headers))).toBe("NOT_FOUND");
    });

    it("refuses a MEMBER where ADMIN is required, but not where it is not", async () => {
      signedInAs();
      mockTeamUserFindFirst.mockResolvedValue({
        teamId: 10,
        userId: 1,
        role: "MEMBER",
        team: { id: 10, name: "Acme" },
      });

      expect(await codeOf(requireTeamAdmin(headers))).toBe("UNAUTHORIZED");
      expect(await codeOf(requireTeam(headers))).toBe("resolved");
    });
  });

  describe("requireInstanceAdmin", () => {
    it("refuses an address that is not ADMIN_EMAIL on cloud", async () => {
      mocks.adminEmail = "founder@usesend.com";
      signedInAs({ email: "someone@else.com" });

      expect(await codeOf(requireInstanceAdmin(headers))).toBe("UNAUTHORIZED");
    });

    it("admits ADMIN_EMAIL on cloud", async () => {
      mocks.adminEmail = "founder@usesend.com";
      signedInAs({ email: "founder@usesend.com" });

      await expect(requireInstanceAdmin(headers)).resolves.toMatchObject({
        email: "founder@usesend.com",
      });
    });

    it("refuses everyone on cloud when ADMIN_EMAIL is not set", async () => {
      // A bare `user.email === env.ADMIN_EMAIL` is true when both are
      // undefined, which handed instance admin to any session without an email
      // on an install that had never configured one.
      mocks.adminEmail = undefined;
      signedInAs({ email: undefined });

      expect(await codeOf(requireInstanceAdmin(headers))).toBe("UNAUTHORIZED");
    });

    it("admits anyone signed in when self-hosted", async () => {
      mocks.isCloud = false;
      mocks.adminEmail = "founder@usesend.com";
      signedInAs({ email: "whoever@installed.it" });

      await expect(requireInstanceAdmin(headers)).resolves.toMatchObject({
        email: "whoever@installed.it",
      });
    });
  });

  describe("resource loaders", () => {
    it("scopes the lookup to the team and hides a miss as NOT_FOUND", async () => {
      mockSelectRows.mockResolvedValue([]);

      expect(await codeOf(requireDomain(10, 42))).toBe("NOT_FOUND");

      // Two columns, not one: filtering on the id alone would hand another
      // team's domain to whoever guessed the number, which is the entire
      // reason these functions exist.
      const columns = collectColumnNames(capturedWhere.value);
      expect(columns).toContain("teamId");
      expect(columns).toContain("id");
    });

    it("returns the row when it belongs to the team", async () => {
      mockSelectRows.mockResolvedValue([
        { id: 42, teamId: 10, name: "example.com" },
      ]);

      await expect(requireDomain(10, 42)).resolves.toMatchObject({ id: 42 });
    });

    it("scopes string-keyed resources the same way", async () => {
      mockSelectRows.mockResolvedValue([]);

      expect(await codeOf(requireCampaign(10, "cmp_1"))).toBe("NOT_FOUND");
      expect(collectColumnNames(capturedWhere.value)).toContain("teamId");
    });
  });
});
