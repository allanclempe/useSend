import { format, subDays } from "date-fns";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzleDb, schema } from "~/server/drizzle";
import { withUpdatedAt } from "~/server/drizzle/touch";
import { createTeam } from "~/test/factories/core";
import {
  getThisMonthUsage,
  recordAcceptedSends,
  reverseAcceptedSend,
} from "~/server/service/usage-service";
import {
  closeIntegrationConnections,
  integrationEnabled,
  resetDatabase,
} from "~/test/integration/helpers";

const describeIntegration = integrationEnabled ? describe : describe.skip;

const today = () => format(new Date(), "yyyy-MM-dd");

/** The bucket `recordAcceptedSends` writes to, which is UTC rather than local. */
const utcToday = () => new Date().toISOString().split("T")[0] as string;

let emailSequence = 0;

async function createAcceptedEmail(
  teamId: number,
  overrides?: Partial<typeof schema.email.$inferInsert>,
) {
  emailSequence += 1;
  const [email] = await drizzleDb
    .insert(schema.email)
    .values(
      withUpdatedAt({
        id: `email-${emailSequence}`,
        from: "a@example.com",
        to: ["b@example.com"],
        subject: "hello",
        teamId,
        domainId: 1,
        ...overrides,
      }),
    )
    .returning();

  return email!;
}

