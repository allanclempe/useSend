import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockTeamUserFindFirst, mockSendTeamInviteEmail, mockSelectRows } =
  vi.hoisted(() => ({
    mockTeamUserFindFirst: vi.fn(),
    mockSendTeamInviteEmail: vi.fn(),
    mockSelectRows: vi.fn(),
  }));

/**
 * Only the Drizzle client is faked — the real TeamService query, including its
 * teamId scoping, still runs. `where` is captured so the test can assert the
 * team filter actually reached the query rather than trusting it did.
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
    // teamProcedure resolves ctx.team through the same client.
    query: { teamUser: { findFirst: mockTeamUserFindFirst } },
  };
  return { ...actual, drizzleDb: chain };
});

vi.mock("~/server/auth", () => ({
  getServerAuthSession: vi.fn(),
}));

vi.mock("~/server/mailer", () => ({
  sendMail: vi.fn(),
  sendTeamInviteEmail: mockSendTeamInviteEmail,
}));

vi.mock("~/server/service/webhook-service", () => ({}));

import { createCallerFactory } from "~/server/api/trpc";
import { teamRouter } from "~/server/api/routers/team";

const createCaller = createCallerFactory(teamRouter);

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

function getContext() {
  return {
    headers: new Headers(),
    session: {
      user: {
        id: 1,
        email: "admin@example.com",
        isWaitlisted: false,
        isAdmin: false,
        isBetaUser: true,
      },
    },
  } as any;
}

describe("teamRouter.resendTeamInvite authorization", () => {
  beforeEach(() => {
    mockTeamUserFindFirst.mockReset();
    mockSelectRows.mockReset();
    mockSendTeamInviteEmail.mockReset();
    capturedWhere.value = undefined;

    mockTeamUserFindFirst.mockResolvedValue({
      teamId: 1,
      userId: 1,
      role: "ADMIN",
      team: { id: 1, name: "Team One" },
    });
  });

  it("does not resend invites that belong to another team", async () => {
    // An invite owned by another team is simply not found by a team-scoped read.
    mockSelectRows.mockResolvedValue([]);

    const caller = createCaller(getContext());

    await expect(
      caller.resendTeamInvite({ inviteId: "invite_team_2" }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Invite not found",
    });

    // The router must scope by ctx.team.id rather than anything the caller sent.
    // Drizzle conditions are SQL objects, so walk their chunks for the columns
    // rather than stringifying them.
    expect(capturedWhere.value).toBeDefined();
    const columns = collectColumnNames(capturedWhere.value);
    expect(columns).toContain("teamId");
    expect(columns).toContain("id");

    expect(mockSendTeamInviteEmail).not.toHaveBeenCalled();
  });
});
