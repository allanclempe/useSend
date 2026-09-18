import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Carried over from `server/api/routers/campaign-security.trpc.test.ts` when
 * Phase 7 deleted the tRPC routers (#9).
 *
 * Two of that file's assertions had no equivalent anywhere else. The rest of
 * its cross-team coverage now lives in `campaign-lifecycle.integration.test.ts`
 * against the service, which is stronger — it runs against a real database.
 *
 * Both started life inside `updateCampaign` and `duplicateCampaign`, which
 * cannot be called outside a Start request context — and exporting them from
 * `server/functions/campaign.ts` to get at them is worse than useless: a
 * plain export there is one the client bundle has to keep, so it pulls
 * Drizzle and the `postgres` driver into the browser and the app stops
 * hydrating. They live on the service, which the client never imports.
 *
 * The authorisation ladder is not retested here: `campaignMiddleware` is glue
 * over `~/server/authorization`, which has its own tests.
 */

const { mockSelectRows } = vi.hoisted(() => ({ mockSelectRows: vi.fn() }));

/**
 * Only the Drizzle client is faked, so the real query still runs. The `where`
 * condition is captured so the test can assert the team filter actually
 * reached the query rather than trusting that it did.
 */
const captured: { where: unknown } = { where: undefined };

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
  };
  return { ...actual, drizzleDb };
});

const { assertContactBookInTeam, campaignCopyValues } = await import(
  "~/server/service/campaign-service"
);

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

describe("assertContactBookInTeam", () => {
  beforeEach(() => {
    mockSelectRows.mockReset();
    captured.where = undefined;
  });

  it("rejects a contact book from another team", async () => {
    // A contact book owned by another team is simply not found by a
    // team-scoped read.
    mockSelectRows.mockResolvedValue([]);

    await expect(
      assertContactBookInTeam("cb_other_team", 10),
    ).rejects.toThrow("Contact book not found");

    // The lookup must be scoped by the team in context, not just by the id
    // the caller supplied.
    const columns = collectColumnNames(captured.where);
    expect(columns).toContain("teamId");
    expect(columns).toContain("id");
  });

  it("accepts a contact book the team owns", async () => {
    mockSelectRows.mockResolvedValue([{ id: "cb_1" }]);

    await expect(assertContactBookInTeam("cb_1", 10)).resolves.toBeUndefined();
  });
});

describe("campaignCopyValues", () => {
  it("duplicates reply-to and other email headers", () => {
    const values = campaignCopyValues(
      {
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
      },
      10,
    );

    expect(values).toMatchObject({
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

  it("gives the copy its own id", () => {
    const campaign = {
      name: "Weekly update",
      from: "Team <hello@example.com>",
      replyTo: [],
      cc: [],
      bcc: [],
      subject: "This week",
      previewText: null,
      content: null,
      html: null,
      domainId: 2,
      contactBookId: null,
    };

    const first = campaignCopyValues(campaign, 10);
    const second = campaignCopyValues(campaign, 10);

    expect(first.id).toBeTruthy();
    expect(first.id).not.toBe(second.id);
  });
});
