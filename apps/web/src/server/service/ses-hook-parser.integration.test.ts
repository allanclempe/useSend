import { EmailStatus } from "~/types/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SesEvent } from "~/types/aws-types";
import { and, eq } from "drizzle-orm";
import { drizzleDb, schema } from "~/server/drizzle";
import { withUpdatedAt } from "~/server/drizzle/touch";
import { createTeam } from "~/test/factories/core";
import {
  closeIntegrationConnections,
  integrationEnabled,
  resetDatabase,
} from "~/test/integration/helpers";

const { mockWebhookEmit, mockUpdateCampaignAnalytics, mockAddSuppressions } =
  vi.hoisted(() => ({
    mockWebhookEmit: vi.fn(),
    mockUpdateCampaignAnalytics: vi.fn(),
    mockAddSuppressions: vi.fn(),
  }));

vi.mock("~/server/mailer", () => ({
  sendMail: vi.fn(),
  sendTeamInviteEmail: vi.fn(),
  sendSignUpEmail: vi.fn(),
}));

vi.mock("~/server/service/webhook-service", () => ({
  WebhookService: { emit: mockWebhookEmit },
}));

vi.mock("~/server/service/campaign-service", () => ({
  updateCampaignAnalytics: mockUpdateCampaignAnalytics,
  unsubscribeContact: vi.fn(),
}));

vi.mock("~/server/service/suppression-service", () => ({
  SuppressionService: {
    addSuppressions: mockAddSuppressions,
    checkMultipleEmails: vi.fn(async () => ({})),
  },
}));

vi.mock("~/server/queue/bullmq-driver", () => ({
  bullmqDriver: {
    createQueue: () => ({ enqueue: vi.fn(), schedule: vi.fn() }),
    createWorker: () => ({ concurrency: 1 }),
  },
}));

import { parseSesHook } from "~/server/service/ses-hook-parser";

const describeIntegration = integrationEnabled ? describe : describe.skip;

function buildEvent(
  eventType: "Open" | "Click" | "Delivery" | "Send",
  messageId: string,
  headers: Array<{ name: string; value: string }> = [],
): SesEvent {
  const event = {
    eventType,
    mail: {
      timestamp: "2026-07-13T01:00:00.000Z",
      source: "sender@example.com",
      messageId,
      destination: ["recipient@example.com"],
      headersTruncated: false,
      headers,
      commonHeaders: {
        from: ["sender@example.com"],
        to: ["recipient@example.com"],
        messageId: "message_1",
      },
      tags: {},
    },
  } as SesEvent;

  if (eventType === "Open") {
    event.open = {
      ipAddress: "192.0.2.1",
      timestamp: "2026-07-13T01:00:00.000Z",
      userAgent: "test-agent",
    };
  } else if (eventType === "Click") {
    event.click = {
      ipAddress: "192.0.2.1",
      timestamp: "2026-07-13T01:00:00.000Z",
      userAgent: "test-agent",
      link: "https://example.com",
      linkTags: {},
    };
  } else if (eventType === "Delivery") {
    event.delivery = {
      timestamp: "2026-07-13T01:00:00.000Z",
      processingTimeMillis: 10,
      recipients: ["recipient@example.com"],
      smtpResponse: "250 ok",
      reportingMTA: "mta",
    } as never;
  } else {
    event.send = {} as never;
  }

  return event;
}

