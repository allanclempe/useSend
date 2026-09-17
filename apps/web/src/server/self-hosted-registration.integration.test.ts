import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const mocks = vi.hoisted(() => ({ isCloud: false }));

// This module only does anything when `NEXT_PUBLIC_IS_CLOUD` is false, so the
// suite has to leave the cloud default described in AGENTS.md. Everything other
// than that one flag stays real — the tests run against the real database.
vi.mock("~/env", async (importOriginal) => {
  const actual = await importOriginal<{ env: Record<string, unknown> }>();

  return {
    // eslint-disable-next-line no-undef
    env: new Proxy(actual.env, {
      get: (target, property) =>
        property === "NEXT_PUBLIC_IS_CLOUD"
          ? mocks.isCloud
          : Reflect.get(target, property),
    }),
  };
});

import { drizzleDb, schema } from "~/server/drizzle";
import { createId } from "~/server/drizzle/id";
import { withUpdatedAt } from "~/server/drizzle/touch";
import { createTeam, createUser } from "~/test/factories/core";
import {
  canRegisterSelfHostedUser,
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

describeIntegration("self-hosted registration", () => {
  beforeEach(async () => {
    await resetDatabase();
    mocks.isCloud = false;
  });

  afterAll(async () => {
    await closeIntegrationConnections();
  });

  describe("canRegisterSelfHostedUser", () => {
    it("allows the first user without an invite", async () => {
      await expect(
        canRegisterSelfHostedUser("first@example.com"),
      ).resolves.toBe(true);
    });

    it("allows an existing user to sign in without an invite", async () => {
      await createUser({ email: "existing@example.com" });
      await createUser({ email: "someone-else@example.com" });

      await expect(
        canRegisterSelfHostedUser("existing@example.com"),
      ).resolves.toBe(true);
    });

    it("allows an existing OAuth account to sign in without an email", async () => {
      const user = await createUser({ email: "linked@example.com" });

      await drizzleDb.insert(schema.account).values({
        id: createId(),
        userId: user.id,
        type: "oauth",
        provider: "github",
        providerAccountId: "github-user-id",
      });

      await expect(
        canRegisterSelfHostedUser(null, {
          provider: "github",
          providerAccountId: "github-user-id",
          type: "oauth",
        }),
      ).resolves.toBe(true);
    });

    it("does not match an OAuth account belonging to another provider", async () => {
      const user = await createUser({ email: "linked@example.com" });

      await drizzleDb.insert(schema.account).values({
        id: createId(),
        userId: user.id,
        type: "oauth",
        provider: "google",
        providerAccountId: "github-user-id",
      });

      await expect(
        canRegisterSelfHostedUser(null, {
          provider: "github",
          providerAccountId: "github-user-id",
          type: "oauth",
        }),
      ).resolves.toBe(false);
    });

    it("allows a new user with a matching invite", async () => {
      await createUser({ email: "existing@example.com" });
      await inviteEmail("invited@example.com");

      await expect(
        canRegisterSelfHostedUser("invited@example.com"),
      ).resolves.toBe(true);
    });

    it("rejects a new user without a matching invite", async () => {
      await createUser({ email: "existing@example.com" });

      await expect(
        canRegisterSelfHostedUser("random@example.com"),
      ).resolves.toBe(false);
    });

    it("allows the first account when the provider returns no email", async () => {
      await expect(canRegisterSelfHostedUser(null)).resolves.toBe(true);
    });

    it("rejects a later account when the provider returns no email", async () => {
      await createUser({ email: "existing@example.com" });

      await expect(canRegisterSelfHostedUser(null)).resolves.toBe(false);
    });

    it("allows anyone on cloud", async () => {
      mocks.isCloud = true;
      await createUser({ email: "existing@example.com" });

      await expect(
        canRegisterSelfHostedUser("random@example.com"),
      ).resolves.toBe(true);
    });
  });

  describe("createSelfHostedUser", () => {
    it("creates the bootstrap user", async () => {
      const created = await createSelfHostedUser({
        name: "First User",
        email: "first@example.com",
        emailVerified: null,
        image: null,
      });

      expect(created).toMatchObject({
        name: "First User",
        email: "first@example.com",
        emailVerified: null,
        image: null,
      });
      expect(created.id).toBeTypeOf("number");

      const [stored] = await drizzleDb
        .select()
        .from(schema.user)
        .where(eq(schema.user.id, created.id));

      expect(stored?.email).toBe("first@example.com");
    });

    it("creates the bootstrap user when the provider returns no email", async () => {
      const created = await createSelfHostedUser({ name: "First User" });

      expect(created.email).toBeNull();
      await expect(countUsers()).resolves.toBe(1);
    });

    it("creates an invited user", async () => {
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

    it("rejects a later user without an email and writes no row", async () => {
      await createUser({ email: "existing@example.com" });

      await expect(
        createSelfHostedUser({ name: "Nope" }),
      ).rejects.toBeInstanceOf(SelfHostedRegistrationError);

      await expect(countUsers()).resolves.toBe(1);
    });

    // The reason the advisory lock exists. Without it both transactions read an
    // empty User table, both conclude they are the bootstrap account, and the
    // installation ends up with two uninvited users.
    it("lets only one of two concurrent bootstrap registrations through", async () => {
      const results = await Promise.allSettled([
        createSelfHostedUser({ name: "A", email: "a@example.com" }),
        createSelfHostedUser({ name: "B", email: "b@example.com" }),
      ]);

      const fulfilled = results.filter(
        (result) => result.status === "fulfilled",
      );
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
});
