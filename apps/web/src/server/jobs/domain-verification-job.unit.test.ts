import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainStatus, type Domain } from "@prisma/client";

const {
  mockFindMany,
  mockIsDomainVerificationDue,
  mockRefreshDomainVerification,
  mockSchedule,
  mockCreateQueue,
  mockCreateWorker,
} = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockIsDomainVerificationDue: vi.fn(),
  mockRefreshDomainVerification: vi.fn(),
  mockSchedule: vi.fn(),
  mockCreateQueue: vi.fn().mockImplementation(() => ({
    schedule: mockSchedule,
  })),
  mockCreateWorker: vi.fn().mockImplementation(() => ({ concurrency: 1 })),
}));

// Mock the driver, not the queue module — the interface and constants stay real.
vi.mock("~/server/queue/bullmq-driver", () => ({
  bullmqDriver: {
    createQueue: mockCreateQueue,
    createWorker: mockCreateWorker,
  },
}));

vi.mock("~/server/db", () => ({
  db: {
    domain: {
      findMany: mockFindMany,
    },
  },
}));

vi.mock("~/server/redis", () => ({
  BULL_PREFIX: "bull",
  getRedis: vi.fn(() => ({})),
}));

vi.mock("~/server/logger/log", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("~/server/service/domain-service", () => ({
  isDomainVerificationDue: mockIsDomainVerificationDue,
  refreshDomainVerification: mockRefreshDomainVerification,
}));

import {
  initDomainVerificationJob,
  runDueDomainVerifications,
} from "~/server/jobs/domain-verification-job";

function createDomain(id: number, status: DomainStatus): Domain {
  return {
    id,
    name: `example-${id}.com`,
    teamId: 7,
    status,
    region: "us-east-1",
    clickTracking: false,
    openTracking: false,
    publicKey: "public-key",
    dkimSelector: "usesend",
    dkimStatus: DomainStatus.NOT_STARTED,
    spfDetails: DomainStatus.NOT_STARTED,
    dmarcAdded: false,
    errorMessage: null,
    subdomain: null,
    sesTenantId: null,
    isVerifying: status !== DomainStatus.SUCCESS,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
  };
}

describe("domain-verification-job", () => {
  beforeEach(() => {
    mockFindMany.mockReset();
    mockIsDomainVerificationDue.mockReset();
    mockRefreshDomainVerification.mockReset();
    mockSchedule.mockReset();
    mockCreateQueue.mockReset();
    mockCreateWorker.mockReset();
    mockCreateQueue.mockImplementation(() => ({
      schedule: mockSchedule,
    }));
    mockCreateWorker.mockImplementation(() => ({ concurrency: 1 }));
  });

  it("refreshes only domains that are due", async () => {
    const firstDomain = createDomain(1, DomainStatus.PENDING);
    const secondDomain = createDomain(2, DomainStatus.SUCCESS);
    mockFindMany.mockResolvedValue([firstDomain, secondDomain]);
    mockIsDomainVerificationDue
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await runDueDomainVerifications();

    expect(mockRefreshDomainVerification).toHaveBeenCalledTimes(1);
    expect(mockRefreshDomainVerification).toHaveBeenCalledWith(firstDomain);
  });

  it("initializes the worker lazily", async () => {
    await initDomainVerificationJob();

    expect(mockCreateQueue).toHaveBeenCalledTimes(1);
    expect(mockCreateWorker).toHaveBeenCalledTimes(1);
    expect(mockSchedule).toHaveBeenCalledWith("domain-verification-hourly", {
      cron: "0 * * * *",
      tz: "UTC",
    });

    // completed + failed handlers are now options, not .on() registrations
    const workerOptions = mockCreateWorker.mock.calls[0]?.[2];
    expect(workerOptions?.onCompleted).toBeTypeOf("function");
    expect(workerOptions?.onFailed).toBeTypeOf("function");
  });
});
