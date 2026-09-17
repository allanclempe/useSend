import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "~/server/db";
import { drizzleDb, schema } from "~/server/drizzle";
import {
  closeIntegrationConnections,
  integrationEnabled,
  resetDatabase,
} from "~/test/integration/helpers";

const describeIntegration = integrationEnabled ? describe : describe.skip;

/**
 * The Drizzle schema is introspected from the live database rather than
 * hand-ported, but introspection is not proof. These read the same rows through
 * both clients and assert the two agree on the things the migration actually
 * depends on: integer primary keys, Date-typed timestamps, enums, and arrays.
 */
describeIntegration("drizzle schema matches prisma", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeIntegrationConnections();
  });

  it("round-trips a team written by prisma", async () => {
    const created = await db.team.create({ data: { name: "acme" } });

    const [row] = await drizzleDb
      .select()
      .from(schema.team)
      .where(eq(schema.team.id, created.id));

    expect(row).toBeDefined();
    expect(row?.name).toBe("acme");
    expect(row?.plan).toBe(created.plan);
    expect(row?.apiRateLimit).toBe(created.apiRateLimit);
  });

  it("keeps integer primary keys as numbers, not strings", async () => {
    const created = await db.team.create({ data: { name: "ints" } });

    const [row] = await drizzleDb
      .select()
      .from(schema.team)
      .where(eq(schema.team.id, created.id));

    expect(typeof created.id).toBe("number");
    expect(typeof row?.id).toBe("number");
    expect(row?.id).toBe(created.id);
  });

  it("returns timestamps as Date, matching prisma", async () => {
    const created = await db.team.create({ data: { name: "dates" } });

    const [row] = await drizzleDb
      .select()
      .from(schema.team)
      .where(eq(schema.team.id, created.id));

    // drizzle-kit defaults these to mode:'string'; scripts/drizzle-pull.js
    // rewrites them to mode:'date' so date arithmetic keeps working.
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(row?.createdAt.getTime()).toBe(created.createdAt.getTime());
  });

  it("writes through drizzle are visible to prisma", async () => {
    const [inserted] = await drizzleDb
      .insert(schema.team)
      .values({ name: "written-by-drizzle", updatedAt: new Date() })
      .returning();

    expect(inserted).toBeDefined();

    const viaPrisma = await db.team.findUnique({
      where: { id: inserted!.id },
    });

    expect(viaPrisma?.name).toBe("written-by-drizzle");
  });

  it("agrees on enum columns", async () => {
    const created = await db.team.create({
      data: { name: "enums", plan: "BASIC" },
    });

    const [row] = await drizzleDb
      .select()
      .from(schema.team)
      .where(eq(schema.team.id, created.id));

    expect(row?.plan).toBe("BASIC");
    expect(created.plan).toBe("BASIC");
  });

  it("defaults Webhook.domainIds to an empty array", async () => {
    // drizzle-kit mangles this column's ARRAY[]::integer[] default into
    // `.default([RAY])`; the pull script repairs it. Guard against regressions.
    const team = await db.team.create({ data: { name: "arrays" } });
    const webhook = await db.webhook.create({
      data: {
        teamId: team.id,
        url: "https://example.com/hook",
        secret: "s",
        eventTypes: ["email.sent"],
      },
    });

    const [row] = await drizzleDb
      .select()
      .from(schema.webhook)
      .where(eq(schema.webhook.id, webhook.id));

    expect(row?.domainIds).toEqual([]);
    expect(webhook.domainIds).toEqual([]);
  });
});
