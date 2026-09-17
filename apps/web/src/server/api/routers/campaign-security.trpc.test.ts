import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockValidateDomainFromEmail, mockSelectRows, mockInsertRows } =
  vi.hoisted(() => ({
    mockDb: {
      teamUser: {
        findFirst: vi.fn(),
      },
      campaign: {
        findUnique: vi.fn(),
      },
    },
    mockValidateDomainFromEmail: vi.fn(),
    mockSelectRows: vi.fn(),
    mockInsertRows: vi.fn(),
  }));

// The trpc context middleware still resolves ctx.team and ctx.campaign through
// Prisma; only the router's own queries have moved.
vi.mock("~/server/db", () => ({
  db: mockDb,
}));

/**
 * Only the Drizzle client is faked, so the router's real queries still run.
 * The where condition and inserted values are captured so the assertions can
 * check what actually reached the query rather than trusting the arguments.
 */
const captured: { where: unknown; values: unknown } = {
  where: undefined,
  values: undefined,
};

vi.mock("~/server/drizzle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/server/drizzle")>();
  const drizzleDb = {
    select: () => ({
      from: () => ({
        where: (condition: unknown) => {
          captured.where = condition;
          return { limit: () => mockSelectRows() };
        },
      }),
    }),
    insert: () => ({
      values: (values: unknown) => {
        captured.values = values;
        return { returning: () => mockInsertRows() };
      },
    }),
  };
  return { ...actual, drizzleDb };
});

/** Pulls every column name referenced by a Drizzle SQL condition. */
function collectColumnNames(condition: unknown): string[] {
  const names: string[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.name === "string" && node.table) names.push(node.name);
    for (const chunk of node.queryChunks ?? []) visit(chunk);
  };
  visit(condition);
  return names;
}

vi.mock("~/server/auth", () => ({
  getServerAuthSession: vi.fn(),
}));

vi.mock("~/server/service/campaign-service", () => ({}));
vi.mock("~/server/service/webhook-service", () => ({}));
vi.mock("~/server/service/domain-service", () => ({
  validateDomainFromEmail: mockValidateDomainFromEmail,
}));

import { createCallerFactory } from "~/server/api/trpc";
import { campaignRouter } from "~/server/api/routers/campaign";

const createCaller = createCallerFactory(campaignRouter);

function getContext() {
  return {
    db: mockDb,
    headers: new Headers(),
    session: {
      user: {
        id: 1,
        email: "owner@example.com",
        isWaitlisted: false,
        isAdmin: false,
        isBetaUser: true,
      },
    },
  } as any;
}

describe("campaignRouter.updateCampaign authorization", () => {
  beforeEach(() => {
    mockDb.teamUser.findFirst.mockReset();
    mockDb.campaign.findUnique.mockReset();
    mockSelectRows.mockReset();
    mockInsertRows.mockReset();
    captured.where = undefined;
    captured.values = undefined;

    mockDb.teamUser.findFirst.mockResolvedValue({
      teamId: 10,
      userId: 1,
      role: "ADMIN",
      team: { id: 10, name: "Acme" },
    });

    mockDb.campaign.findUnique.mockResolvedValue({
      id: "camp_1",
      teamId: 10,
      domainId: 2,
    });

    mockInsertRows.mockResolvedValue([{ id: "camp_copy", teamId: 10 }]);
  });

  it("rejects assigning a contact book from another team", async () => {
    // A contact book owned by another team is simply not found by a
    // team-scoped read.
    mockSelectRows.mockResolvedValue([]);

    const caller = createCaller(getContext());

    await expect(
      caller.updateCampaign({
        campaignId: "camp_1",
        contactBookId: "cb_other_team",
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Contact book not found",
    });

    // The lookup must be scoped by ctx.team.id, not just by the id the caller
    // supplied.
    const columns = collectColumnNames(captured.where);
    expect(columns).toContain("teamId");
    expect(columns).toContain("id");
  });
});

describe("campaignRouter.duplicateCampaign", () => {
  beforeEach(() => {
    mockDb.teamUser.findFirst.mockReset();
    mockDb.campaign.findUnique.mockReset();
    mockInsertRows.mockReset();
    captured.values = undefined;

    mockDb.teamUser.findFirst.mockResolvedValue({
      teamId: 10,
      userId: 1,
      role: "ADMIN",
      team: { id: 10, name: "Acme" },
    });

    mockDb.campaign.findUnique.mockResolvedValue({
      id: "camp_1",
      teamId: 10,
      name: "Weekly update",
      from: "Team <hello@example.com>",
      replyTo: ["support@example.com"],
      cc: ["ops@example.com"],
      bcc: ["audit@example.com"],
      subject: "This week",
      previewText: "Quick overview",
      content: '{"root":{}}',
      html: "<p>This week</p>",
      domainId: 2,
      contactBookId: "cb_1",
    });

    mockInsertRows.mockResolvedValue([{ id: "camp_copy", teamId: 10 }]);
  });

  it("duplicates reply-to and other email headers", async () => {
    const caller = createCaller(getContext());

    await caller.duplicateCampaign({
      campaignId: "camp_1",
    });

    expect(captured.values).toMatchObject({
      name: "Weekly update (Copy)",
      from: "Team <hello@example.com>",
      replyTo: ["support@example.com"],
      cc: ["ops@example.com"],
      bcc: ["audit@example.com"],
      subject: "This week",
      previewText: "Quick overview",
      content: '{"root":{}}',
      html: "<p>This week</p>",
      teamId: 10,
      domainId: 2,
      contactBookId: "cb_1",
    });
  });
});
