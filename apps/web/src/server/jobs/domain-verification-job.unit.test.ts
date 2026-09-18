/* eslint-disable no-unused-vars -- parameter names in type signatures */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainStatus, type Domain } from "~/types/db";

const {
  mockFindMany,
  mockIsDomainVerificationDue,
  mockRefreshDomainVerification,
  mockSchedule,
  mockEnqueue,
  mockCreateQueue,
  mockCreateWorker,
  registered,
} = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockIsDomainVerificationDue: vi.fn(),
  mockRefreshDomainVerification: vi.fn(),
  mockSchedule: vi.fn(),
  mockEnqueue: vi.fn(),
  mockCreateQueue: vi.fn().mockImplementation(() => ({
    schedule: mockSchedule,
    enqueue: mockEnqueue,
  })),
  mockCreateWorker: vi.fn().mockImplementation(() => ({ concurrency: 1 })),
  // `initDomainVerificationJob` is idempotent, so `createWorker` runs exactly
  // once for the whole file. Hold on to the handler it registered.
  registered: { handler: undefined as ((job: any) => Promise<void>) | undefined },
}));

// Mock the driver, not the queue module — the interface and constants stay real.
vi.mock("~/server/queue/workers-driver", () => ({
  workersDriver: {
    createQueue: mockCreateQueue,
    createWorker: mockCreateWorker,
  },
}));

vi.mock("~/server/drizzle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/server/drizzle")>();

  return {
    ...actual,
    // `runDueDomainVerifications` pages now, so the chain gained `where` and
    // `limit` between `from` and the rows.
    drizzleDb: {
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: () => mockFindMany() }) }),
        }),
      }),
    },
  };
});

// importOriginal on ~/server/drizzle constructs the client, which logs on the
// way up, so every level has to exist or the mock factory itself throws.
vi.mock("~/server/logger/log", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
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
    mockEnqueue.mockReset();
    mockCreateQueue.mockReset();
    mockCreateWorker.mockReset();
    mockCreateQueue.mockImplementation(() => ({
      schedule: mockSchedule,
      enqueue: mockEnqueue,
    }));
    mockCreateWorker.mockImplementation(
      (_name: string, handler: (job: any) => Promise<void>) => {
        registered.handler = handler;
        return { concurrency: 1 };
      },
    );
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

  it("reports a cursor only when the page came back full", async () => {
    mockIsDomainVerificationDue.mockResolvedValue(false);

    // A short page is the end of the table: nothing to continue from.
    mockFindMany.mockResolvedValue([createDomain(7, DomainStatus.SUCCESS)]);
    expect(await runDueDomainVerifications({ limit: 2 })).toEqual({
      processed: 1,
      nextCursor: undefined,
    });

    // A full page means there is more, and the next one starts after its last
    // id — `Domain.id` is unique, so the keyset cannot repeat or skip a row.
    mockFindMany.mockResolvedValue([
      createDomain(7, DomainStatus.SUCCESS),
      createDomain(9, DomainStatus.SUCCESS),
    ]);
    expect(await runDueDomainVerifications({ limit: 2 })).toEqual({
      processed: 2,
      nextCursor: 9,
    });
  });

  it("keeps going past a domain that threw", async () => {
    const first = createDomain(1, DomainStatus.PENDING);
    const second = createDomain(2, DomainStatus.PENDING);
    mockFindMany.mockResolvedValue([first, second]);
    mockIsDomainVerificationDue.mockResolvedValue(true);
    mockRefreshDomainVerification
      .mockRejectedValueOnce(new Error("ses down"))
      .mockResolvedValueOnce(undefined);

    await expect(runDueDomainVerifications()).resolves.toMatchObject({
      processed: 2,
    });
    expect(mockRefreshDomainVerification).toHaveBeenCalledTimes(2);
  });

  it("initializes the worker lazily", async () => {
    await initDomainVerificationJob();

    expect(mockCreateQueue).toHaveBeenCalledTimes(1);
    expect(mockCreateWorker).toHaveBeenCalledTimes(1);
    expect(mockSchedule).toHaveBeenCalledWith("domain-verification-hourly", {
      cron: "0 * * * *",
      tz: "UTC",
    });

    // failed handlers are now options, not .on() registrations
    const workerOptions = mockCreateWorker.mock.calls[0]?.[2];
    expect(workerOptions?.onFailed).toBeTypeOf("function");
  });

  it("enqueues a continuation when a page filled up", async () => {
    mockIsDomainVerificationDue.mockResolvedValue(false);
    mockFindMany.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) =>
        createDomain(i + 1, DomainStatus.SUCCESS),
      ),
    );

    await initDomainVerificationJob();
    await registered.handler!({ data: {} });

    // `objectContaining` because the handler runs inside the seam's trace
    // context, which stamps a `__traceparent` onto anything enqueued there.
    // `objectContaining` because the handler runs inside the seam's trace
    // context, which stamps a `__traceparent` onto anything enqueued there; the
    // trailing `undefined` is the seam passing `options` straight through.
    expect(mockEnqueue).toHaveBeenCalledWith(
      "continue",
      expect.objectContaining({ cursor: 25 }),
      undefined,
    );
  });

  it("stops when the page came back short", async () => {
    mockIsDomainVerificationDue.mockResolvedValue(false);
    mockFindMany.mockResolvedValue([createDomain(1, DomainStatus.SUCCESS)]);

    await initDomainVerificationJob();
    await registered.handler!({ data: {} });

    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
