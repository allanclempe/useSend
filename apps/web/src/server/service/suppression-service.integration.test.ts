import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "~/server/db";
import {
  closeIntegrationConnections,
  integrationEnabled,
  resetDatabase,
} from "~/test/integration/helpers";

vi.mock("~/server/aws/ses", () => ({
  deleteSuppressedDestination: vi.fn(),
  getDomainIdentity: vi.fn(),
}));

import { SuppressionService } from "~/server/service/suppression-service";

const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration("suppression-service", () => {
  let teamId: number;

  beforeEach(async () => {
    await resetDatabase();
    vi.clearAllMocks();
    const team = await db.team.create({ data: { name: "supp-team" } });
    teamId = team.id;
  });

  afterAll(async () => {
    await closeIntegrationConnections();
  });

  it("adds a suppression and is idempotent on the same email", async () => {
    const first = await SuppressionService.addSuppression({
      email: "  Person@Example.com  ",
      teamId,
      reason: "HARD_BOUNCE",
      source: "em_1",
    });

    // Normalised on write, so a differently-cased retry updates rather than
    // inserting a second row.
    expect(first.email).toBe("person@example.com");

    const second = await SuppressionService.addSuppression({
      email: "PERSON@example.com",
      teamId,
      reason: "COMPLAINT",
      source: "em_2",
    });

    expect(second.id).toBe(first.id);
    expect(second.reason).toBe("COMPLAINT");
    expect(await db.suppressionList.count()).toBe(1);
  });

  it("bumps updatedAt on a repeat suppression", async () => {
    const first = await SuppressionService.addSuppression({
      email: "a@example.com",
      teamId,
      reason: "MANUAL",
    });

    await new Promise((r) => setTimeout(r, 10));
    const second = await SuppressionService.addSuppression({
      email: "a@example.com",
      teamId,
      reason: "MANUAL",
    });

    expect(second.updatedAt.getTime()).toBeGreaterThan(
      first.updatedAt.getTime(),
    );
  });

  it("scopes suppression checks to the team", async () => {
    const other = await db.team.create({ data: { name: "other" } });
    await SuppressionService.addSuppression({
      email: "x@example.com",
      teamId,
      reason: "MANUAL",
    });

    await expect(
      SuppressionService.isEmailSuppressed("x@example.com", teamId),
    ).resolves.toBe(true);
    await expect(
      SuppressionService.isEmailSuppressed("x@example.com", other.id),
    ).resolves.toBe(false);
  });

  it("checks many emails at once, normalising case", async () => {
    await SuppressionService.addSuppression({
      email: "b@example.com",
      teamId,
      reason: "MANUAL",
    });

    const result = await SuppressionService.checkMultipleEmails(
      ["B@Example.com", "c@example.com"],
      teamId,
    );

    // Keyed by the caller's original string, matched against the normalised form.
    expect(result["B@Example.com"]).toBe(true);
    expect(result["c@example.com"]).toBeFalsy();
  });

  it("removes a suppression", async () => {
    await SuppressionService.addSuppression({
      email: "gone@example.com",
      teamId,
      reason: "MANUAL",
    });

    await SuppressionService.removeSuppression("gone@example.com", teamId);

    expect(await db.suppressionList.count()).toBe(0);
  });

  it("counts by reason, as numbers not bigint strings", async () => {
    await SuppressionService.addSuppression({
      email: "h1@example.com",
      teamId,
      reason: "HARD_BOUNCE",
    });
    await SuppressionService.addSuppression({
      email: "h2@example.com",
      teamId,
      reason: "HARD_BOUNCE",
    });
    await SuppressionService.addSuppression({
      email: "c1@example.com",
      teamId,
      reason: "COMPLAINT",
    });

    const stats = await SuppressionService.getSuppressionStats(teamId);

    // COUNT returns bigint; without the ::integer cast these are strings.
    expect(stats.HARD_BOUNCE).toBe(2);
    expect(typeof stats.HARD_BOUNCE).toBe("number");
    expect(stats.COMPLAINT).toBe(1);
    expect(stats.MANUAL).toBe(0);
  });

  it("lists with search, paging and sorting", async () => {
    for (const email of ["alpha@example.com", "beta@example.com", "gamma@example.com"]) {
      await SuppressionService.addSuppression({
        email,
        teamId,
        reason: "MANUAL",
      });
    }

    const searched = await SuppressionService.getSuppressionList({
      teamId,
      search: "BETA",
    });
    expect(searched.total).toBe(1);
    expect(searched.suppressions[0]?.email).toBe("beta@example.com");

    const sorted = await SuppressionService.getSuppressionList({
      teamId,
      sortBy: "email",
      sortOrder: "asc",
      limit: 2,
    });
    expect(sorted.total).toBe(3);
    expect(sorted.suppressions.map((s) => s.email)).toEqual([
      "alpha@example.com",
      "beta@example.com",
    ]);
  });

  it("bulk adds without duplicating existing entries", async () => {
    await SuppressionService.addSuppression({
      email: "dup@example.com",
      teamId,
      reason: "MANUAL",
    });

    await SuppressionService.addMultipleSuppressions(
      teamId,
      ["dup@example.com", "new@example.com", "NEW@example.com"],
      "HARD_BOUNCE",
    );

    expect(await db.suppressionList.count()).toBe(2);
  });

  it("tolerates a bulk add where everything is already suppressed", async () => {
    await SuppressionService.addSuppression({
      email: "only@example.com",
      teamId,
      reason: "MANUAL",
    });

    // Drizzle rejects an empty values list where Prisma's createMany accepted
    // one, so the empty batch has to be skipped explicitly.
    await expect(
      SuppressionService.addMultipleSuppressions(
        teamId,
        ["only@example.com"],
        "MANUAL",
      ),
    ).resolves.not.toThrow();

    expect(await db.suppressionList.count()).toBe(1);
  });
});
