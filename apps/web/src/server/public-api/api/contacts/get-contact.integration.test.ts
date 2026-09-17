import { ApiPermission } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Pulled in transitively via the contact services; usesend-js is an unbuilt
// workspace package, so resolving it fails in the test runner.
vi.mock("~/server/mailer", () => ({
  sendMail: vi.fn(),
  sendTeamInviteEmail: vi.fn(),
  sendSignUpEmail: vi.fn(),
}));

import getContact from "~/server/public-api/api/contacts/get-contact";
import { getApp } from "~/server/public-api/hono";
import { addApiKey } from "~/server/service/api-service";
import { createContactBook } from "~/server/service/contact-book-service";
import { addOrUpdateContact } from "~/server/service/contact-service";
import { createTeam } from "~/test/factories/core";
import {
  closeIntegrationConnections,
  integrationEnabled,
  resetDatabase,
  resetRedis,
} from "~/test/integration/helpers";

const describeIntegration = integrationEnabled ? describe : describe.skip;

/**
 * These cases run against a real database on purpose: they are about which
 * rows the query is *allowed* to reach, and a mocked client would return
 * whatever it was told regardless of the WHERE clause.
 */
describeIntegration(
  "GET /v1/contactBooks/{contactBookId}/contacts/{contactId}",
  () => {
    beforeEach(async () => {
      await resetDatabase();
      await resetRedis();
    });

    afterAll(async () => {
      await closeIntegrationConnections();
    });

    async function seedTeamWithBook(name: string) {
      const team = await createTeam({ name, apiRateLimit: 100 });
      const apiKey = await addApiKey({
        name: `${name}-key`,
        permission: ApiPermission.FULL,
        teamId: team.id,
      });
      const book = await createContactBook(team.id, `${name} book`);
      return { team, apiKey, book };
    }

    function request(apiKey: string, bookId: string, contactId: string) {
      const app = getApp();
      getContact(app);
      return app.request(
        `http://localhost/api/v1/contactBooks/${bookId}/contacts/${contactId}`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
    }

    it("returns a contact that belongs to the requested book", async () => {
      const { apiKey, book } = await seedTeamWithBook("Owner");
      const contact = await addOrUpdateContact(book.id, {
        email: "someone@example.com",
        firstName: "Some",
      });

      const response = await request(apiKey, book.id, contact.id);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        id: contact.id,
        email: "someone@example.com",
        firstName: "Some",
        contactBookId: book.id,
      });
    });

    it("does not return a contact that lives in another contact book", async () => {
      const { apiKey, book } = await seedTeamWithBook("Owner");
      const other = await seedTeamWithBook("Other");
      const foreign = await addOrUpdateContact(other.book.id, {
        email: "foreign@example.com",
      });

      const response = await request(apiKey, book.id, foreign.id);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "NOT_FOUND", message: "Contact not found" },
      });
    });

    it("does not return a contact book belonging to another team", async () => {
      const { apiKey } = await seedTeamWithBook("Owner");
      const other = await seedTeamWithBook("Other");
      const foreign = await addOrUpdateContact(other.book.id, {
        email: "foreign@example.com",
      });

      const response = await request(apiKey, other.book.id, foreign.id);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "NOT_FOUND",
          message: "Contact book not found for this team",
        },
      });
    });
  },
);