describeIntegration("ses-hook-parser", () => {
  let teamId: number;
  let domainId: number;

  beforeEach(async () => {
    await resetDatabase();
    vi.clearAllMocks();
    mockWebhookEmit.mockResolvedValue(undefined);

    const team = await createTeam({ name: "ses-team" });
    teamId = team.id;
    const [domain] = await drizzleDb
      .insert(schema.domain)
      .values(
        withUpdatedAt({
          name: "ses.example.com",
          teamId,
          publicKey: "pk",
          region: "us-east-1",
          dkimSelector: "usesend",
        }),
      )
      .returning();
    domainId = domain!.id;
  });

  afterAll(async () => {
    await closeIntegrationConnections();
  });

  async function makeEmail(overrides: Record<string, unknown> = {}) {
    const [email] = await drizzleDb
      .insert(schema.email)
      .values(
        withUpdatedAt({
          id: `em_${Math.random().toString(36).slice(2, 10)}`,
          teamId,
          domainId,
          to: ["recipient@example.com"],
          from: "sender@example.com",
          subject: "Hello",
          latestStatus: "DELIVERED" as const,
          sesEmailId: `ses_${Math.random().toString(36).slice(2, 10)}`,
          ...overrides,
        }),
      )
      .returning();

    return email!;
  }

  async function usageRow() {
    const rows = await drizzleDb
      .select()
      .from(schema.dailyEmailUsage)
      .where(eq(schema.dailyEmailUsage.teamId, teamId));
    return rows[0];
  }

  describe("engagement dedup", () => {
    it.each([
      ["Open", EmailStatus.OPENED, "opened"],
      ["Click", EmailStatus.CLICKED, "clicked"],
    ] as const)(
      "counts only the first %s event for an email",
      async (eventType, status, field) => {
        const email = await makeEmail();
        const event = buildEvent(eventType, email.sesEmailId!);

        await parseSesHook(event);
        await parseSesHook(event);

        // Both events are recorded, but usage is counted once.
        const events = await drizzleDb
          .select()
          .from(schema.emailEvent)
          .where(
            and(
              eq(schema.emailEvent.emailId, email.id),
              eq(schema.emailEvent.status, status),
            ),
          );
        expect(events).toHaveLength(2);

        const usage = await usageRow();
        expect(usage?.[field]).toBe(1);
      },
    );

    it("counts a Delivery event every time", async () => {
      const email = await makeEmail({ latestStatus: "SENT" });
      const event = buildEvent("Delivery", email.sesEmailId!);

      await parseSesHook(event);
      await parseSesHook(event);

      // Dedup applies only to engagement events.
      const usage = await usageRow();
      expect(usage?.delivered).toBe(2);
    });
  });

  describe("latestStatus only moves forward", () => {
    it("does not downgrade a CLICKED email to DELIVERED", async () => {
      const email = await makeEmail({ latestStatus: "CLICKED" });

      await parseSesHook(buildEvent("Delivery", email.sesEmailId!));

      // SES events arrive out of order; the raw SQL CASE keeps the status
      // monotonic rather than letting a late event overwrite a later one.
      const [stored] = await drizzleDb
        .select()
        .from(schema.email)
        .where(eq(schema.email.id, email.id))
        .limit(1);
      expect(stored?.latestStatus).toBe("CLICKED");
    });

    it("upgrades a SENT email to DELIVERED", async () => {
      const email = await makeEmail({ latestStatus: "SENT" });

      await parseSesHook(buildEvent("Delivery", email.sesEmailId!));

      const [stored] = await drizzleDb
        .select()
        .from(schema.email)
        .where(eq(schema.email.id, email.id))
        .limit(1);
      expect(stored?.latestStatus).toBe("DELIVERED");
    });

    it("upgrades a SCHEDULED email regardless of ordering", async () => {
      const email = await makeEmail({ latestStatus: "SCHEDULED" });

      await parseSesHook(buildEvent("Delivery", email.sesEmailId!));

      const [stored] = await drizzleDb
        .select()
        .from(schema.email)
        .where(eq(schema.email.id, email.id))
        .limit(1);
      expect(stored?.latestStatus).toBe("DELIVERED");
    });
  });

  describe("Send events are no longer ours to handle", () => {
    // `SEND` is no longer subscribed, but SES keeps delivering for a while after
    // the configuration sets change and SNS can replay an old notification at
    // any time. `email-queue-service` already recorded all of this at the
    // handoff, so anything the parser did with a Send event now double-counts.
    it("does not touch latestStatus", async () => {
      const email = await makeEmail({ latestStatus: "QUEUED" });

      await expect(
        parseSesHook(buildEvent("Send", email.sesEmailId!)),
      ).resolves.toBe(true);

      const [stored] = await drizzleDb
        .select()
        .from(schema.email)
        .where(eq(schema.email.id, email.id))
        .limit(1);
      expect(stored?.latestStatus).toBe("QUEUED");
    });

    it("writes no EmailEvent, no usage and no webhook", async () => {
      const email = await makeEmail({ latestStatus: "QUEUED" });

      await parseSesHook(buildEvent("Send", email.sesEmailId!));

      const events = await drizzleDb
        .select()
        .from(schema.emailEvent)
        .where(eq(schema.emailEvent.emailId, email.id));

      expect(events).toHaveLength(0);
      expect(await usageRow()).toBeUndefined();
      expect(mockWebhookEmit).not.toHaveBeenCalled();
    });
  });

  describe("email lookup", () => {
    it("falls back to the custom header when sesEmailId is unknown", async () => {
      const email = await makeEmail({ sesEmailId: null });

      await parseSesHook(
        buildEvent("Delivery", "unknown_ses_id", [
          { name: "X-Usesend-Email-ID", value: email.id },
        ]),
      );

      // The race-condition path also backfills sesEmailId.
      const [stored] = await drizzleDb
        .select()
        .from(schema.email)
        .where(eq(schema.email.id, email.id))
        .limit(1);
      expect(stored?.sesEmailId).toBe("unknown_ses_id");
      expect(stored?.latestStatus).toBe("DELIVERED");
    });

    it("returns false when the email cannot be found", async () => {
      await expect(
        parseSesHook(buildEvent("Delivery", "nothing_matches")),
      ).resolves.toBe(false);
    });
  });

  describe("usage accounting", () => {
    it("keys usage by team, domain, date and type", async () => {
      const email = await makeEmail({ latestStatus: "SENT" });

      await parseSesHook(buildEvent("Delivery", email.sesEmailId!));

      const usage = await usageRow();
      expect(usage?.teamId).toBe(teamId);
      expect(usage?.domainId).toBe(domainId);
      expect(usage?.type).toBe("TRANSACTIONAL");
      expect(usage?.delivered).toBe(1);
      expect(usage?.opened).toBe(0);
    });

    it("accumulates cumulated metrics across events", async () => {
      const a = await makeEmail({ latestStatus: "SENT" });
      const b = await makeEmail({ latestStatus: "SENT" });

      await parseSesHook(buildEvent("Delivery", a.sesEmailId!));
      await parseSesHook(buildEvent("Delivery", b.sesEmailId!));

      const metrics = await drizzleDb
        .select()
        .from(schema.cumulatedMetrics)
        .where(eq(schema.cumulatedMetrics.teamId, teamId));
      expect(metrics).toHaveLength(1);
      // bigint column, read back as a number by the generated schema.
      expect(Number(metrics[0]?.delivered)).toBe(2);
    });
  });
});
