import { createHash } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockContactSelect,
  mockDomainSelect,
  mockContactUpdate,
  mockSendEmail,
  mockRendererRender,
  mockLogger,
  mockValidateDomainFromEmail,
} = vi.hoisted(() => ({
  mockContactSelect: vi.fn(),
  mockDomainSelect: vi.fn(),
  mockContactUpdate: vi.fn(),
  mockSendEmail: vi.fn(),
  mockRendererRender: vi.fn(),
  mockLogger: {
    // importOriginal on ~/server/drizzle constructs the client, which logs.
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  mockValidateDomainFromEmail: vi.fn(),
}));

/**
 * These cover the confirmation email — which template renders, which variables
 * are substituted, how invalid and expired links are rejected — with the mailer
 * and renderer already faked. The database is incidental, so the Drizzle client
 * is stubbed rather than moving these to integration tests.
 *
 * The two reads are distinguished by whether the chain has an innerJoin (the
 * contact, which joins its contact book) or an orderBy (the fallback domain).
 */
vi.mock("~/server/drizzle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/server/drizzle")>();

  const drizzleDb = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: () => ({ limit: () => mockContactSelect() }) }),
        where: () => ({
          orderBy: () => ({ limit: () => mockDomainSelect() }),
          limit: () => mockContactSelect(),
        }),
      }),
    }),
    update: () => ({
      set: () => ({ where: () => ({ returning: () => mockContactUpdate() }) }),
    }),
  };

  return { ...actual, drizzleDb };
});

vi.mock("~/server/service/email-service", () => ({
  sendEmail: mockSendEmail,
}));

vi.mock("~/server/logger/log", () => ({
  logger: mockLogger,
}));

vi.mock("~/server/service/domain-service", () => ({
  validateDomainFromEmail: mockValidateDomainFromEmail,
}));

vi.mock("@usesend/email-editor/src/renderer", () => ({
  EmailRenderer: vi.fn().mockImplementation(() => ({
    render: mockRendererRender,
  })),
}));

import {
  confirmDoubleOptInSubscription,
  sendDoubleOptInConfirmationEmail,
} from "~/server/service/double-opt-in-service";

function getHash(contactId: string, expiresAt: number) {
  const secret = process.env.NEXTAUTH_SECRET ?? "";
  return createHash("sha256")
    .update(`${contactId}-${expiresAt}-${secret}`)
    .digest("hex");
}