async function sentFor(
  teamId: number,
  domainId: number,
  type: "TRANSACTIONAL" | "MARKETING",
  date = utcToday(),
) {
  const [row] = await drizzleDb
    .select({ sent: schema.dailyEmailUsage.sent })
    .from(schema.dailyEmailUsage)
    .where(
      and(
        eq(schema.dailyEmailUsage.teamId, teamId),
        eq(schema.dailyEmailUsage.domainId, domainId),
        eq(schema.dailyEmailUsage.type, type),
        eq(schema.dailyEmailUsage.date, date),
      ),
    );

  return row?.sent ?? null;
}

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

  describe("recordAcceptedSends", () => {
    it("counts an accepted send against today's transactional row", async () => {
      const team = await createTeam({ name: "accept" });
      const email = await createAcceptedEmail(team.id);

      const counted = await recordAcceptedSends([email.id]);

      expect(counted).toBe(1);
      expect(await sentFor(team.id, 1, "TRANSACTIONAL")).toBe(1);
    });

    it("counts once when the same email is accepted twice", async () => {
      const team = await createTeam({ name: "retry" });
      const email = await createAcceptedEmail(team.id);

      expect(await recordAcceptedSends([email.id])).toBe(1);
      // A retried enqueue. BullMQ would dedup this by `jobId`, but Cloudflare
      // Queues has no equivalent, so the guard has to hold without it.
      expect(await recordAcceptedSends([email.id])).toBe(0);

      expect(await sentFor(team.id, 1, "TRANSACTIONAL")).toBe(1);
    });

    it("counts a campaign email as marketing usage", async () => {
      const team = await createTeam({ name: "campaign" });
      const email = await createAcceptedEmail(team.id, {
        campaignId: "campaign-1",
      });

      await recordAcceptedSends([email.id]);

      expect(await sentFor(team.id, 1, "MARKETING")).toBe(1);
      expect(await sentFor(team.id, 1, "TRANSACTIONAL")).toBeNull();
    });

    it("splits one bulk call across domain and usage type", async () => {
      const team = await createTeam({ name: "bulk" });
      const emails = [
        await createAcceptedEmail(team.id, { domainId: 1 }),
        await createAcceptedEmail(team.id, { domainId: 1 }),
        await createAcceptedEmail(team.id, { domainId: 2 }),
        await createAcceptedEmail(team.id, {
          domainId: 1,
          campaignId: "campaign-2",
        }),
      ];

      const counted = await recordAcceptedSends(emails.map((e) => e.id));

      expect(counted).toBe(4);
      expect(await sentFor(team.id, 1, "TRANSACTIONAL")).toBe(2);
      expect(await sentFor(team.id, 2, "TRANSACTIONAL")).toBe(1);
      expect(await sentFor(team.id, 1, "MARKETING")).toBe(1);
    });

    it("ignores ids already counted while still counting the rest", async () => {
      const team = await createTeam({ name: "partial" });
      const first = await createAcceptedEmail(team.id);
      const second = await createAcceptedEmail(team.id);

      await recordAcceptedSends([first.id]);
      const counted = await recordAcceptedSends([first.id, second.id]);

      expect(counted).toBe(1);
      expect(await sentFor(team.id, 1, "TRANSACTIONAL")).toBe(2);
    });

    it("buckets an email with no domain under domain 0", async () => {
      const team = await createTeam({ name: "nodomain" });
      const email = await createAcceptedEmail(team.id, { domainId: null });

      await recordAcceptedSends([email.id]);

      expect(await sentFor(team.id, 0, "TRANSACTIONAL")).toBe(1);
    });

    it("adds to an existing row rather than replacing it", async () => {
      const team = await createTeam({ name: "existing" });
      await seedUsage(team.id, 1, [
        { date: utcToday(), type: "TRANSACTIONAL", sent: 9 },
      ]);
      const email = await createAcceptedEmail(team.id);

      await recordAcceptedSends([email.id]);

      expect(await sentFor(team.id, 1, "TRANSACTIONAL")).toBe(10);
    });

    it("does nothing for an empty list", async () => {
      expect(await recordAcceptedSends([])).toBe(0);
    });
  });

  describe("reverseAcceptedSend", () => {
    it("gives the count back for a send that never reached SES", async () => {
      const team = await createTeam({ name: "reverse" });
      const email = await createAcceptedEmail(team.id);
      await recordAcceptedSends([email.id]);

      expect(await reverseAcceptedSend(email.id)).toBe(true);
      expect(await sentFor(team.id, 1, "TRANSACTIONAL")).toBe(0);
    });

    it("reverses at most once, however many times it is called", async () => {
      const team = await createTeam({ name: "reverse-twice" });
      const email = await createAcceptedEmail(team.id);
      await recordAcceptedSends([email.id]);

      expect(await reverseAcceptedSend(email.id)).toBe(true);
      expect(await reverseAcceptedSend(email.id)).toBe(false);
      expect(await sentFor(team.id, 1, "TRANSACTIONAL")).toBe(0);
    });

    it("is a no-op for an email that was never counted", async () => {
      const team = await createTeam({ name: "never" });
      const email = await createAcceptedEmail(team.id);

      expect(await reverseAcceptedSend(email.id)).toBe(false);
      expect(await sentFor(team.id, 1, "TRANSACTIONAL")).toBeNull();
    });

    it("corrects the day the send was accepted, not today", async () => {
      const team = await createTeam({ name: "yesterday" });
      const email = await createAcceptedEmail(team.id);
      await recordAcceptedSends([email.id]);

      // Move the acceptance, and the row it landed on, back a day: a send
      // accepted at 23:59 and cancelled at 00:01 must not leave one day over
      // and the next under.
      const yesterday = format(subDays(new Date(), 1), "yyyy-MM-dd");
      await drizzleDb
        .update(schema.email)
        .set({ usageCountedAt: new Date(`${yesterday}T12:00:00Z`) })
        .where(eq(schema.email.id, email.id));
      await drizzleDb
        .delete(schema.dailyEmailUsage)
        .where(eq(schema.dailyEmailUsage.teamId, team.id));
      await seedUsage(team.id, 1, [
        { date: yesterday, type: "TRANSACTIONAL", sent: 4 },
        { date: utcToday(), type: "TRANSACTIONAL", sent: 7 },
      ]);

      expect(await reverseAcceptedSend(email.id)).toBe(true);

      expect(await sentFor(team.id, 1, "TRANSACTIONAL", yesterday)).toBe(3);
      expect(await sentFor(team.id, 1, "TRANSACTIONAL")).toBe(7);
    });

    it("never drives a counter negative", async () => {
      const team = await createTeam({ name: "floor" });
      const email = await createAcceptedEmail(team.id);
      await recordAcceptedSends([email.id]);

      // Something else already zeroed the row.
      await drizzleDb
        .update(schema.dailyEmailUsage)
        .set(withUpdatedAt({ sent: 0 }))
        .where(eq(schema.dailyEmailUsage.teamId, team.id));

      await reverseAcceptedSend(email.id);

      expect(await sentFor(team.id, 1, "TRANSACTIONAL")).toBe(0);
    });
  });
});
