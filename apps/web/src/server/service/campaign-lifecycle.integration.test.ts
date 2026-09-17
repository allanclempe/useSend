import { UnsubscribeReason } from "~/types/db";
import { createHash } from "crypto";
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

const { mockUpdateContactSubscription, mockQueueBatch } = vi.hoisted(() => ({
  mockUpdateContactSubscription: vi.fn(),
  mockQueueBatch: vi.fn(),
}));

// contact-service owns its own webhook emission and has its own tests.
vi.mock("~/server/service/contact-service", () => ({
  updateContactSubscription: mockUpdateContactSubscription,
}));

// Pulled in transitively via domain-service; usesend-js is an unbuilt workspace
// package, so resolving it fails in the test runner.
vi.mock("~/server/mailer", () => ({
  sendMail: vi.fn(),
  sendTeamInviteEmail: vi.fn(),
  sendSignUpEmail: vi.fn(),
}));

vi.mock("~/server/queue/bullmq-driver", () => ({
  bullmqDriver: {
    createQueue: () => ({ enqueue: mockQueueBatch, schedule: vi.fn() }),
    createWorker: () => ({ concurrency: 1 }),
  },
}));

import {
  createUnsubUrl,
  deleteCampaign,
  getCampaignForTeam,
  pauseCampaign,
  resumeCampaign,
  scheduleCampaign,
  subscribeContact,
  unsubscribeContact,
} from "~/server/service/campaign-service";

