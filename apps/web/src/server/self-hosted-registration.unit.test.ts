import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: { NEXT_PUBLIC_IS_CLOUD: true },
}));

vi.mock("~/env", () => ({ env: mocks.env }));

// Any database access at all fails the test. The one branch this suite owns is
// the cloud short-circuit, and "short-circuit" is precisely the claim that no
// query runs — asserting on a mocked query builder would restate the call
// instead of proving it never happened. Every other branch is an integration
// test against the real database.
vi.mock("~/server/drizzle", () => ({
  // eslint-disable-next-line no-undef
  drizzleDb: new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(
          `self-hosted registration touched the database (drizzleDb.${String(property)})`,
        );
      },
    },
  ),
  schema: {},
}));

import { canRegisterSelfHostedUser } from "~/server/self-hosted-registration";

describe("canRegisterSelfHostedUser", () => {
  beforeEach(() => {
    mocks.env.NEXT_PUBLIC_IS_CLOUD = true;
  });

  it("allows anyone on cloud without consulting the database", async () => {
    await expect(canRegisterSelfHostedUser("anyone@example.com")).resolves.toBe(
      true,
    );
  });

  it("allows a cloud sign-in with no email and no account", async () => {
    await expect(canRegisterSelfHostedUser()).resolves.toBe(true);
  });

  it("consults the database once self-hosted", async () => {
    mocks.env.NEXT_PUBLIC_IS_CLOUD = false;

    await expect(
      canRegisterSelfHostedUser("anyone@example.com"),
    ).rejects.toThrow(/touched the database/);
  });
});
