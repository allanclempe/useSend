import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DOUBLE_OPT_IN_CONTENT,
  DEFAULT_DOUBLE_OPT_IN_SUBJECT,
} from "~/lib/constants/double-opt-in";
import { db } from "~/server/db";
import {
  closeIntegrationConnections,
  integrationEnabled,
  resetDatabase,
} from "~/test/integration/helpers";

const { mockCheckContactBookLimit, mockValidateDomainFromEmail } = vi.hoisted(
  () => ({
    mockCheckContactBookLimit: vi.fn(),
    mockValidateDomainFromEmail: vi.fn(),
  }),
);

// Both are other services' concerns with their own tests; the database is real.
vi.mock("~/server/service/limit-service", () => ({
  LimitService: { checkContactBookLimit: mockCheckContactBookLimit },
}));

vi.mock("~/server/service/domain-service", () => ({
  validateDomainFromEmail: mockValidateDomainFromEmail,
}));

import {
  createContactBook,
  deleteContactBook,
  getContactBookDetails,
  getContactBooks,
  updateContactBook,
} from "~/server/service/contact-book-service";

const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration("contact-book-service", () => {
  let teamId: number;

  beforeEach(async () => {
    await resetDatabase();
    vi.clearAllMocks();
    mockCheckContactBookLimit.mockResolvedValue({ isLimitReached: false });
    mockValidateDomainFromEmail.mockResolvedValue(undefined);

    const team = await db.team.create({ data: { name: "cb-team" } });
    teamId = team.id;
  });

  afterAll(async () => {
    await closeIntegrationConnections();
  });

  it("creates contact books with double opt-in defaults", async () => {
    const created = await createContactBook(teamId, "book");

    expect(created.name).toBe("book");
    expect(created.teamId).toBe(teamId);
    expect(created.doubleOptInEnabled).toBe(true);
    expect(created.doubleOptInSubject).toBe(DEFAULT_DOUBLE_OPT_IN_SUBJECT);
    expect(created.doubleOptInContent).toBe(DEFAULT_DOUBLE_OPT_IN_CONTENT);
    // Prisma generated this id client-side; Drizzle has to supply one.
    expect(created.id).toMatch(/^[0-9a-z]{24}$/);
    expect(created.variables).toEqual([]);
  });

  it("returns contact books with a contact count", async () => {
    const book = await createContactBook(teamId, "counted");
    await db.contact.createMany({
      data: [
        { id: "c1", contactBookId: book.id, email: "a@example.com", properties: {} },
        { id: "c2", contactBookId: book.id, email: "b@example.com", properties: {} },
      ],
    });

    const [listed] = await getContactBooks(teamId);

    // COUNT returns bigint; without the ::integer cast this is the string "2".
    expect(listed?._count.contacts).toBe(2);
    expect(typeof listed?._count.contacts).toBe("number");
    expect(listed?.doubleOptInContent).toBe(DEFAULT_DOUBLE_OPT_IN_CONTENT);
  });

  it("reports zero contacts for an empty book", async () => {
    await createContactBook(teamId, "empty");

    const [listed] = await getContactBooks(teamId);

    expect(listed?._count.contacts).toBe(0);
  });

  it("filters by name case-insensitively", async () => {
    await createContactBook(teamId, "Newsletter");
    await createContactBook(teamId, "Transactional");

    const found = await getContactBooks(teamId, "newsletter");

    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe("Newsletter");
  });

  it("excludes other teams' books", async () => {
    const other = await db.team.create({ data: { name: "other" } });
    await createContactBook(teamId, "mine");
    await createContactBook(other.id, "theirs");

    const found = await getContactBooks(teamId);

    expect(found.map((b) => b.name)).toEqual(["mine"]);
  });

  it("throws when the contact book limit is reached", async () => {
    mockCheckContactBookLimit.mockResolvedValue({
      isLimitReached: true,
      reason: "Contact book limit reached",
    });

    await expect(createContactBook(teamId, "over-limit")).rejects.toThrow(
      "Contact book limit reached",
    );
  });

  it("rejects double opt-in content without the confirmation placeholder", async () => {
    const book = await createContactBook(teamId, "placeholder");

    await expect(
      updateContactBook(book.id, { doubleOptInContent: "no placeholder here" }),
    ).rejects.toThrow("{{doubleOptInUrl}}");
  });

  it("normalizes empty double opt-in content to defaults", async () => {
    const book = await createContactBook(teamId, "normalize");

    const updated = await updateContactBook(book.id, {
      doubleOptInContent: "   ",
    });

    expect(updated.doubleOptInContent).toBe(DEFAULT_DOUBLE_OPT_IN_CONTENT);
  });

  it("backfills default subject and content when enabling double opt-in", async () => {
    const book = await createContactBook(teamId, "backfill");
    await updateContactBook(book.id, {
      doubleOptInSubject: "   ",
      doubleOptInContent: "   ",
    });

    const updated = await updateContactBook(book.id, {
      doubleOptInEnabled: true,
    });

    expect(updated.doubleOptInEnabled).toBe(true);
    expect(updated.doubleOptInSubject).toBe(DEFAULT_DOUBLE_OPT_IN_SUBJECT);
    expect(updated.doubleOptInContent).toBe(DEFAULT_DOUBLE_OPT_IN_CONTENT);
  });

  it("validates and stores a configured double opt-in from address", async () => {
    const book = await createContactBook(teamId, "from");

    const updated = await updateContactBook(book.id, {
      doubleOptInFrom: "  hello@example.com  ",
    });

    expect(mockValidateDomainFromEmail).toHaveBeenCalledWith(
      "hello@example.com",
      teamId,
    );
    expect(updated.doubleOptInFrom).toBe("hello@example.com");
  });

  it("clears configured double opt-in from when empty", async () => {
    const book = await createContactBook(teamId, "clear");
    await updateContactBook(book.id, { doubleOptInFrom: "a@example.com" });

    const updated = await updateContactBook(book.id, { doubleOptInFrom: "" });

    expect(updated.doubleOptInFrom).toBeNull();
    expect(mockValidateDomainFromEmail).toHaveBeenCalledTimes(1);
  });

  it("throws when setting a from address on a missing book", async () => {
    await expect(
      updateContactBook("nope", { doubleOptInFrom: "a@example.com" }),
    ).rejects.toThrow("Contact book not found");
  });

  it("throws when updating a missing book", async () => {
    // Prisma's update threw on a missing row; the port preserves that.
    await expect(updateContactBook("nope", { name: "x" })).rejects.toThrow(
      "Contact book not found",
    );
  });

  it("reports contact book details", async () => {
    const book = await createContactBook(teamId, "details");
    await db.contact.createMany({
      data: [
        {
          id: "d1",
          contactBookId: book.id,
          email: "a@example.com",
          properties: {},
        },
        {
          id: "d2",
          contactBookId: book.id,
          email: "b@example.com",
          properties: {},
          subscribed: false,
        },
      ],
    });

    const details = await getContactBookDetails(book.id);

    expect(details.totalContacts).toBe(2);
    expect(details.unsubscribedContacts).toBe(1);
    expect(details.campaigns).toEqual([]);
  });

  it("deletes a contact book and throws when it is already gone", async () => {
    const book = await createContactBook(teamId, "doomed");

    const deleted = await deleteContactBook(book.id);
    expect(deleted.id).toBe(book.id);

    await expect(deleteContactBook(book.id)).rejects.toThrow(
      "Contact book not found",
    );
  });
});
