import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzleDb, schema } from "~/server/drizzle";
import { withUpdatedAt } from "~/server/drizzle/touch";
import { createTeam } from "~/test/factories/core";
import {
  closeIntegrationConnections,
  integrationEnabled,
  resetDatabase,
} from "~/test/integration/helpers";

const {
  mockQueueEmail,
  mockQueueBulk,
  mockChangeDelay,
  mockCancelEmail,
  mockCheckMultipleEmails,
  mockValidateDomainFromEmail,
} = vi.hoisted(() => ({
  mockQueueEmail: vi.fn(),
  mockQueueBulk: vi.fn(),
  mockChangeDelay: vi.fn(),
  mockCancelEmail: vi.fn(),
  mockCheckMultipleEmails: vi.fn(),
  mockValidateDomainFromEmail: vi.fn(),
}));

vi.mock("~/server/mailer", () => ({
  sendMail: vi.fn(),
  sendTeamInviteEmail: vi.fn(),
  sendSignUpEmail: vi.fn(),
}));

vi.mock("~/server/service/email-queue-service", () => ({
  EmailQueueService: {
    queueEmail: mockQueueEmail,
    queueBulk: mockQueueBulk,
    changeDelay: mockChangeDelay,
    chancelEmail: mockCancelEmail,
  },
}));

vi.mock("~/server/service/suppression-service", () => ({
  SuppressionService: { checkMultipleEmails: mockCheckMultipleEmails },
}));

vi.mock("~/server/service/domain-service", () => ({
  validateDomainFromEmail: mockValidateDomainFromEmail,
  validateApiKeyDomainAccess: mockValidateDomainFromEmail,
}));

import {
  cancelEmail,
  sendBulkEmails,
  sendEmail,
  updateEmail,
} from "~/server/service/email-service";

