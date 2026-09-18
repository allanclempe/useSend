import { ApiPermission } from "~/types/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Pulled in transitively via the contact services; usesend-js is an unbuilt
// workspace package, so resolving it fails in the test runner.
vi.mock("~/server/mailer", () => ({
  sendMail: vi.fn(),
  sendTeamInviteEmail: vi.fn(),
  sendSignUpEmail: vi.fn(),
}));

import updateContactBookRoute from "~/server/public-api/api/contacts/update-contact-book";
import { getApp } from "~/server/public-api/hono";
import { addApiKey } from "~/server/service/api-service";
import { createContactBook } from "~/server/service/contact-book-service";
import { createTeam } from "~/test/factories/core";
import {
  closeIntegrationConnections,
  integrationEnabled,
  resetDatabase,
  resetWorkerBindings,
} from "~/test/integration/helpers";

const describeIntegration = integrationEnabled ? describe : describe.skip;

/**
 * Team scoping has to be checked against a real database: a mocked client
 * answers the same no matter what the WHERE clause says.
 */
describeIntegration("PATCH /v1/contactBooks/{contactBookId}", () => {
  beforeEach(async () => {
    await resetDatabase();
    await resetWorkerBindings();
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

  function patch(apiKey: string, bookId: string, body: unknown) {
    const app = getApp();
    updateContactBookRoute(app);
    return app.request(`http://localhost/api/v1/contactBooks/${bookId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  it("updates a contact book owned by the team", async () => {
    const { apiKey, book } = await seedTeamWithBook("Owner");

    const response = await patch(apiKey, book.id, { name: "Leads" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: book.id,
      name: "Leads",
    });
  });

  it("does not update a contact book owned by another team", async () => {
    const { apiKey } = await seedTeamWithBook("Owner");
    const other = await seedTeamWithBook("Other");

    const response = await patch(apiKey, other.book.id, { name: "Hijacked" });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "NOT_FOUND",
        message: "Contact book not found for this team",
      },
    });
  });
});
