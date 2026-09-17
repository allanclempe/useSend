import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockTx, mockUpdateContactSubscription } = vi.hoisted(() => {
  const mockTx = {
    campaignEmail: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    email: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    emailEvent: {
      create: vi.fn(),
    },
  };

  return {
    mockTx,
    mockDb: {
      $transaction: vi.fn(async (callback: ReturnType<typeof vi.fn>) =>
        callback(mockTx),
      ),
      contact: {
        findUnique: vi.fn(),
      },
      campaign: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
    },
    mockUpdateContactSubscription: vi.fn(),
  };
});

const { mockQueueAdd } = vi.hoisted(() => ({
  mockQueueAdd: vi.fn(),
}));

vi.mock("~/server/db", () => ({
  db: mockDb,
}));

vi.mock("@usesend/email-editor/src/renderer", () => ({
  EmailRenderer: vi.fn(),
}));

vi.mock("~/env", () => ({
  env: {
    NEXTAUTH_SECRET: "test-secret",
  },
}));

vi.mock("~/server/service/contact-service", () => ({
  updateContactSubscription: mockUpdateContactSubscription,
}));

// Mock the driver, not the queue module — the interface and constants stay real.
vi.mock("~/server/queue/bullmq-driver", () => ({
  bullmqDriver: {
    createQueue: () => ({ enqueue: mockQueueAdd }),
    createWorker: () => ({ concurrency: 1 }),
  },
}));

vi.mock("~/server/redis", () => ({
  getRedis: vi.fn(() => ({})),
  BULL_PREFIX: "test",
}));

vi.mock("~/server/service/email-queue-service", () => ({
  EmailQueueService: {},
}));

vi.mock("~/server/service/suppression-service", () => ({
  SuppressionService: {},
}));

vi.mock("~/server/service/domain-service", () => ({
  validateApiKeyDomainAccess: vi.fn(),
  validateDomainFromEmail: vi.fn(),
}));

vi.mock("~/server/logger/log", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import {
  CampaignBatchService,
  recordCampaignContactFailure,
} from "~/server/service/campaign-service";

const input = {
  contact: {
    id: "contact_1",
    email: "alice@example.com",
  },
  campaign: {
    id: "campaign_1",
    from: "sender@example.com",
    subject: "Hello",
    html: "<p>Hello</p>",
    previewText: "Preview",
  },
  emailConfig: {
    replyTo: ["reply@example.com"],
    cc: [],
    bcc: [],
    teamId: 7,
    domainId: 11,
  },
  error: new Error("Queue for region ap-southeast-2 not found"),
};

describe("recordCampaignContactFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks an existing campaign email as failed and records the error", async () => {
    mockTx.campaignEmail.findUnique.mockResolvedValue({ emailId: "email_1" });

    await recordCampaignContactFailure(input);

    expect(mockTx.email.create).not.toHaveBeenCalled();
    expect(mockTx.email.update).toHaveBeenCalledWith({
      where: { id: "email_1" },
      data: { latestStatus: "FAILED" },
    });
    expect(mockTx.emailEvent.create).toHaveBeenCalledWith({
      data: {
        emailId: "email_1",
        status: "FAILED",
        data: { error: "Queue for region ap-southeast-2 not found" },
        teamId: 7,
      },
    });
  });

  it("creates a failed email and campaign link when processing failed before persistence", async () => {
    mockTx.campaignEmail.findUnique.mockResolvedValue(null);
    mockTx.email.findFirst.mockResolvedValue(null);
    mockTx.email.create.mockResolvedValue({ id: "email_2" });

    await recordCampaignContactFailure(input);

    expect(mockTx.email.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        to: ["alice@example.com"],
        campaignId: "campaign_1",
        contactId: "contact_1",
        latestStatus: "FAILED",
      }),
      select: { id: true },
    });
    expect(mockTx.campaignEmail.create).toHaveBeenCalledWith({
      data: {
        campaignId: "campaign_1",
        contactId: "contact_1",
        emailId: "email_2",
      },
    });
    expect(mockTx.emailEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        emailId: "email_2",
        status: "FAILED",
      }),
    });
  });

  it("reuses an email created before campaign linking failed", async () => {
    mockTx.campaignEmail.findUnique.mockResolvedValue(null);
    mockTx.email.findFirst.mockResolvedValue({ id: "email_3" });

    await recordCampaignContactFailure(input);

    expect(mockTx.email.create).not.toHaveBeenCalled();
    expect(mockTx.campaignEmail.create).toHaveBeenCalledWith({
      data: {
        campaignId: "campaign_1",
        contactId: "contact_1",
        emailId: "email_3",
      },
    });
    expect(mockTx.email.update).toHaveBeenCalledWith({
      where: { id: "email_3" },
      data: { latestStatus: "FAILED" },
    });
  });
});

describe("CampaignBatchService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queues batches with a BullMQ-safe custom job ID", async () => {
    mockDb.campaign.findUnique.mockResolvedValue({
      lastSentAt: null,
      batchWindowMinutes: 0,
      status: "SCHEDULED",
    });

    await CampaignBatchService.queueBatch({
      campaignId: "campaign_1",
      teamId: 7,
    });

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "campaign-campaign_1",
      { campaignId: "campaign_1", teamId: 7 },
      expect.objectContaining({ jobId: "campaign-batch-campaign_1" }),
    );
  });
});