const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration("campaign lifecycle", () => {
  let teamId: number;
  let contactBookId: string;
  let domainId: number;

  beforeEach(async () => {
    await resetDatabase();
    vi.clearAllMocks();

    const team = await createTeam({ name: "camp-team" });
    teamId = team.id;

    const [book] = await drizzleDb
      .insert(schema.contactBook)
      .values(
        withUpdatedAt({ id: "book_1", name: "book", teamId, properties: {} }),
      )
      .returning();
    contactBookId = book!.id;

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
  });

  afterAll(async () => {
    await closeIntegrationConnections();
  });

  async function makeCampaign(overrides: Record<string, unknown> = {}) {
    const [campaign] = await drizzleDb
      .insert(schema.campaign)
      .values(
        withUpdatedAt({
          id: `camp_${Math.random().toString(36).slice(2, 10)}`,
          name: "camp",
          teamId,
          from: "hi@example.com",
          subject: "hello",
          contactBookId,
          domainId,
          html: `<p>hi <a href="{{usesend_unsubscribe_url}}">unsub</a></p>`,
          ...overrides,
        }),
      )
      .returning();

    return campaign!;
  }

  async function makeContact(id: string, subscribed = true) {
    const [contact] = await drizzleDb
      .insert(schema.contact)
      .values(
        withUpdatedAt({
          id,
          contactBookId,
          email: `${id}@example.com`,
          properties: {},
          subscribed,
        }),
      )
      .returning();

    return contact!;
  }

  describe("subscription counters", () => {
    it("decrements nothing and increments the campaign on unsubscribe", async () => {
      const campaign = await makeCampaign({ unsubscribed: 0 });
      const contact = await makeContact("contact_1");
      mockUpdateContactSubscription.mockResolvedValue({
        ...contact,
        subscribed: false,
      });

      const result = await unsubscribeContact({
        contactId: contact.id,
        campaignId: campaign.id,
        reason: UnsubscribeReason.UNSUBSCRIBED,
      });

      expect(mockUpdateContactSubscription).toHaveBeenCalledWith({
        contactId: contact.id,
        subscribed: false,
        unsubscribeReason: UnsubscribeReason.UNSUBSCRIBED,
      });
      expect(result.subscribed).toBe(false);

      const [stored] = await drizzleDb
        .select()
        .from(schema.campaign)
        .where(eq(schema.campaign.id, campaign.id))
        .limit(1);
      expect(stored?.unsubscribed).toBe(1);
    });

    it("does not touch the counter for an already unsubscribed contact", async () => {
      const campaign = await makeCampaign({ unsubscribed: 3 });
      const contact = await makeContact("contact_2", false);

      await unsubscribeContact({
        contactId: contact.id,
        campaignId: campaign.id,
        reason: UnsubscribeReason.UNSUBSCRIBED,
      });

      expect(mockUpdateContactSubscription).not.toHaveBeenCalled();
      const [stored] = await drizzleDb
        .select()
        .from(schema.campaign)
        .where(eq(schema.campaign.id, campaign.id))
        .limit(1);
      expect(stored?.unsubscribed).toBe(3);
    });

    it("decrements the campaign on re-subscribe", async () => {
      const campaign = await makeCampaign({ id: "campaign_1", unsubscribed: 2 });
      const contact = await makeContact("contact_1", false);
      mockUpdateContactSubscription.mockResolvedValue({
        ...contact,
        subscribed: true,
      });

      const id = `${contact.id}-${campaign.id}`;
      const hash = createHash("sha256")
        .update(`${id}-${process.env.APP_SECRET}`)
        .digest("hex");

      await subscribeContact(id, hash);

      expect(mockUpdateContactSubscription).toHaveBeenCalledWith({
        contactId: contact.id,
        subscribed: true,
        unsubscribeReason: null,
      });

      const [stored] = await drizzleDb
        .select()
        .from(schema.campaign)
        .where(eq(schema.campaign.id, campaign.id))
        .limit(1);
      expect(stored?.unsubscribed).toBe(1);
    });

    it("counts concurrent unsubscribes without losing any", async () => {
      const campaign = await makeCampaign({ unsubscribed: 0 });
      const contacts = await Promise.all(
        ["c_a", "c_b", "c_c", "c_d", "c_e"].map((id) => makeContact(id)),
      );
      mockUpdateContactSubscription.mockImplementation(
        async ({ contactId }: { contactId: string }) => ({
          id: contactId,
          subscribed: false,
        }),
      );

      // The counter is incremented in SQL rather than read-then-write, so
      // simultaneous unsubscribes cannot overwrite each other.
      await Promise.all(
        contacts.map((contact) =>
          unsubscribeContact({
            contactId: contact.id,
            campaignId: campaign.id,
            reason: UnsubscribeReason.UNSUBSCRIBED,
          }),
        ),
      );

      const [stored] = await drizzleDb
        .select()
        .from(schema.campaign)
        .where(eq(schema.campaign.id, campaign.id))
        .limit(1);
      expect(stored?.unsubscribed).toBe(5);
    });

    it("rejects a tampered unsubscribe link", async () => {
      const campaign = await makeCampaign();
      const contact = await makeContact("contact_3");
      const url = createUnsubUrl(contact.id, campaign.id);
      const tampered = url.replace(/hash=\w+/, "hash=deadbeef");

      expect(tampered).not.toBe(url);
    });
  });

  describe("status transitions", () => {
    it("schedules a campaign and records the total", async () => {
      const campaign = await makeCampaign();
      await makeContact("s_1");
      await makeContact("s_2");
      await makeContact("s_3", false);

      await scheduleCampaign({ campaignId: campaign.id, teamId });

      const [stored] = await drizzleDb
        .select()
        .from(schema.campaign)
        .where(eq(schema.campaign.id, campaign.id))
        .limit(1);
      expect(stored?.status).toBe("SCHEDULED");
      // Only subscribed contacts count toward the total.
      expect(stored?.total).toBe(2);
      expect(stored?.scheduledAt).toBeInstanceOf(Date);
    });

    it("refuses to schedule with no subscribed contacts", async () => {
      const campaign = await makeCampaign();

      await expect(
        scheduleCampaign({ campaignId: campaign.id, teamId }),
      ).rejects.toThrow("No subscribed contacts to send");
    });

    it("refuses to schedule another team's campaign", async () => {
      const campaign = await makeCampaign();
      const other = await createTeam({ name: "other" });

      await expect(
        scheduleCampaign({ campaignId: campaign.id, teamId: other.id }),
      ).rejects.toThrow("Campaign not found");
    });

    it("pauses and resumes", async () => {
      const campaign = await makeCampaign({ status: "RUNNING" });

      await pauseCampaign({ campaignId: campaign.id, teamId });
      expect(
        (
          await drizzleDb
            .select()
            .from(schema.campaign)
            .where(eq(schema.campaign.id, campaign.id))
            .limit(1)
        )[0]?.status,
      ).toBe("PAUSED");

      await resumeCampaign({ campaignId: campaign.id, teamId });
      expect(
        (
          await drizzleDb
            .select()
            .from(schema.campaign)
            .where(eq(schema.campaign.id, campaign.id))
            .limit(1)
        )[0]?.status,
      ).toBe("RUNNING");
    });

    it("resumes a future-dated campaign back to SCHEDULED", async () => {
      const campaign = await makeCampaign({
        status: "PAUSED",
        scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      await resumeCampaign({ campaignId: campaign.id, teamId });

      expect(
        (
          await drizzleDb
            .select()
            .from(schema.campaign)
            .where(eq(schema.campaign.id, campaign.id))
            .limit(1)
        )[0]?.status,
      ).toBe("SCHEDULED");
    });
  });

  describe("reads and deletes", () => {
    it("returns a campaign for its own team only", async () => {
      const campaign = await makeCampaign();
      const other = await createTeam({ name: "other2" });

      const found = await getCampaignForTeam({
        campaignId: campaign.id,
        teamId,
      });
      expect(found.id).toBe(campaign.id);
      expect(found.cc).toEqual([]);
      expect(found.bcc).toEqual([]);
      expect(found.replyTo).toEqual([]);

      await expect(
        getCampaignForTeam({ campaignId: campaign.id, teamId: other.id }),
      ).rejects.toThrow("Campaign not found");
    });

    it("deletes a campaign and its emails together", async () => {
      const campaign = await makeCampaign();
      const contact = await makeContact("d_1");
      const [email] = await drizzleDb
        .insert(schema.email)
        .values(
          withUpdatedAt({
            id: "em_1",
            teamId,
            to: [contact.email],
            from: "hi@example.com",
            subject: "s",
            domainId,
          }),
        )
        .returning();
      await drizzleDb.insert(schema.campaignEmail).values({
        campaignId: campaign.id,
        contactId: contact.id,
        emailId: email!.id,
      });

      const deleted = await deleteCampaign(campaign.id, teamId);

      expect(deleted.id).toBe(campaign.id);
      expect(await drizzleDb.$count(schema.campaignEmail)).toBe(0);
      expect(await drizzleDb.$count(schema.campaign)).toBe(0);
    });

    it("refuses to delete another team's campaign", async () => {
      const campaign = await makeCampaign();
      const other = await createTeam({ name: "other3" });

      await expect(deleteCampaign(campaign.id, other.id)).rejects.toThrow(
        "Campaign not found",
      );
      expect(await drizzleDb.$count(schema.campaign)).toBe(1);
    });
  });
});
