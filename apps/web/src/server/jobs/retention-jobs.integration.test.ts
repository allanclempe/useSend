import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Pulled in transitively; usesend-js is an unbuilt workspace package, so
// resolving it fails in the test runner.
vi.mock("~/server/mailer", () => ({
  sendMail: vi.fn(),
  sendTeamInviteEmail: vi.fn(),
  sendSignUpEmail: vi.fn(),
}));

import { drizzleDb, schema } from "~/server/drizzle";
import { withUpdatedAt } from "~/server/drizzle/touch";
import { deleteExpiredEmailEvents } from "~/server/jobs/email-event-cleanup-job";
import { deleteExpiredWebhookCalls } from "~/server/jobs/webhook-cleanup-job";
import { createTeam } from "~/test/factories/core";
import {
  closeIntegrationConnections,
  integrationEnabled,
  resetDatabase,
} from "~/test/integration/helpers";

const describeIntegration = integrationEnabled ? describe : describe.skip;

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

describeIntegration("retention jobs", () => {
  let teamId: number;

  beforeEach(async () => {
    await resetDatabase();
    const team = await createTeam({ name: "retention" });
    teamId = team.id;
  });

  afterAll(async () => {
    await closeIntegrationConnections();
  });

  describe("deleteExpiredEmailEvents", () => {
    async function seedEvent(id: string, createdAt: Date) {
      const [email] = await drizzleDb
        .insert(schema.email)
        .values(
          withUpdatedAt({
            id: `em_${id}`,
            teamId,
            to: ["to@example.com"],
            from: "from@example.com",
            subject: "s",
          }),
        )
        .returning();

      await drizzleDb.insert(schema.emailEvent).values({
        id,
        emailId: email!.id,
        status: "DELIVERED",
        teamId,
        createdAt,
      });
    }

    it("deletes only events older than the window", async () => {
      await seedEvent("old", daysAgo(100));
      await seedEvent("recent", daysAgo(10));

      const deleted = await deleteExpiredEmailEvents(90);

      expect(deleted).toBe(1);
      const remaining = await drizzleDb.select().from(schema.emailEvent);
      expect(remaining.map((e) => e.id)).toEqual(["recent"]);
    });

    it("measures the window from when the job runs, not from midnight", async () => {
      // The cutoff is a timestamp rather than a calendar date, and it is taken
      // when the job runs -- after this row was written. So a row aged exactly
      // 90 days at seed time is already fractionally older than the cutoff and
      // goes. Retention is "older than N x 24h as of right now", which is what
      // an operator setting the window should expect.
      await seedEvent("boundary", daysAgo(90));
      await seedEvent("inside", daysAgo(89));

      const deleted = await deleteExpiredEmailEvents(90);

      expect(deleted).toBe(1);
      const remaining = await drizzleDb.select().from(schema.emailEvent);
      expect(remaining.map((e) => e.id)).toEqual(["inside"]);
    });

    it("leaves the emails themselves alone", async () => {
      await seedEvent("old", daysAgo(100));

      await deleteExpiredEmailEvents(90);

      expect(await drizzleDb.$count(schema.email)).toBe(1);
    });

    it("keeps deleting past the first batch", async () => {
      // The delete is batched so the first run on a years-old install does not
      // hold one transaction over the whole table. Five expired rows and a
      // batch of two means three round trips, the last one short.
      for (let i = 0; i < 5; i++) {
        await seedEvent(`old_${i}`, daysAgo(100 + i));
      }
      await seedEvent("recent", daysAgo(10));

      const deleted = await deleteExpiredEmailEvents(90, 2);

      expect(deleted).toBe(5);
      const remaining = await drizzleDb.select().from(schema.emailEvent);
      expect(remaining.map((e) => e.id)).toEqual(["recent"]);
    });

    it("stops cleanly when a full batch empties the table", async () => {
      // Batch size divides the row count exactly: the loop has to make one more
      // round trip, see zero rows and stop, rather than spinning.
      await seedEvent("old_a", daysAgo(100));
      await seedEvent("old_b", daysAgo(101));

      const deleted = await deleteExpiredEmailEvents(90, 2);

      expect(deleted).toBe(2);
      expect(await drizzleDb.$count(schema.emailEvent)).toBe(0);
    });
  });

  describe("deleteExpiredWebhookCalls", () => {
    async function seedCall(id: string, createdAt: Date) {
      const [webhook] = await drizzleDb
        .insert(schema.webhook)
        .values(
          withUpdatedAt({
            id: `wh_${id}`,
            teamId,
            url: "https://example.com/hook",
            secret: "whsec_test",
            eventTypes: ["email.delivered"],
          }),
        )
        .returning();

      await drizzleDb.insert(schema.webhookCall).values(
        withUpdatedAt({
          id,
          webhookId: webhook!.id,
          teamId,
          type: "email.delivered",
          payload: "{}",
          attempt: 0,
          createdAt,
        }),
      );
    }

    it("deletes only calls older than the window", async () => {
      await seedCall("old", daysAgo(45));
      await seedCall("recent", daysAgo(5));

      const deleted = await deleteExpiredWebhookCalls(30);

      expect(deleted).toBe(1);
      const remaining = await drizzleDb.select().from(schema.webhookCall);
      expect(remaining.map((c) => c.id)).toEqual(["recent"]);
    });

    it("leaves the webhooks themselves alone", async () => {
      await seedCall("old", daysAgo(45));

      await deleteExpiredWebhookCalls(30);

      expect(await drizzleDb.$count(schema.webhook)).toBe(1);
    });
  });
});