describe("double-opt-in-service", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-08T00:00:00.000Z"));

    mockContactSelect.mockReset();
    mockContactUpdate.mockReset();
    mockDomainSelect.mockReset();
    mockSendEmail.mockReset();
    mockRendererRender.mockReset();
    mockLogger.error.mockReset();
    mockValidateDomainFromEmail.mockReset();
    mockValidateDomainFromEmail.mockResolvedValue({
      id: 1,
      name: "example.com",
      status: "SUCCESS",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips sending when double opt-in is disabled", async () => {
    mockContactSelect.mockResolvedValue([{
      id: "contact_1",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Smith",
      contactBookId: "book_1",
      book: {
        id: "book_1",
        name: "Newsletter",
        doubleOptInEnabled: false,
        doubleOptInFrom: null,
        doubleOptInSubject: null,
        doubleOptInContent: null,
      },
    }]);

    await sendDoubleOptInConfirmationEmail({
      contactId: "contact_1",
      contactBookId: "book_1",
      teamId: 7,
    });

    expect(mockDomainSelect).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("throws when no verified domain exists", async () => {
    mockContactSelect.mockResolvedValue([{
      id: "contact_1",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Smith",
      contactBookId: "book_1",
      book: {
        id: "book_1",
        name: "Newsletter",
        doubleOptInEnabled: true,
        doubleOptInFrom: null,
        doubleOptInSubject: "Confirm {{firstName}}",
        doubleOptInContent: JSON.stringify({ type: "doc", content: [] }),
      },
    }]);
    mockDomainSelect.mockResolvedValue([]);

    await expect(
      sendDoubleOptInConfirmationEmail({
        contactId: "contact_1",
        contactBookId: "book_1",
        teamId: 7,
      }),
    ).rejects.toThrow(
      "Double opt-in requires at least one verified domain to send confirmation emails",
    );
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("sends rendered confirmation email with template variables", async () => {
    mockContactSelect.mockResolvedValue([{
      id: "contact_1",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Smith",
      contactBookId: "book_1",
      book: {
        id: "book_1",
        name: "Newsletter",
        doubleOptInEnabled: true,
        doubleOptInFrom: null,
        doubleOptInSubject: "Confirm {{firstName}}",
        doubleOptInContent: JSON.stringify({ type: "doc", content: [] }),
      },
    }]);
    mockDomainSelect.mockResolvedValue([{ name: "example.com" }]);
    mockRendererRender.mockResolvedValue(
      '<p>Click <a href="{{doubleOptInUrl}}">confirm</a></p>',
    );

    await sendDoubleOptInConfirmationEmail({
      contactId: "contact_1",
      contactBookId: "book_1",
      teamId: 7,
    });

    const sendArgs = mockSendEmail.mock.calls[0]?.[0];
    expect(sendArgs.from).toBe("hello@example.com");
    expect(sendArgs.subject).toBe("Confirm Alice");
    expect(sendArgs.html).toContain("contactId=contact_1");
    expect(sendArgs.html).not.toContain("{{doubleOptInUrl}}");
    expect(sendArgs.teamId).toBe(7);
  });

  it("falls back to plain HTML when template rendering fails", async () => {
    mockContactSelect.mockResolvedValue([{
      id: "contact_1",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Smith",
      contactBookId: "book_1",
      book: {
        id: "book_1",
        name: "Newsletter",
        doubleOptInEnabled: true,
        doubleOptInFrom: null,
        doubleOptInSubject: "Confirm {{firstName}}",
        doubleOptInContent: JSON.stringify({ type: "doc", content: [] }),
      },
    }]);
    mockDomainSelect.mockResolvedValue([{ name: "example.com" }]);
    mockRendererRender.mockRejectedValue(new Error("render failed"));

    await sendDoubleOptInConfirmationEmail({
      contactId: "contact_1",
      contactBookId: "book_1",
      teamId: 7,
    });

    const sendArgs = mockSendEmail.mock.calls[0]?.[0];
    expect(sendArgs.html).toContain("Please confirm your subscription");
    expect(sendArgs.html).toContain("contactId=contact_1");
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it("replaces empty template variables instead of leaving tokens", async () => {
    mockContactSelect.mockResolvedValue([{
      id: "contact_1",
      email: "alice@example.com",
      firstName: null,
      lastName: null,
      contactBookId: "book_1",
      book: {
        id: "book_1",
        name: "Newsletter",
        doubleOptInEnabled: true,
        doubleOptInFrom: null,
        doubleOptInSubject: "Confirm {{firstName}}",
        doubleOptInContent: JSON.stringify({ type: "doc", content: [] }),
      },
    }]);
    mockDomainSelect.mockResolvedValue([{ name: "example.com" }]);
    mockRendererRender.mockResolvedValue("<p>Test</p>");

    await sendDoubleOptInConfirmationEmail({
      contactId: "contact_1",
      contactBookId: "book_1",
      teamId: 7,
    });

    const sendArgs = mockSendEmail.mock.calls[0]?.[0];
    expect(sendArgs.subject).toBe("Confirm ");
  });

  it("uses configured double opt-in from address when present", async () => {
    mockContactSelect.mockResolvedValue([{
      id: "contact_1",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Smith",
      contactBookId: "book_1",
      book: {
        id: "book_1",
        name: "Newsletter",
        doubleOptInEnabled: true,
        doubleOptInFrom: "Newsletter <hello@example.com>",
        doubleOptInSubject: "Confirm {{firstName}}",
        doubleOptInContent: JSON.stringify({ type: "doc", content: [] }),
      },
    }]);
    mockRendererRender.mockResolvedValue("<p>Test</p>");

    await sendDoubleOptInConfirmationEmail({
      contactId: "contact_1",
      contactBookId: "book_1",
      teamId: 7,
    });

    expect(mockDomainSelect).not.toHaveBeenCalled();
    expect(mockValidateDomainFromEmail).toHaveBeenCalledWith(
      "Newsletter <hello@example.com>",
      7,
    );
    const sendArgs = mockSendEmail.mock.calls[0]?.[0];
    expect(sendArgs.from).toBe("Newsletter <hello@example.com>");
  });

  it("rejects invalid confirmation links", async () => {
    await expect(
      confirmDoubleOptInSubscription({
        contactId: "contact_1",
        expiresAt: "not-a-number",
        hash: "abc",
      }),
    ).rejects.toThrow("Invalid confirmation link");
  });

  it("rejects expired confirmation links", async () => {
    await expect(
      confirmDoubleOptInSubscription({
        contactId: "contact_1",
        expiresAt: String(Date.now() - 1),
        hash: "abc",
      }),
    ).rejects.toThrow("Confirmation link has expired");
  });

  it("rejects links with invalid signatures", async () => {
    await expect(
      confirmDoubleOptInSubscription({
        contactId: "contact_1",
        expiresAt: String(Date.now() + 60_000),
        hash: "invalid-hash",
      }),
    ).rejects.toThrow("Invalid confirmation link");
  });

  it("returns existing contact when already subscribed", async () => {
    const expiresAt = Date.now() + 60_000;
    const contact = {
      id: "contact_1",
      email: "alice@example.com",
      subscribed: true,
    };

    mockContactSelect.mockResolvedValue([contact]);

    const result = await confirmDoubleOptInSubscription({
      contactId: "contact_1",
      expiresAt: String(expiresAt),
      hash: getHash("contact_1", expiresAt),
    });

    expect(result).toBe(contact);
    expect(mockContactUpdate).not.toHaveBeenCalled();
  });

  it("does not re-subscribe contacts with explicit unsubscribe reasons", async () => {
    const expiresAt = Date.now() + 60_000;
    const contact = {
      id: "contact_1",
      email: "alice@example.com",
      subscribed: false,
      unsubscribeReason: "UNSUBSCRIBED",
    };

    mockContactSelect.mockResolvedValue([contact]);

    const result = await confirmDoubleOptInSubscription({
      contactId: "contact_1",
      expiresAt: String(expiresAt),
      hash: getHash("contact_1", expiresAt),
    });

    expect(result).toBe(contact);
    expect(mockContactUpdate).not.toHaveBeenCalled();
  });

  it("activates pending contacts with a valid link", async () => {
    const expiresAt = Date.now() + 60_000;

    mockContactSelect.mockResolvedValue([{
      id: "contact_1",
      subscribed: false,
    }]);
    mockContactUpdate.mockResolvedValue([
      {
        id: "contact_1",
        subscribed: true,
        unsubscribeReason: null,
      },
    ]);

    const result = await confirmDoubleOptInSubscription({
      contactId: "contact_1",
      expiresAt: String(expiresAt),
      hash: getHash("contact_1", expiresAt),
    });

    expect(mockContactUpdate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      id: "contact_1",
      subscribed: true,
    });
  });
});
