import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainStatus, type Domain } from "~/types/db";

const {
  mockDomainUpdate,
  mockDomainSelect,
  mockRecipientSelect,
  mockGetDomainIdentity,
  mockWebhookEmit,
  mockCache,
  mockSendMail,
  mockRenderDomainVerificationStatusEmail,
  mockResolveTxt,
} = vi.hoisted(() => {
  /**
   * An in-memory `CacheStore`, not a mocked Redis client.
   *
   * The service no longer knows which backend it is on, so the test should not
   * either: mocking the seam is what makes these assertions true of both the KV
   * and the Redis driver. `add` is exact here, which matches Redis and is the
   * optimistic reading of KV -- the pessimistic one costs a duplicate email and
   * is documented at the call site.
   */
  const store = new Map<string, string>();

  return {
    mockDomainUpdate: vi.fn(),
    mockDomainSelect: vi.fn(),
    mockRecipientSelect: vi.fn(),
    mockGetDomainIdentity: vi.fn(),
    mockWebhookEmit: vi.fn(),
    mockCache: {
      store,
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      add: vi.fn(async (key: string, value: string) => {
        if (store.has(key)) {
          return false;
        }
        store.set(key, value);
        return true;
      }),
      delete: vi.fn(async (...keys: string[]) => {
        for (const key of keys) store.delete(key);
      }),
    },
    mockSendMail: vi.fn(),
    mockRenderDomainVerificationStatusEmail: vi.fn(),
    mockResolveTxt: vi.fn(),
  };
});

const DOMAIN_STATE_KEY = "domain:verification:42";

function storeVerificationState(state: {
  lastCheckedAt?: string | null;
  lastNotifiedStatus?: string | null;
  hasEverVerified?: boolean;
}) {
  mockCache.store.set(DOMAIN_STATE_KEY, JSON.stringify(state));
}

function wasLastNotifiedStatusStored() {
  return mockCache.put.mock.calls.some(([key, value]) => {
    if (key !== DOMAIN_STATE_KEY || typeof value !== "string") {
      return false;
    }
    const parsed = JSON.parse(value) as { lastNotifiedStatus: string | null };
    return parsed.lastNotifiedStatus !== null;
  });
}

vi.mock("dns", () => ({
  default: {
    resolveTxt: mockResolveTxt,
  },
}));

/**
 * These exercise notification logic — which email is sent, when, and how often —
 * with every external edge already faked. The database is incidental rather
 * than the thing under test, so the Drizzle client is stubbed here instead of
 * moving these to integration tests.
 *
 * `capturedUpdate` keeps the assertions meaningful: they check what the update
 * actually set, not merely that an update happened.
 */
const capturedUpdate: { value: Record<string, unknown> | undefined } = {
  value: undefined,
};

vi.mock("~/server/drizzle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/server/drizzle")>();

  const drizzleDb = {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        capturedUpdate.value = values;
        return {
          where: () => ({ returning: () => mockDomainUpdate() }),
        };
      },
    }),
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: () => mockRecipientSelect() }),
        where: () => ({ limit: () => mockDomainSelect() }),
      }),
    }),
  };

  return { ...actual, drizzleDb };
});

vi.mock("~/server/aws/ses", () => ({
  getDomainIdentity: mockGetDomainIdentity,
}));

vi.mock("~/server/service/webhook-service", () => ({
  WebhookService: {
    emit: mockWebhookEmit,
  },
}));

vi.mock("~/server/cache", () => ({
  cacheGet: (key: string) => mockCache.get(key),
  cachePut: (key: string, value: string) => mockCache.put(key, value),
  cacheAdd: (key: string, value: string) => mockCache.add(key, value),
  cacheDelete: (...keys: string[]) => mockCache.delete(...keys),
}));

vi.mock("~/server/mailer", () => ({
  sendMail: mockSendMail,
}));

vi.mock("~/server/email-templates", () => ({
  renderDomainVerificationStatusEmail: mockRenderDomainVerificationStatusEmail,
}));

import {
  DOMAIN_UNVERIFIED_RECHECK_MS,
  DOMAIN_VERIFIED_RECHECK_MS,
  isDomainVerificationDue,
  refreshDomainVerification,
} from "~/server/service/domain-service";

