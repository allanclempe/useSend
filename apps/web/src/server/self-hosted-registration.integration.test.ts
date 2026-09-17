import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { drizzleDb, schema } from "~/server/drizzle";
import { createId } from "~/server/drizzle/id";
import { withUpdatedAt } from "~/server/drizzle/touch";
import { createTeam, createUser } from "~/test/factories/core";
import {
  createSelfHostedUser,
  SelfHostedRegistrationError,
} from "~/server/self-hosted-registration";
import {
  closeIntegrationConnections,
  integrationEnabled,
  resetDatabase,
} from "~/test/integration/helpers";

const describeIntegration = integrationEnabled ? describe : describe.skip;

async function inviteEmail(email: string) {
  const team = await createTeam();

  await drizzleDb.insert(schema.teamInvite).values(
    withUpdatedAt({
      id: createId(),
      teamId: team.id,
      email,
      role: "MEMBER" as const,
    }),
  );
}

async function countUsers() {
  const rows = await drizzleDb.select({ id: schema.user.id }).from(schema.user);

  return rows.length;
}

describeIntegration("createSelfHostedUser", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeIntegrationConnections();
  });

  it("creates the bootstrap user without an invite", async () => {
    const created = await createSelfHostedUser({
      name: "First User",
      email: "first@example.com",
    });

    expect(created).toMatchObject({
      name: "First User",
      email: "first@example.com",
      emailVerified: false,
      image: null,
    });
    expect(created.id).toBeTypeOf("number");

    const [stored] = await drizzleDb
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, created.id));

    expect(stored?.email).toBe("first@example.com");
  });

  it("stores the empty name better-auth sends when a provider gives none", async () => {
    const created = await createSelfHostedUser({ email: "first@example.com" });

    expect(created.name).toBe("");
  });

  it("carries emailVerified through", async () => {
    const created = await createSelfHostedUser({
      email: "first@example.com",
      emailVerified: true,
    });

    expect(created.emailVerified).toBe(true);
  });

  it("creates an invited user once the installation is no longer empty", async () => {
    await createUser({ email: "existing@example.com" });
    await inviteEmail("invited@example.com");

    const created = await createSelfHostedUser({
      name: "Invited",
      email: "invited@example.com",
    });

    expect(created.email).toBe("invited@example.com");
    await expect(countUsers()).resolves.toBe(2);
  });

  it("rejects an uninvited user and writes no row", async () => {
    await createUser({ email: "existing@example.com" });

    await expect(
      createSelfHostedUser({ name: "Nope", email: "random@example.com" }),
    ).rejects.toBeInstanceOf(SelfHostedRegistrationError);

    await expect(countUsers()).resolves.toBe(1);
  });

  it("matches an invite regardless of which team issued it", async () => {
    await createUser({ email: "existing@example.com" });
    await inviteEmail("invited@example.com");
    await inviteEmail("someone-else@example.com");

    await expect(
      createSelfHostedUser({ email: "invited@example.com" }),
    ).resolves.toMatchObject({ email: "invited@example.com" });
  });

  // The reason the advisory lock exists. Without it both transactions read an
  // empty User table, both conclude they are the bootstrap account, and the
  // installation ends up with two uninvited users.
  it("lets only one of two concurrent bootstrap registrations through", async () => {
    const results = await Promise.allSettled([
      createSelfHostedUser({ name: "A", email: "a@example.com" }),
      createSelfHostedUser({ name: "B", email: "b@example.com" }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      SelfHostedRegistrationError,
    );
    await expect(countUsers()).resolves.toBe(1);
  });

  it("lets concurrent invited registrations both through", async () => {
    await createUser({ email: "existing@example.com" });
    await inviteEmail("a@example.com");
    await inviteEmail("b@example.com");

    await Promise.all([
      createSelfHostedUser({ name: "A", email: "a@example.com" }),
      createSelfHostedUser({ name: "B", email: "b@example.com" }),
    ]);

    await expect(countUsers()).resolves.toBe(3);
  });
});
