import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "~/server/db";
import {
  closeIntegrationConnections,
  integrationEnabled,
  resetDatabase,
} from "~/test/integration/helpers";

const {
  capturedBatchHandler,
  mockQueueEmail,
  mockCheckMultipleEmails,
  mockBatchEnqueue,
} = vi.hoisted(() => ({
  capturedBatchHandler: { fn: null as any },
  mockQueueEmail: vi.fn(),
  mockCheckMultipleEmails: vi.fn(),
  mockBatchEnqueue: vi.fn(),
}));

vi.mock("~/server/mailer", () => ({
  sendMail: vi.fn(),
  sendTeamInviteEmail: vi.fn(),
  sendSignUpEmail: vi.fn(),
}));

vi.mock("~/server/service/email-queue-service", () => ({
  EmailQueueService: { queueEmail: mockQueueEmail },
}));

vi.mock("~/server/service/suppression-service", () => ({
  SuppressionService: { checkMultipleEmails: mockCheckMultipleEmails },
}));

vi.mock("~/server/queue/bullmq-driver", () => ({
  bullmqDriver: {
    createQueue: () => ({ enqueue: mockBatchEnqueue, schedule: vi.fn() }),
    createWorker: (_name: string, handler: any) => {
      capturedBatchHandler.fn = handler;
      return { concurrency: 1 };
    },
  },
}));

import {
  CampaignBatchService,
  recordCampaignContactFailure,
  updateCampaignAnalytics,
} from "~/server/service/campaign-service";