const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration("email-service", () => {
  let teamId: number;
  let domainId: number;

  beforeEach(async () => {
    await resetDatabase();
    vi.clearAllMocks();
    mockCheckMultipleEmails.mockResolvedValue({});

    const team = await createTeam({ name: "email-team" });
    teamId = team.id;

    const [domain] = await drizzleDb
      .insert(schema.domain)
      .values(
        withUpdatedAt({
          name: "example.com",
          teamId,
          publicKey: "pk",
          region: "us-east-1",
          dkimSelector: "usesend",
        }),
      )
      .returning();
    domainId = domain!.id;
    mockValidateDomainFromEmail.mockResolvedValue(domain);
  });

  afterAll(async () => {
    await closeIntegrationConnections();
  });

  const base = {
    to: "to@example.com",
    from: "from@example.com",
    subject: "hello",
    text: "body",
    teamId: 0,
  };

  describe("sendEmail", () => {
    it("stores the email and queues it", async () => {
      const email = await sendEmail({ ...base, teamId });

      expect(email.id).toMatch(/^c[0-9a-z]{24}$/);
      expect(email.latestStatus).toBe("QUEUED");
      expect(email.to).toEqual(["to@example.com"]);
      expect(email.domainId).toBe(domainId);
      expect(mockQueueEmail).toHaveBeenCalledTimes(1);
    });

    it("leaves cc and bcc NULL when not supplied", async () => {
      const email = await sendEmail({ ...base, teamId });

      // `String[]` columns have no NOT NULL and no DEFAULT, so an omitted
      // value lands as NULL. Prisma hid that by reading NULL back as `[]`;
      // Drizzle reports what is actually stored. The pending
      // `NOT NULL DEFAULT '{}'` migration is what would make these `[]` for
      // real -- and would let the `?? []` coercions around the codebase go.
      const [stored] = await drizzleDb
        .select()
        .from(schema.email)
        .where(eq(schema.email.id, email.id))
        .limit(1);
      expect(stored?.cc).toBeNull();
      expect(stored?.bcc).toBeNull();
    });

    it("stores cc, bcc and replyTo when supplied", async () => {
      const email = await sendEmail({
        ...base,
        teamId,
        cc: ["cc@example.com"],
        bcc: ["bcc@example.com"],
        replyTo: "reply@example.com",
      });

      const [stored] = await drizzleDb
        .select()
        .from(schema.email)
        .where(eq(schema.email.id, email.id))
        .limit(1);
      expect(stored?.cc).toEqual(["cc@example.com"]);
      expect(stored?.bcc).toEqual(["bcc@example.com"]);
      expect(stored?.replyTo).toEqual(["reply@example.com"]);
    });

    it("marks the email SCHEDULED when scheduledAt is in the future", async () => {
      const when = new Date(Date.now() + 60 * 60 * 1000);
      const email = await sendEmail({
        ...base,
        teamId,
        scheduledAt: when.toISOString(),
      });

      expect(email.latestStatus).toBe("SCHEDULED");
      expect(email.scheduledAt?.getTime()).toBe(when.getTime());
    });

    it("suppresses the send when every TO recipient is suppressed", async () => {
      mockCheckMultipleEmails.mockResolvedValue({ "to@example.com": true });

      const email = await sendEmail({ ...base, teamId });

      expect(email.latestStatus).toBe("SUPPRESSED");
      expect(mockQueueEmail).not.toHaveBeenCalled();

      const events = await drizzleDb
        .select()
        .from(schema.emailEvent)
        .where(eq(schema.emailEvent.emailId, email.id));
      expect(events).toHaveLength(1);
      expect(events[0]?.status).toBe("SUPPRESSED");
    });

    it("drops suppressed cc recipients but still sends", async () => {
      mockCheckMultipleEmails.mockResolvedValue({ "cc@example.com": true });

      const email = await sendEmail({
        ...base,
        teamId,
        cc: ["cc@example.com", "ok@example.com"],
      });

      expect(email.latestStatus).toBe("QUEUED");
      const [stored] = await drizzleDb
        .select()
        .from(schema.email)
        .where(eq(schema.email.id, email.id))
        .limit(1);
      expect(stored?.cc).toEqual(["ok@example.com"]);
    });

    it("marks the email FAILED when queuing throws", async () => {
      mockQueueEmail.mockRejectedValue(new Error("queue down"));

      await expect(sendEmail({ ...base, teamId })).rejects.toThrow("queue down");

      const emails = await drizzleDb
        .select()
        .from(schema.email)
        .where(eq(schema.email.teamId, teamId));
      expect(emails[0]?.latestStatus).toBe("FAILED");
      const events = await drizzleDb.select().from(schema.emailEvent);
      expect(events[0]?.status).toBe("FAILED");
    });

    it("rejects an unknown inReplyTo", async () => {
      await expect(
        sendEmail({ ...base, teamId, inReplyToId: "nope" }),
      ).rejects.toThrow('"inReplyTo" is invalid');
    });

    it("rejects an inReplyTo belonging to another team", async () => {
      const other = await createTeam({ name: "other" });
      const [theirs] = await drizzleDb
        .insert(schema.email)
        .values(
          withUpdatedAt({
            id: "em_theirs",
            teamId: other.id,
            to: ["x@example.com"],
            from: "x@example.com",
            subject: "s",
            domainId,
          }),
        )
        .returning();

      await expect(
        sendEmail({ ...base, teamId, inReplyToId: theirs!.id }),
      ).rejects.toThrow('"inReplyTo" is invalid');
    });

    it("requires text or html", async () => {
      await expect(
        sendEmail({ ...base, teamId, text: undefined, html: undefined }),
      ).rejects.toThrow("Either text or html is required");
    });
  });

  describe("updateEmail", () => {
    it("reschedules a scheduled email", async () => {
      const email = await sendEmail({
        ...base,
        teamId,
        scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const next = new Date(Date.now() + 120_000);

      await updateEmail(email.id, { scheduledAt: next.toISOString() });

      const [stored] = await drizzleDb
        .select()
        .from(schema.email)
        .where(eq(schema.email.id, email.id))
        .limit(1);
      expect(stored?.scheduledAt?.getTime()).toBe(next.getTime());
      expect(mockChangeDelay).toHaveBeenCalledTimes(1);
    });

    it("refuses to reschedule an already processed email", async () => {
      const email = await sendEmail({ ...base, teamId });

      await expect(
        updateEmail(email.id, { scheduledAt: new Date().toISOString() }),
      ).rejects.toThrow("Email already processed");
    });
  });

  describe("cancelEmail", () => {
    it("cancels a scheduled email and records the event", async () => {
      const email = await sendEmail({
        ...base,
        teamId,
        scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      });

      await cancelEmail(email.id);

      const [stored] = await drizzleDb
        .select()
        .from(schema.email)
        .where(eq(schema.email.id, email.id))
        .limit(1);
      expect(stored?.latestStatus).toBe("CANCELLED");

      const events = await drizzleDb
        .select()
        .from(schema.emailEvent)
        .where(eq(schema.emailEvent.emailId, email.id));
      expect(events.map((e) => e.status)).toContain("CANCELLED");
    });

    it("refuses to cancel an already processed email", async () => {
      const email = await sendEmail({ ...base, teamId });

      await expect(cancelEmail(email.id)).rejects.toThrow(
        "Email already processed",
      );
    });
  });

  describe("sendBulkEmails", () => {
    it("creates one row per recipient and queues them together", async () => {
      const emails = await sendBulkEmails([
        { ...base, to: "a@example.com", teamId },
        { ...base, to: "b@example.com", teamId },
      ]);

      expect(emails).toHaveLength(2);
      expect(await drizzleDb.$count(schema.email)).toBe(2);
      expect(mockQueueBulk).toHaveBeenCalledTimes(1);
      expect(mockQueueBulk.mock.calls[0]![0]).toHaveLength(2);
    });

    it("keeps suppressed recipients in the result, in original order", async () => {
      mockCheckMultipleEmails.mockImplementation(async (emails: string[]) =>
        emails.includes("b@example.com") ? { "b@example.com": true } : {},
      );

      const emails = await sendBulkEmails([
        { ...base, to: "a@example.com", teamId },
        { ...base, to: "b@example.com", teamId },
        { ...base, to: "c@example.com", teamId },
      ]);

      // Email.to is a nullable array column, so Drizzle types it `string[] | null`.
      expect(emails.map((e) => e.to?.[0])).toEqual([
        "a@example.com",
        "b@example.com",
        "c@example.com",
      ]);
      const suppressed = emails.find((e) => e.to?.[0] === "b@example.com");
      expect(suppressed?.latestStatus).toBe("SUPPRESSED");
    });

    it("marks every created email FAILED when bulk queuing throws", async () => {
      mockQueueBulk.mockRejectedValue(new Error("bulk down"));

      await expect(
        sendBulkEmails([
          { ...base, to: "a@example.com", teamId },
          { ...base, to: "b@example.com", teamId },
        ]),
      ).rejects.toThrow("bulk down");

      const stored = await drizzleDb
        .select()
        .from(schema.email)
        .where(eq(schema.email.teamId, teamId));
      expect(stored).toHaveLength(2);
      expect(stored.every((e) => e.latestStatus === "FAILED")).toBe(true);
      expect(await drizzleDb.$count(schema.emailEvent)).toBe(2);
    });
  });
});
