import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {
    GITHUB_ID: undefined as string | undefined,
    GITHUB_SECRET: undefined as string | undefined,
    GOOGLE_CLIENT_ID: undefined as string | undefined,
    GOOGLE_CLIENT_SECRET: undefined as string | undefined,
    FROM_EMAIL: undefined as string | undefined,
    ADMIN_EMAIL: undefined as string | undefined,
    NEXTAUTH_URL: "http://localhost:3000",
    BETTER_AUTH_URL: undefined as string | undefined,
  },
  sendSignUpEmail: vi.fn(),
}));

vi.mock("~/env", () => ({ env: mocks.env }));

vi.mock("~/server/mailer", () => ({
  sendSignUpEmail: mocks.sendSignUpEmail,
}));

import {
  AUTH_MODEL_NAMES,
  SIGN_IN_OTP_LENGTH,
  buildOtpSignInUrl,
  generateSignInOtp,
  getAppBaseUrl,
  getEnabledAuthProviders,
  getSocialProviders,
  getTrustedProviders,
  isAdminEmail,
  sendSignInOtp,
  toAppSessionUser,
} from "~/server/better-auth";

describe("better-auth configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.env, {
      GITHUB_ID: undefined,
      GITHUB_SECRET: undefined,
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      FROM_EMAIL: undefined,
      ADMIN_EMAIL: undefined,
      NEXTAUTH_URL: "http://localhost:3000",
      BETTER_AUTH_URL: undefined,
    });
  });

  describe("model names", () => {
    it("keeps the schema's PascalCase table names", () => {
      expect(AUTH_MODEL_NAMES).toEqual({
        user: "User",
        session: "Session",
        account: "Account",
        verification: "Verification",
      });
    });
  });

  describe("generateSignInOtp", () => {
    it("always produces exactly the length the OTP widget renders", () => {
      // The predecessor sliced `Math.random().toString(36)`, which could come
      // up short when the fractional part was.
      const codes = Array.from({ length: 500 }, generateSignInOtp);

      for (const code of codes) {
        expect(code).toHaveLength(SIGN_IN_OTP_LENGTH);
        expect(code).toMatch(/^[a-z0-9]{5}$/);
      }
    });

    it("does not repeat itself", () => {
      const codes = new Set(Array.from({ length: 500 }, generateSignInOtp));

      // 36^5 possibilities; 500 draws colliding more than a handful of times
      // would mean the generator is not doing its job.
      expect(codes.size).toBeGreaterThan(490);
    });
  });

  describe("sign-in URL", () => {
    it("points at the verify page with the code attached", () => {
      expect(buildOtpSignInUrl("person@example.com", "ab12c")).toBe(
        "http://localhost:3000/login/verify?email=person%40example.com&otp=ab12c",
      );
    });

    it("escapes an address that would otherwise break the query string", () => {
      const url = new URL(buildOtpSignInUrl("a+b@example.com", "ab12c"));

      expect(url.searchParams.get("email")).toBe("a+b@example.com");
    });

    it("prefers BETTER_AUTH_URL when it is set", () => {
      mocks.env.BETTER_AUTH_URL = "https://app.usesend.com";

      expect(getAppBaseUrl()).toBe("https://app.usesend.com");
      expect(buildOtpSignInUrl("person@example.com", "ab12c")).toBe(
        "https://app.usesend.com/login/verify?email=person%40example.com&otp=ab12c",
      );
    });
  });

  describe("sendSignInOtp", () => {
    it("hands the mailer the code and the link", async () => {
      await sendSignInOtp({ email: "person@example.com", otp: "ab12c" });

      expect(mocks.sendSignUpEmail).toHaveBeenCalledWith(
        "person@example.com",
        "ab12c",
        "http://localhost:3000/login/verify?email=person%40example.com&otp=ab12c",
      );
    });
  });

  describe("getEnabledAuthProviders", () => {
    it("reports nothing configured on a bare install", () => {
      expect(getEnabledAuthProviders()).toEqual({
        github: false,
        google: false,
        email: false,
      });
    });

    it("needs both halves of an OAuth credential pair", () => {
      mocks.env.GITHUB_ID = "github-client-id";

      expect(getEnabledAuthProviders().github).toBe(false);

      mocks.env.GITHUB_SECRET = "github-client-secret";

      expect(getEnabledAuthProviders().github).toBe(true);
    });

    it("enables email sign-in from FROM_EMAIL", () => {
      mocks.env.FROM_EMAIL = "hello@usesend.com";

      expect(getEnabledAuthProviders().email).toBe(true);
    });
  });

  describe("getSocialProviders", () => {
    it("omits providers that are not configured", () => {
      mocks.env.GOOGLE_CLIENT_ID = "google-client-id";
      mocks.env.GOOGLE_CLIENT_SECRET = "google-client-secret";

      expect(getSocialProviders()).toEqual({
        google: {
          clientId: "google-client-id",
          clientSecret: "google-client-secret",
        },
      });
    });

    it("trusts exactly the providers it configures", () => {
      expect(getTrustedProviders()).toEqual([]);

      mocks.env.GITHUB_ID = "github-client-id";
      mocks.env.GITHUB_SECRET = "github-client-secret";

      expect(getTrustedProviders()).toEqual(["github"]);
    });
  });

  describe("isAdminEmail", () => {
    it("is false for everyone when no admin is configured", () => {
      expect(isAdminEmail(undefined)).toBe(false);
      expect(isAdminEmail(null)).toBe(false);
      expect(isAdminEmail("person@example.com")).toBe(false);
    });

    it("matches only the configured address", () => {
      mocks.env.ADMIN_EMAIL = "admin@usesend.com";

      expect(isAdminEmail("admin@usesend.com")).toBe(true);
      expect(isAdminEmail("person@example.com")).toBe(false);
      expect(isAdminEmail(null)).toBe(false);
    });
  });

  describe("toAppSessionUser", () => {
    it("turns better-auth's stringified id back into a number", () => {
      // better-auth's adapter factory runs String() over `id` and every field
      // referencing it, whatever the column type.
      const user = toAppSessionUser({ id: "42", email: "person@example.com" });

      expect(user.id).toBe(42);
      expect(user.id).toBeTypeOf("number");
    });

    it("leaves a numeric id alone", () => {
      expect(toAppSessionUser({ id: 42 }).id).toBe(42);
    });

    it("refuses an id that is not a number rather than passing on NaN", () => {
      expect(() => toAppSessionUser({ id: "cuid_not_a_number" })).toThrow(
        /numeric user id/,
      );
    });

    it("normalises the flags the session consumers read", () => {
      mocks.env.ADMIN_EMAIL = "admin@usesend.com";

      expect(
        toAppSessionUser({
          id: "7",
          email: "admin@usesend.com",
          isBetaUser: true,
          isWaitlisted: null,
        }),
      ).toMatchObject({
        id: 7,
        isAdmin: true,
        isBetaUser: true,
        isWaitlisted: false,
      });
    });

    it("keeps fields it does not know about", () => {
      expect(toAppSessionUser({ id: "1", name: "Someone" })).toMatchObject({
        name: "Someone",
      });
    });
  });
});
