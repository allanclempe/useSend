import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterUser } from "next-auth/adapters";

const mocks = vi.hoisted(() => {
  const env = {
    GITHUB_ID: "github-client-id",
    GITHUB_SECRET: "github-client-secret",
    NEXT_PUBLIC_IS_CLOUD: true,
  };

  return {
    env,
    baseCreateUser: vi.fn(),
    createSelfHostedUser: vi.fn(),
  };
});

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@auth/prisma-adapter", () => ({
  PrismaAdapter: vi.fn(() => ({ createUser: mocks.baseCreateUser })),
}));

vi.mock("next-auth/providers/github", () => ({
  default: vi.fn((options) => ({ id: "github", options })),
}));

vi.mock("next-auth/providers/google", () => ({
  default: vi.fn((options) => ({ id: "google", options })),
}));

vi.mock("next-auth/providers/email", () => ({
  default: vi.fn((options) => ({ id: "email", options })),
}));

vi.mock("~/server/db", () => ({ db: {} }));

// The registration policy itself is covered by
// `self-hosted-registration.integration.test.ts` against the real database.
// What `auth.ts` still owns is which of the two creation paths it picks.
vi.mock("~/server/self-hosted-registration", () => ({
  canRegisterSelfHostedUser: vi.fn(),
  createSelfHostedUser: mocks.createSelfHostedUser,
}));

vi.mock("~/server/mailer", () => ({
  sendSignUpEmail: vi.fn(),
}));

vi.mock("~/env", () => ({ env: mocks.env }));

import { authOptions } from "~/server/auth";

const newUser = {
  id: "new-user",
  name: "New User",
  email: "new@example.com",
  emailVerified: null,
  image: null,
  isBetaUser: false,
  isWaitlisted: false,
  isAdmin: false,
} as unknown as AdapterUser;

describe("authOptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.NEXT_PUBLIC_IS_CLOUD = true;
  });

  it("configures the GitHub provider with an explicit issuer", () => {
    const githubProvider = authOptions.providers.find(
      (provider) => provider.id === "github",
    );

    expect(githubProvider).toMatchObject({
      id: "github",
      options: {
        clientId: "github-client-id",
        clientSecret: "github-client-secret",
        issuer: "https://github.com/login/oauth",
      },
    });
  });

  describe("adapter user creation", () => {
    const createUser = authOptions.adapter?.createUser;

    if (!createUser) {
      throw new Error("Expected the auth adapter to support user creation");
    }

    it("creates cloud users through the Prisma adapter", async () => {
      mocks.baseCreateUser.mockResolvedValue({ ...newUser, id: 1 });

      await expect(createUser(newUser)).resolves.toMatchObject({ id: 1 });

      expect(mocks.baseCreateUser).toHaveBeenCalledWith(newUser);
      expect(mocks.createSelfHostedUser).not.toHaveBeenCalled();
    });

    it("creates self-hosted users through the gated path", async () => {
      mocks.env.NEXT_PUBLIC_IS_CLOUD = false;
      mocks.createSelfHostedUser.mockResolvedValue({ ...newUser, id: 2 });

      await expect(createUser(newUser)).resolves.toMatchObject({ id: 2 });

      expect(mocks.createSelfHostedUser).toHaveBeenCalledWith(newUser);
      expect(mocks.baseCreateUser).not.toHaveBeenCalled();
    });

    it("propagates a rejected self-hosted registration", async () => {
      mocks.env.NEXT_PUBLIC_IS_CLOUD = false;
      mocks.createSelfHostedUser.mockRejectedValue(new Error("no invite"));

      await expect(createUser(newUser)).rejects.toThrow("no invite");
      expect(mocks.baseCreateUser).not.toHaveBeenCalled();
    });
  });
});