const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration("campaign batch", () => {
  let teamId: number;
  let contactBookId: string;
  let domainId: number;

  beforeEach(async () => {
    await resetDatabase();
    vi.clearAllMocks();
    mockCheckMultipleEmails.mockResolvedValue(new Map());

    const team = await db.team.create({ data: { name: "batch-team" } });
    teamId = team.id;
    const book = await db.contactBook.create({
      data: { id: "book_b", name: "book", teamId, properties: {} },
    });
    contactBookId = book.id;
    const domain = await db.domain.create({
      data: {
        name: "batch.example.com",
        teamId,
        publicKey: "pk",
        region: "us-east-1",
        dkimSelector: "usesend",
      },
    });
    domainId = domain.id;
  });

  afterAll(async () => {
    await closeIntegrationConnections();
  });

  async function makeCampaign(overrides: Record<string, unknown> = {}) {
    return db.campaign.create({
      data: {
        id: `camp_${Math.random().toString(36).slice(2, 10)}`,
        name: "camp",
        teamId,
        from: "hi@batch.example.com",
        subject: "hello",
        contactBookId,
        domainId,
        html: `<p>hi <a href="{{usesend_unsubscribe_url}}">unsub</a></p>`,
        ...overrides,
      },
    });
  }

  async function makeContact(id: string) {
    return db.contact.create({
      data: {
        id,
        contactBookId,
        email: `${id}@example.com`,
        properties: {},
        subscribed: true,
      },
    });
  }

  const failureInput = (campaign: any, contact: any) => ({
    contact: { id: contact.id, email: contact.email },
    campaign: {
      id: campaign.id,
      from: campaign.from,
      subject: campaign.subject,
      html: campaign.html,
      previewText: campaign.previewText,
    },
    emailConfig: { teamId, domainId },
    error: new Error("smtp exploded"),
  });

  describe("recordCampaignContactFailure", () => {
    it("marks an existing campaign email as failed and records the error", async () => {
      const campaign = await makeCampaign();
      const contact = await makeContact("f_1");
      const email = await db.email.create({
        data: {
          id: "em_existing",
          teamId,
          to: [contact.email],
          from: campaign.from,
          subject: campaign.subject,
          domainId,
          campaignId: campaign.id,
          contactId: contact.id,
        },
      });
      await db.campaignEmail.create({
        data: {
          campaignId: campaign.id,
          contactId: contact.id,
          emailId: email.id,
        },
      });

      await recordCampaignContactFailure(failureInput(campaign, contact));

      const stored = await db.email.findUnique({ where: { id: email.id } });
      expect(stored?.latestStatus).toBe("FAILED");

      const events = await db.emailEvent.findMany({
        where: { emailId: email.id },
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.status).toBe("FAILED");
      expect(events[0]?.data).toMatchObject({ error: "smtp exploded" });

      // No duplicate link created for an email that already had one.
      expect(await db.campaignEmail.count()).toBe(1);
    });

    it("creates a failed email and campaign link when processing failed before persistence", async () => {
      const campaign = await makeCampaign();
      const contact = await makeContact("f_2");

      await recordCampaignContactFailure(failureInput(campaign, contact));

      const emails = await db.email.findMany({ where: { teamId } });
      expect(emails).toHaveLength(1);
      expect(emails[0]?.latestStatus).toBe("FAILED");
      expect(emails[0]?.to).toEqual([contact.email]);

      const links = await db.campaignEmail.findMany({});
      expect(links).toHaveLength(1);
      expect(links[0]?.emailId).toBe(emails[0]?.id);
    });

    it("reuses an email created before campaign linking failed", async () => {
      const campaign = await makeCampaign();
      const contact = await makeContact("f_3");
      const orphan = await db.email.create({
        data: {
          id: "em_orphan",
          teamId,
          to: [contact.email],
          from: campaign.from,
          subject: campaign.subject,
          domainId,
          campaignId: campaign.id,
          contactId: contact.id,
        },
      });

      await recordCampaignContactFailure(failureInput(campaign, contact));

      // The orphaned email is adopted rather than a second one created.
      expect(await db.email.count()).toBe(1);
      const links = await db.campaignEmail.findMany({});
      expect(links).toHaveLength(1);
      expect(links[0]?.emailId).toBe(orphan.id);
    });
  });

  describe("updateCampaignAnalytics", () => {
    it("increments the counter matching the status", async () => {
      const campaign = await makeCampaign();

      await updateCampaignAnalytics(campaign.id, "DELIVERED");
      await updateCampaignAnalytics(campaign.id, "OPENED");
      await updateCampaignAnalytics(campaign.id, "BOUNCED", true);

      const stored = await db.campaign.findUnique({
        where: { id: campaign.id },
      });
      expect(stored?.delivered).toBe(1);
      expect(stored?.opened).toBe(1);
      expect(stored?.bounced).toBe(1);
      expect(stored?.hardBounced).toBe(1);
      expect(stored?.clicked).toBe(0);
    });

    it("does not write for a status with no counter", async () => {
      const campaign = await makeCampaign();

      // An empty SET is invalid SQL, where Prisma accepted it as a no-op.
      await expect(
        updateCampaignAnalytics(campaign.id, "QUEUED"),
      ).resolves.toBeUndefined();
    });

    it("counts concurrent events without losing any", async () => {
      const campaign = await makeCampaign();

      await Promise.all(
        Array.from({ length: 10 }, () =>
          updateCampaignAnalytics(campaign.id, "DELIVERED"),
        ),
      );

      const stored = await db.campaign.findUnique({
        where: { id: campaign.id },
      });
      expect(stored?.delivered).toBe(10);
    });
  });

  describe("batch worker", () => {
    async function runBatch(campaignId: string) {
      if (!capturedBatchHandler.fn) throw new Error("handler not captured");
      return capturedBatchHandler.fn({ data: { campaignId, teamId } });
    }

    it("sends one batch, advances the cursor and queues each email", async () => {
      const campaign = await makeCampaign({
        status: "SCHEDULED",
        batchSize: 2,
      });
      await makeContact("b_1");
      await makeContact("b_2");
      await makeContact("b_3");

      await runBatch(campaign.id);

      const stored = await db.campaign.findUnique({
        where: { id: campaign.id },
      });
      expect(stored?.status).toBe("RUNNING");
      expect(stored?.lastCursor).toBe("b_2");
      expect(mockQueueEmail).toHaveBeenCalledTimes(2);
      expect(await db.campaignEmail.count()).toBe(2);
    });

    it("resumes after the cursor without repeating contacts", async () => {
      const campaign = await makeCampaign({
        status: "RUNNING",
        batchSize: 2,
        lastCursor: "b_2",
      });
      await makeContact("b_1");
      await makeContact("b_2");
      await makeContact("b_3");

      await runBatch(campaign.id);

      const links = await db.campaignEmail.findMany({});
      expect(links.map((l) => l.contactId)).toEqual(["b_3"]);
    });

    it("marks the campaign SENT when no contacts remain", async () => {
      const campaign = await makeCampaign({
        status: "RUNNING",
        lastCursor: "b_9",
      });
      await makeContact("b_1");

      await runBatch(campaign.id);

      const stored = await db.campaign.findUnique({
        where: { id: campaign.id },
      });
      expect(stored?.status).toBe("SENT");
    });

    it("skips contacts that already have a campaign email", async () => {
      const campaign = await makeCampaign({ status: "RUNNING" });
      const contact = await makeContact("b_dup");
      const email = await db.email.create({
        data: {
          id: "em_dup",
          teamId,
          to: [contact.email],
          from: campaign.from,
          subject: campaign.subject,
          domainId,
        },
      });
      await db.campaignEmail.create({
        data: {
          campaignId: campaign.id,
          contactId: contact.id,
          emailId: email.id,
        },
      });

      await runBatch(campaign.id);

      expect(mockQueueEmail).not.toHaveBeenCalled();
      expect(await db.campaignEmail.count()).toBe(1);
    });

    it("does nothing for a paused campaign", async () => {
      const campaign = await makeCampaign({ status: "PAUSED" });
      await makeContact("b_paused");

      await runBatch(campaign.id);

      expect(mockQueueEmail).not.toHaveBeenCalled();
      expect(await db.campaignEmail.count()).toBe(0);
    });
  });

  describe("queueBatch", () => {
    it("enqueues with a stable, queue-safe job id", async () => {
      const campaign = await makeCampaign({
        status: "SCHEDULED",
        batchWindowMinutes: 0,
      });

      await CampaignBatchService.queueBatch({ campaignId: campaign.id, teamId });

      // The job id is what makes re-queuing the same campaign idempotent.
      expect(mockBatchEnqueue).toHaveBeenCalledWith(
        `campaign-${campaign.id}`,
        { campaignId: campaign.id, teamId },
        expect.objectContaining({ jobId: `campaign-batch-${campaign.id}` }),
      );
    });

    it("skips when the batch window has not elapsed", async () => {
      const campaign = await makeCampaign({
        status: "RUNNING",
        batchWindowMinutes: 60,
        lastSentAt: new Date(),
      });

      await CampaignBatchService.queueBatch({ campaignId: campaign.id, teamId });

      expect(mockBatchEnqueue).not.toHaveBeenCalled();
    });

    it("skips a campaign that is already SENT", async () => {
      const campaign = await makeCampaign({ status: "SENT" });

      await CampaignBatchService.queueBatch({ campaignId: campaign.id, teamId });

      expect(mockBatchEnqueue).not.toHaveBeenCalled();
    });
  });
});