function createDomain(overrides: Partial<Domain> = {}): Domain {
  return {
    id: 42,
    name: "example.com",
    teamId: 7,
    status: DomainStatus.PENDING,
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
    isVerifying: true,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("domain-service", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T12:00:00.000Z"));

    mockDomainUpdate.mockReset();
    mockDomainSelect.mockReset();
    mockRecipientSelect.mockReset();
    capturedUpdate.value = undefined;
    mockGetDomainIdentity.mockReset();
    mockWebhookEmit.mockReset();
    mockCache.store.clear();
    mockCache.get.mockClear();
    mockCache.put.mockClear();
    mockCache.add.mockClear();
    mockCache.delete.mockClear();
    mockSendMail.mockReset();
    mockRenderDomainVerificationStatusEmail.mockReset();
    mockResolveTxt.mockReset();

    mockRenderDomainVerificationStatusEmail.mockResolvedValue(
      "<p>domain status</p>",
    );
    mockRecipientSelect.mockResolvedValue([
      { email: "alice@example.com" },
      { email: "bob@example.com" },
    ]);
    mockResolveTxt.mockImplementation(
      (_name: string, cb: (err: Error | null, value?: string[][]) => void) => {
        cb(null, [["v=DMARC1; p=none;"]]);
      },
    );
  });

  it("sends success status emails to all team members when a new domain becomes verified", async () => {
    const domain = createDomain();
    mockGetDomainIdentity.mockResolvedValue({
      DkimAttributes: { Status: DomainStatus.SUCCESS },
      MailFromAttributes: { MailFromDomainStatus: DomainStatus.SUCCESS },
      VerificationInfo: {
        ErrorType: null,
        LastCheckedTimestamp: new Date("2026-03-09T12:00:00.000Z"),
      },
      VerificationStatus: DomainStatus.SUCCESS,
    });
    mockDomainUpdate.mockResolvedValue([
      createDomain({
        status: DomainStatus.SUCCESS,
        dkimStatus: DomainStatus.SUCCESS,
        spfDetails: DomainStatus.SUCCESS,
        dmarcAdded: true,
        isVerifying: false,
      }),
    ]);

    const result = await refreshDomainVerification(domain);

    expect(capturedUpdate.value).toEqual(
      expect.objectContaining({
        status: DomainStatus.SUCCESS,
        isVerifying: false,
        errorMessage: null,
      }),
    );
    expect(mockSendMail).toHaveBeenCalledTimes(2);
    expect(wasLastNotifiedStatusStored()).toBe(true);
    expect(result.status).toBe(DomainStatus.SUCCESS);
    expect(result.hasEverVerified).toBe(true);
  });

  it("sends one failure email and stops polling on terminal failure", async () => {
    const domain = createDomain();
    mockGetDomainIdentity.mockResolvedValue({
      DkimAttributes: { Status: DomainStatus.PENDING },
      MailFromAttributes: { MailFromDomainStatus: DomainStatus.PENDING },
      VerificationInfo: {
        ErrorType: "MAIL_FROM_DOMAIN_NOT_VERIFIED",
        LastCheckedTimestamp: new Date("2026-03-09T12:00:00.000Z"),
      },
      VerificationStatus: DomainStatus.FAILED,
    });
    mockDomainUpdate.mockResolvedValue([
      createDomain({
        status: DomainStatus.FAILED,
        dkimStatus: DomainStatus.PENDING,
        spfDetails: DomainStatus.PENDING,
        errorMessage: "MAIL_FROM_DOMAIN_NOT_VERIFIED",
        isVerifying: false,
      }),
    ]);

    const result = await refreshDomainVerification(domain);

    expect(capturedUpdate.value).toEqual(
      expect.objectContaining({
        status: DomainStatus.FAILED,
        isVerifying: false,
        errorMessage: "MAIL_FROM_DOMAIN_NOT_VERIFIED",
      }),
    );
    expect(mockSendMail).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(DomainStatus.FAILED);
  });

  it("does not resend status emails when the current status was already notified", async () => {
    const domain = createDomain({
      status: DomainStatus.SUCCESS,
      isVerifying: false,
    });
    storeVerificationState({
      lastCheckedAt: new Date("2026-03-08T12:00:00.000Z").toISOString(),
      lastNotifiedStatus: DomainStatus.SUCCESS,
      hasEverVerified: true,
    });
    mockGetDomainIdentity.mockResolvedValue({
      DkimAttributes: { Status: DomainStatus.SUCCESS },
      MailFromAttributes: { MailFromDomainStatus: DomainStatus.SUCCESS },
      VerificationInfo: {
        ErrorType: null,
        LastCheckedTimestamp: new Date("2026-03-09T12:00:00.000Z"),
      },
      VerificationStatus: DomainStatus.SUCCESS,
    });
    mockDomainUpdate.mockResolvedValue([
      createDomain({
        status: DomainStatus.SUCCESS,
        dkimStatus: DomainStatus.SUCCESS,
        spfDetails: DomainStatus.SUCCESS,
        dmarcAdded: true,
        isVerifying: false,
      }),
    ]);

    await refreshDomainVerification(domain);

    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it("does not send status email on first refresh when status is unchanged", async () => {
    const domain = createDomain({
      status: DomainStatus.SUCCESS,
      dkimStatus: DomainStatus.SUCCESS,
      spfDetails: DomainStatus.SUCCESS,
      isVerifying: false,
    });
    mockGetDomainIdentity.mockResolvedValue({
      DkimAttributes: { Status: DomainStatus.SUCCESS },
      MailFromAttributes: { MailFromDomainStatus: DomainStatus.SUCCESS },
      VerificationInfo: {
        ErrorType: null,
        LastCheckedTimestamp: new Date("2026-03-09T12:00:00.000Z"),
      },
      VerificationStatus: DomainStatus.SUCCESS,
    });
    mockDomainUpdate.mockResolvedValue([
      createDomain({
        status: DomainStatus.SUCCESS,
        dkimStatus: DomainStatus.SUCCESS,
        spfDetails: DomainStatus.SUCCESS,
        dmarcAdded: true,
        isVerifying: false,
      }),
    ]);

    await refreshDomainVerification(domain);

    expect(mockSendMail).not.toHaveBeenCalled();
    expect(wasLastNotifiedStatusStored()).toBe(false);
  });

  it("reserves the notification so concurrent refreshes do not double-send", async () => {
    const domain = createDomain();
    mockGetDomainIdentity.mockResolvedValue({
      DkimAttributes: { Status: DomainStatus.SUCCESS },
      MailFromAttributes: { MailFromDomainStatus: DomainStatus.SUCCESS },
      VerificationInfo: {
        ErrorType: null,
        LastCheckedTimestamp: new Date("2026-03-09T12:00:00.000Z"),
      },
      VerificationStatus: DomainStatus.SUCCESS,
    });
    mockDomainUpdate.mockResolvedValue([
      createDomain({
        status: DomainStatus.SUCCESS,
        dkimStatus: DomainStatus.SUCCESS,
        spfDetails: DomainStatus.SUCCESS,
        dmarcAdded: true,
        isVerifying: false,
      }),
    ]);

    await Promise.all([
      refreshDomainVerification(domain),
      refreshDomainVerification(domain),
    ]);

    expect(mockSendMail).toHaveBeenCalledTimes(2);
    expect(mockDomainUpdate).toHaveBeenCalledTimes(2);
  });

  it("logs and continues when sending the status email fails", async () => {
    const domain = createDomain();
    mockGetDomainIdentity.mockResolvedValue({
      DkimAttributes: { Status: DomainStatus.SUCCESS },
      MailFromAttributes: { MailFromDomainStatus: DomainStatus.SUCCESS },
      VerificationInfo: {
        ErrorType: null,
        LastCheckedTimestamp: new Date("2026-03-09T12:00:00.000Z"),
      },
      VerificationStatus: DomainStatus.SUCCESS,
    });
    mockDomainUpdate.mockResolvedValue([
      createDomain({
        status: DomainStatus.SUCCESS,
        dkimStatus: DomainStatus.SUCCESS,
        spfDetails: DomainStatus.SUCCESS,
        dmarcAdded: true,
        isVerifying: false,
      }),
    ]);
    mockSendMail
      .mockRejectedValueOnce(new Error("mail failed"))
      .mockResolvedValueOnce(undefined);

    const result = await refreshDomainVerification(domain);

    expect(result.status).toBe(DomainStatus.SUCCESS);
    expect(mockDomainUpdate).toHaveBeenCalled();
    expect(wasLastNotifiedStatusStored()).toBe(false);
  });

  it("uses a 6 hour cadence for domains that have never verified", async () => {
    const domain = createDomain({ status: DomainStatus.PENDING });
    storeVerificationState({
      lastCheckedAt: new Date(
        Date.now() - DOMAIN_UNVERIFIED_RECHECK_MS + 5 * 60 * 1000,
      ).toISOString(),
    });

    await expect(isDomainVerificationDue(domain)).resolves.toBe(false);

    storeVerificationState({
      lastCheckedAt: new Date(
        Date.now() - DOMAIN_UNVERIFIED_RECHECK_MS - 5 * 60 * 1000,
      ).toISOString(),
    });

    await expect(isDomainVerificationDue(domain)).resolves.toBe(true);
  });

  it("uses a 30 day cadence after a domain has been verified", async () => {
    const domain = createDomain({ status: DomainStatus.FAILED });
    storeVerificationState({
      lastCheckedAt: new Date(
        Date.now() - DOMAIN_VERIFIED_RECHECK_MS + 5 * 60 * 1000,
      ).toISOString(),
      lastNotifiedStatus: DomainStatus.SUCCESS,
      hasEverVerified: true,
    });

    await expect(isDomainVerificationDue(domain)).resolves.toBe(false);

    storeVerificationState({
      lastCheckedAt: new Date(
        Date.now() - DOMAIN_VERIFIED_RECHECK_MS - 5 * 60 * 1000,
      ).toISOString(),
      lastNotifiedStatus: DomainStatus.SUCCESS,
      hasEverVerified: true,
    });

    await expect(isDomainVerificationDue(domain)).resolves.toBe(true);
  });

  it("stops automatic retries after an initial terminal failure", async () => {
    const domain = createDomain({
      status: DomainStatus.FAILED,
      isVerifying: false,
    });
    storeVerificationState({
      lastCheckedAt: new Date("2026-03-09T06:00:00.000Z").toISOString(),
      lastNotifiedStatus: DomainStatus.FAILED,
    });

    await expect(isDomainVerificationDue(domain)).resolves.toBe(false);
  });
});
