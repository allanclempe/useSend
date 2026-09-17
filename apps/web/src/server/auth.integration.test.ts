import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const mocks = vi.hoisted(() => ({
  isCloud: true,
  adminEmail: undefined as string | undefined,
  sendSignUpEmail: vi.fn(),
}));

// `NEXT_PUBLIC_IS_CLOUD` and `ADMIN_EMAIL` are the two switches the auth path
// branches on, so the suite has to move them. Everything else stays real --
// these tests run against the real database and the real better-auth instance.
vi.mock("~/env", async (importOriginal) => {
  const actual = await importOriginal<{ env: Record<string, unknown> }>();

  return {
    // eslint-disable-next-line no-undef
    env: new Proxy(actual.env, {
      get: (target, property) => {
        if (property === "NEXT_PUBLIC_IS_CLOUD") return mocks.isCloud;
        if (property === "ADMIN_EMAIL") return mocks.adminEmail;
        return Reflect.get(target, property);
      },
    }),
  };
});

vi.mock("~/server/mailer", () => ({
  sendSignUpEmail: mocks.sendSignUpEmail,
  sendMail: vi.fn(),
  sendTeamInviteEmail: vi.fn(),
}));

import { auth } from "~/server/auth";
import { drizzleDb, schema } from "~/server/drizzle";
import { createId } from "~/server/drizzle/id";
import { withUpdatedAt } from "~/server/drizzle/touch";
import { createTeam, createUser } from "~/test/factories/core";
import {
  closeIntegrationConnections,
  integrationEnabled,
  resetDatabase,
} from "~/test/integration/helpers";

const describeIntegration = integrationEnabled ? describe : describe.skip;

/** Drives the real sign-in flow and returns the code that was emailed. */
async function requestOtp(email: string) {
  await auth.api.sendVerificationOTP({
    body: { email, type: "sign-in" },
  });

  const call = mocks.sendSignUpEmail.mock.calls.at(-1);

  if (!call) {
    throw new Error("No sign-in email was sent");
  }

  return call[1] as string;
}

async function signIn(email: string) {
  const otp = await requestOtp(email);

  return auth.api.signInEmailOTP({
    body: { email, otp },
    returnHeaders: true,
  });
}

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

describeIntegration("auth", () => {
  beforeEach(async () => {
    await resetDatabase();
    vi.clearAllMocks();
    mocks.isCloud = true;
    mocks.adminEmail = undefined;
  });

  afterAll(async () => {
    await closeIntegrationConnections();
  });

  describe("email OTP sign-in", () => {
    it("creates the user and a session", async () => {
      const { response } = await signIn("person@example.com");

      expect(response.user).toMatchObject({ email: "person@example.com" });

      const [stored] = await drizzleDb
        .select()
        .from(schema.user)
        .where(eq(schema.user.email, "person@example.com"));

      expect(stored).toMatchObject({
        email: "person@example.com",
        // Signing in with a code proves control of the address.
        emailVerified: true,
      });

      const sessions = await drizzleDb
        .select()
        .from(schema.session)
        .where(eq(schema.session.userId, stored!.id));

      expect(sessions).toHaveLength(1);
    });

    it("emails a five-character code and a link carrying it", async () => {
      const otp = await requestOtp("person@example.com");

      expect(otp).toMatch(/^[a-z0-9]{5}$/);

      const [, , url] = mocks.sendSignUpEmail.mock.calls.at(-1)!;

      expect(String(url)).toContain(`otp=${otp}`);
      expect(String(url)).toContain("person%40example.com");
    });

    it("does not store the code in the clear", async () => {
      const otp = await requestOtp("person@example.com");

      const rows = await drizzleDb.select().from(schema.verification);

      expect(rows).toHaveLength(1);
      expect(rows[0]!.value).not.toContain(otp);
    });

    it("rejects a wrong code", async () => {
      await requestOtp("person@example.com");

      await expect(
        auth.api.signInEmailOTP({
          body: { email: "person@example.com", otp: "zzzzz" },
        }),
      ).rejects.toThrow();

      await expect(
        drizzleDb.select().from(schema.user),
      ).resolves.toHaveLength(0);
    });

    it("signs an existing user in without creating a second row", async () => {
      await signIn("person@example.com");
      await signIn("person@example.com");

      const users = await drizzleDb.select().from(schema.user);

      expect(users).toHaveLength(1);
    });
  });

  describe("session shape", () => {
    it("hands back a numeric id, not better-auth's stringified one", async () => {
      const { headers } = await signIn("person@example.com");

      const session = await auth.api.getSession({
        headers: new Headers({
          cookie: headers.get("set-cookie")!.split(";")[0]!,
        }),
      });

      expect(session?.user.id).toBeTypeOf("number");
      expect(session?.user).toMatchObject({
        email: "person@example.com",
        isBetaUser: true,
        isAdmin: false,
      });
    });

    it("marks the configured admin", async () => {
      mocks.adminEmail = "admin@usesend.com";

      const { headers } = await signIn("admin@usesend.com");

      const session = await auth.api.getSession({
        headers: new Headers({
          cookie: headers.get("set-cookie")!.split(";")[0]!,
        }),
      });

      expect(session?.user.isAdmin).toBe(true);
    });
  });

  describe("waitlist", () => {
    it("waitlists an uninvited cloud signup", async () => {
      await signIn("person@example.com");

      const [stored] = await drizzleDb.select().from(schema.user);

      expect(stored).toMatchObject({ isBetaUser: true, isWaitlisted: true });
    });

    it("does not waitlist someone holding an invite", async () => {
      await inviteEmail("invited@example.com");

      await signIn("invited@example.com");

      const [stored] = await drizzleDb
        .select()
        .from(schema.user)
        .where(eq(schema.user.email, "invited@example.com"));

      expect(stored).toMatchObject({ isBetaUser: true, isWaitlisted: false });
    });
  });

  describe("self-hosted registration gating", () => {
    beforeEach(() => {
      mocks.isCloud = false;
    });

    it("lets the bootstrap account in", async () => {
      const { response } = await signIn("first@example.com");

      expect(response.user).toMatchObject({ email: "first@example.com" });
    });

    it("never waitlists on self-hosted", async () => {
      await signIn("first@example.com");

      const [stored] = await drizzleDb.select().from(schema.user);

      expect(stored).toMatchObject({ isBetaUser: true, isWaitlisted: false });
    });

    it("refuses an uninvited second account", async () => {
      await createUser({ email: "existing@example.com" });

      await expect(signIn("random@example.com")).rejects.toMatchObject({
        body: { code: "REGISTRATION_NOT_ALLOWED" },
      });

      const users = await drizzleDb
        .select()
        .from(schema.user)
        .where(eq(schema.user.email, "random@example.com"));

      expect(users).toHaveLength(0);
    });

    it("admits an invited second account", async () => {
      await createUser({ email: "existing@example.com" });
      await inviteEmail("invited@example.com");

      const { response } = await signIn("invited@example.com");

      expect(response.user).toMatchObject({ email: "invited@example.com" });
    });

    it("lets an existing user sign in without an invite", async () => {
      await createUser({ email: "existing@example.com" });
      await createUser({ email: "another@example.com" });

      const { response } = await signIn("existing@example.com");

      expect(response.user).toMatchObject({ email: "existing@example.com" });
    });
  });
});
