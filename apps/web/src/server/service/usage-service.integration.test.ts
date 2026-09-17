import { format, subDays } from "date-fns";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { drizzleDb, schema } from "~/server/drizzle";
import { withUpdatedAt } from "~/server/drizzle/touch";
import { createTeam } from "~/test/factories/core";
import { getThisMonthUsage } from "~/server/service/usage-service";
import {
  closeIntegrationConnections,
  integrationEnabled,
  resetDatabase,
} from "~/test/integration/helpers";

const describeIntegration = integrationEnabled ? describe : describe.skip;

const today = () => format(new Date(), "yyyy-MM-dd");

async function seedUsage(
  teamId: number,
  domainId: number,
  rows: Array<{ date: string; type: "TRANSACTIONAL" | "MARKETING"; sent: number }>,
) {
  for (const row of rows) {
    await drizzleDb
      .insert(schema.dailyEmailUsage)
      .values(withUpdatedAt({ teamId, domainId, ...row }));
  }
}

describeIntegration("usage-service", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeIntegrationConnections();
  });

  it("sums sent per type for the month and the day", async () => {
    const team = await createTeam({ name: "usage" });

    await seedUsage(team.id, 1, [
      { date: today(), type: "TRANSACTIONAL", sent: 5 },
      { date: today(), type: "MARKETING", sent: 3 },
      { date: format(new Date(), "yyyy-MM-02"), type: "TRANSACTIONAL", sent: 7 },
    ]);

    const usage = await getThisMonthUsage(team.id);

    const month = Object.fromEntries(usage.month.map((r) => [r.type, r.sent]));
    const day = Object.fromEntries(usage.day.map((r) => [r.type, r.sent]));

    expect(month.TRANSACTIONAL).toBe(12);
    expect(month.MARKETING).toBe(3);
    expect(day.TRANSACTIONAL).toBe(5);
    expect(day.MARKETING).toBe(3);
  });

  it("returns sent as a number, not a bigint string", async () => {
    const team = await createTeam({ name: "cast" });
    await seedUsage(team.id, 1, [
      { date: today(), type: "TRANSACTIONAL", sent: 2 },
    ]);

    const usage = await getThisMonthUsage(team.id);

    // Postgres SUM over an integer column returns bigint, which the driver
    // hands back as a string without the ::integer cast.
    expect(typeof usage.day[0]?.sent).toBe("number");
    expect(usage.day[0]?.sent).toBe(2);
  });

  it("scopes the day total to exactly today, not today-and-later", async () => {
    const team = await createTeam({ name: "future" });
    const tomorrow = format(
      new Date(Date.now() + 24 * 60 * 60 * 1000),
      "yyyy-MM-dd",
    );

    await seedUsage(team.id, 1, [
      { date: today(), type: "TRANSACTIONAL", sent: 4 },
      { date: tomorrow, type: "TRANSACTIONAL", sent: 100 },
    ]);

    const usage = await getThisMonthUsage(team.id);

    // The day filter is equality. A `>= today` filter would fold the
    // future-dated row in here and inflate billing.
    expect(usage.day.find((r) => r.type === "TRANSACTIONAL")?.sent).toBe(4);

    // The month filter is a `>=` range, so it does include it — matching the
    // behaviour this replaced.
    expect(usage.month.find((r) => r.type === "TRANSACTIONAL")?.sent).toBe(104);
  });

  it("excludes another team's usage", async () => {
    const mine = await createTeam({ name: "mine" });
    const theirs = await createTeam({ name: "theirs" });

    await seedUsage(mine.id, 1, [
      { date: today(), type: "TRANSACTIONAL", sent: 1 },
    ]);
    await seedUsage(theirs.id, 1, [
      { date: today(), type: "TRANSACTIONAL", sent: 999 },
    ]);

    const usage = await getThisMonthUsage(mine.id);

    expect(usage.day.find((r) => r.type === "TRANSACTIONAL")?.sent).toBe(1);
  });

  it("uses the subscription period start for a paid plan", async () => {
    const team = await createTeam({ name: "paid", plan: "BASIC" });

    // Period started 3 days ago, so a 10-day-old row is outside the window.
    await drizzleDb.insert(schema.subscription).values(
      withUpdatedAt({
        id: "sub_1",
        teamId: team.id,
        status: "active",
        priceId: "price_1",
        currentPeriodStart: subDays(new Date(), 3),
      }),
    );

    await seedUsage(team.id, 1, [
      { date: format(subDays(new Date(), 10), "yyyy-MM-dd"), type: "TRANSACTIONAL", sent: 50 },
      { date: format(subDays(new Date(), 1), "yyyy-MM-dd"), type: "TRANSACTIONAL", sent: 8 },
    ]);

    const usage = await getThisMonthUsage(team.id);

    expect(usage.month.find((r) => r.type === "TRANSACTIONAL")?.sent).toBe(8);
  });

  it("throws when the team does not exist", async () => {
    await expect(getThisMonthUsage(999_999)).rejects.toThrow("Team not found");
  });
});
