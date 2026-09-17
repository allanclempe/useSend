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
  mockWebhookEmit,
  mockSendDoubleOptInConfirmationEmail,
  mockAddBulkContactJobs,
} = vi.hoisted(() => ({
  mockWebhookEmit: vi.fn(),
  mockSendDoubleOptInConfirmationEmail: vi.fn(),
  mockAddBulkContactJobs: vi.fn(),
}));

// Outbound side effects stay mocked; the database is real.
vi.mock("~/server/service/webhook-service", () => ({
  WebhookService: { emit: mockWebhookEmit },
}));

vi.mock("~/server/service/double-opt-in-service", () => ({
  sendDoubleOptInConfirmationEmail: mockSendDoubleOptInConfirmationEmail,
}));

vi.mock("~/server/service/contact-queue-service", () => ({
  ContactQueueService: { addBulkContactJobs: mockAddBulkContactJobs },
}));

import {
  addOrUpdateContact,
  bulkDeleteContactsInContactBook,
  deleteContactInContactBook,
  getContactInContactBook,
  resendDoubleOptInConfirmationInContactBook,
  subscribeContact,
  unsubscribeContact,
  updateContactInContactBook,
  updateContactSubscription,
} from "~/server/service/contact-service";

const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration("contact-service", () => {
  let teamId: number;

  beforeEach(async () => {
    await resetDatabase();
    vi.clearAllMocks();
    mockSendDoubleOptInConfirmationEmail.mockResolvedValue(undefined);
    mockWebhookEmit.mockResolvedValue(undefined);

    const team = await createTeam({ name: "cs-team" });
    teamId = team.id;
  });

  afterAll(async () => {
    await closeIntegrationConnections();
  });

  async function makeBook(
    overrides: {
      doubleOptInEnabled?: boolean;
      variables?: string[];
      id?: string;
    } = {},
  ) {
    const [book] = await drizzleDb
      .insert(schema.contactBook)
      .values(
        withUpdatedAt({
          id: overrides.id ?? `cb_${Math.random().toString(36).slice(2, 10)}`,
          name: "book",
          teamId,
          properties: {},
          variables: overrides.variables ?? [],
          doubleOptInEnabled: overrides.doubleOptInEnabled ?? false,
        }),
      )
      .returning();

    return book!;
  }

  it("creates pending contacts and sends double opt-in confirmation", async () => {
    const book = await makeBook({ doubleOptInEnabled: true });

    const saved = await addOrUpdateContact(book.id, { email: "a@example.com" });

    expect(saved.subscribed).toBe(false);
    expect(saved.unsubscribeReason).toBeNull();
    expect(mockSendDoubleOptInConfirmationEmail).toHaveBeenCalledTimes(1);
    expect(mockWebhookEmit).toHaveBeenCalledWith(
      teamId,
      "contact.created",
      expect.objectContaining({ email: "a@example.com" }),
    );
  });

  it("creates subscribed contacts immediately when double opt-in is disabled", async () => {
    const book = await makeBook();

    const saved = await addOrUpdateContact(book.id, { email: "b@example.com" });

    expect(saved.subscribed).toBe(true);
    expect(mockSendDoubleOptInConfirmationEmail).not.toHaveBeenCalled();
  });

  it("stores unsubscribe reason when creating unsubscribed contacts", async () => {
    const book = await makeBook();

    const saved = await addOrUpdateContact(book.id, {
      email: "c@example.com",
      subscribed: false,
    });

    expect(saved.subscribed).toBe(false);
    expect(saved.unsubscribeReason).toBe("UNSUBSCRIBED");
  });

  it("does not create pending contacts for explicit unsubscribes", async () => {
    const book = await makeBook({ doubleOptInEnabled: true });

    const saved = await addOrUpdateContact(book.id, {
      email: "d@example.com",
      subscribed: false,
    });

    expect(saved.unsubscribeReason).toBe("UNSUBSCRIBED");
    expect(mockSendDoubleOptInConfirmationEmail).not.toHaveBeenCalled();
  });

  it("does not re-subscribe contacts that already unsubscribed", async () => {
    const book = await makeBook();
    await addOrUpdateContact(book.id, {
      email: "e@example.com",
      subscribed: false,
    });

    const resaved = await addOrUpdateContact(book.id, {
      email: "e@example.com",
      subscribed: true,
    });

    // Yes->No is allowed, No->Yes is blocked so a CSV re-import cannot
    // resurrect an unsubscribe.
    expect(resaved.subscribed).toBe(false);
    expect(resaved.unsubscribeReason).toBe("UNSUBSCRIBED");
  });

  it("upserts rather than duplicating on the same email", async () => {
    const book = await makeBook();

    const first = await addOrUpdateContact(book.id, {
      email: "f@example.com",
      firstName: "First",
    });
    const second = await addOrUpdateContact(book.id, {
      email: "f@example.com",
      firstName: "Second",
    });

    expect(second.id).toBe(first.id);
    expect(second.firstName).toBe("Second");

    const all = await drizzleDb
      .select()
      .from(schema.contact)
      .where(eq(schema.contact.contactBookId, book.id));
    expect(all).toHaveLength(1);
  });

  it("does not blank existing fields when they are omitted on upsert", async () => {
    const book = await makeBook();
    await addOrUpdateContact(book.id, {
      email: "g@example.com",
      firstName: "Keep",
      lastName: "Me",
    });

    const updated = await addOrUpdateContact(book.id, {
      email: "g@example.com",
    });

    // Prisma dropped `undefined` from the update clause; the conflict payload
    // has to be built the same way or an omitted name wipes the stored one.
    expect(updated.firstName).toBe("Keep");
    expect(updated.lastName).toBe("Me");
  });

  it("bumps updatedAt on upsert", async () => {
    const book = await makeBook();
    const first = await addOrUpdateContact(book.id, {
      email: "h@example.com",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await addOrUpdateContact(book.id, {
      email: "h@example.com",
    });

    expect(second.updatedAt.getTime()).toBeGreaterThan(
      first.updatedAt.getTime(),
    );
  });

  it("canonicalizes registered property keys when creating contacts", async () => {
    const book = await makeBook({ variables: ["firstName"] });

    const saved = await addOrUpdateContact(book.id, {
      email: "i@example.com",
      properties: { firstname: "Ada" },
    });

    expect(saved.properties).toEqual({ firstName: "Ada" });
  });

  it("preserves existing properties when upserting without properties", async () => {
    const book = await makeBook({ variables: ["city"] });
    await addOrUpdateContact(book.id, {
      email: "j@example.com",
      properties: { city: "Sydney" },
    });

    const resaved = await addOrUpdateContact(book.id, {
      email: "j@example.com",
    });

    expect(resaved.properties).toEqual({ city: "Sydney" });
  });

  it("merges existing properties when upserting with partial properties", async () => {
    const book = await makeBook({ variables: ["city", "plan"] });
    await addOrUpdateContact(book.id, {
      email: "k@example.com",
      properties: { city: "Sydney", plan: "free" },
    });

    const resaved = await addOrUpdateContact(book.id, {
      email: "k@example.com",
      properties: { plan: "paid" },
    });

    expect(resaved.properties).toEqual({ city: "Sydney", plan: "paid" });
  });

  it("throws when contact book does not exist", async () => {
    await expect(
      addOrUpdateContact("missing", { email: "l@example.com" }),
    ).rejects.toThrow("Contact book not found");
  });

  it("persists contact when double opt-in email send fails", async () => {
    const book = await makeBook({ doubleOptInEnabled: true });
    mockSendDoubleOptInConfirmationEmail.mockRejectedValue(new Error("smtp"));

    const saved = await addOrUpdateContact(book.id, { email: "m@example.com" });

    expect(saved.id).toBeDefined();
    const stored = await getContactInContactBook(saved.id, book.id);
    expect(stored?.email).toBe("m@example.com");
  });

  it("resends double opt-in confirmation for pending contacts", async () => {
    const book = await makeBook({ doubleOptInEnabled: true });
    const saved = await addOrUpdateContact(book.id, { email: "n@example.com" });
    mockSendDoubleOptInConfirmationEmail.mockClear();

    const result = await resendDoubleOptInConfirmationInContactBook(
      saved.id,
      book.id,
    );

    expect(result?.id).toBe(saved.id);
    expect(mockSendDoubleOptInConfirmationEmail).toHaveBeenCalledTimes(1);
  });

  it("rejects resending confirmation for non-pending contacts", async () => {
    const book = await makeBook();
    const saved = await addOrUpdateContact(book.id, { email: "o@example.com" });

    await expect(
      resendDoubleOptInConfirmationInContactBook(saved.id, book.id),
    ).rejects.toThrow("pending contacts");
  });

  it("returns null when resending confirmation for missing contact", async () => {
    const book = await makeBook();

    await expect(
      resendDoubleOptInConfirmationInContactBook("nope", book.id),
    ).resolves.toBeNull();
  });

  it("merges contact properties on update and canonicalizes registry variables", async () => {
    const book = await makeBook({ variables: ["city", "plan"] });
    const saved = await addOrUpdateContact(book.id, {
      email: "p@example.com",
      properties: { city: "Sydney" },
    });

    const updated = await updateContactInContactBook(saved.id, book.id, {
      properties: { PLAN: "paid" },
    });

    expect(updated?.properties).toEqual({ city: "Sydney", plan: "paid" });
  });

  it("returns null when updating a contact outside the book", async () => {
    const book = await makeBook();
    const other = await makeBook();
    const saved = await addOrUpdateContact(book.id, { email: "q@example.com" });

    await expect(
      updateContactInContactBook(saved.id, other.id, { firstName: "x" }),
    ).resolves.toBeNull();
  });

  it("deletes a contact and emits the event", async () => {
    const book = await makeBook();
    const saved = await addOrUpdateContact(book.id, { email: "r@example.com" });
    mockWebhookEmit.mockClear();

    const deleted = await deleteContactInContactBook(saved.id, book.id);

    expect(deleted?.id).toBe(saved.id);
    expect(mockWebhookEmit).toHaveBeenCalledWith(
      teamId,
      "contact.deleted",
      expect.objectContaining({ email: "r@example.com" }),
    );
    await expect(
      getContactInContactBook(saved.id, book.id),
    ).resolves.toBeNull();
  });

  it("bulk deletes only contacts inside the book", async () => {
    const book = await makeBook();
    const other = await makeBook();
    const a = await addOrUpdateContact(book.id, { email: "s@example.com" });
    const b = await addOrUpdateContact(book.id, { email: "t@example.com" });
    const outside = await addOrUpdateContact(other.id, {
      email: "u@example.com",
    });

    const deleted = await bulkDeleteContactsInContactBook(
      [a.id, b.id, outside.id],
      book.id,
    );

    expect(deleted.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    await expect(
      getContactInContactBook(outside.id, other.id),
    ).resolves.not.toBeNull();
  });

  it("returns an empty array when bulk deleting nothing", async () => {
    const book = await makeBook();

    await expect(
      bulkDeleteContactsInContactBook(["nope"], book.id),
    ).resolves.toEqual([]);
  });

  it("subscribes and unsubscribes a contact", async () => {
    const book = await makeBook();
    const saved = await addOrUpdateContact(book.id, { email: "v@example.com" });

    await unsubscribeContact(saved.id);
    let stored = await getContactInContactBook(saved.id, book.id);
    expect(stored?.subscribed).toBe(false);
    expect(stored?.unsubscribeReason).toBe("UNSUBSCRIBED");

    await subscribeContact(saved.id);
    stored = await getContactInContactBook(saved.id, book.id);
    expect(stored?.subscribed).toBe(true);
    expect(stored?.unsubscribeReason).toBeNull();
  });

  it("updates subscription state and emits an event", async () => {
    const book = await makeBook();
    const saved = await addOrUpdateContact(book.id, { email: "w@example.com" });
    mockWebhookEmit.mockClear();

    const updated = await updateContactSubscription({
      contactId: saved.id,
      subscribed: false,
      unsubscribeReason: "BOUNCED",
    });

    expect(updated.subscribed).toBe(false);
    expect(updated.unsubscribeReason).toBe("BOUNCED");
    expect(mockWebhookEmit).toHaveBeenCalledWith(
      teamId,
      "contact.updated",
      expect.objectContaining({ subscribed: false }),
    );
  });
});
