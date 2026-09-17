import { generateRandomString } from "better-auth/crypto";

import { env } from "~/env";
import { sendSignUpEmail } from "~/server/mailer";

/**
 * better-auth configuration that does not depend on the database schema.
 *
 * Split out deliberately (issue #8): the tables better-auth needs do not exist
 * until the migration slice, but everything here — provider assembly, the OTP
 * contract, the session shape — is decided by `env` and by our own rules, so it
 * can be built and tested first. The `betterAuth()` instance that consumes it
 * lands with the schema.
 */

/**
 * Tables better-auth reads and writes, passed as `modelName`.
 *
 * PascalCase to match `Team`, `Domain`, `Email` and the rest of the schema.
 * better-auth's defaults are lowercase singular, but an internally consistent
 * schema beats matching someone else's convention in four tables out of forty.
 *
 * Column names are better-auth's own. The plan on #8 originally mapped them
 * onto the NextAuth column names (`sessionToken`, `providerAccountId`, …); that
 * existed only to keep existing rows readable and was dropped once the owner
 * confirmed there is no production data to preserve.
 */
export const AUTH_MODEL_NAMES = {
  user: "User",
  session: "Session",
  account: "Account",
  verification: "Verification",
} as const;

/**
 * Five lowercase alphanumerics, matching the `InputOTP` widget on the login
 * page, which renders exactly five slots under `REGEXP_ONLY_DIGITS_AND_CHARS`.
 */
export const SIGN_IN_OTP_LENGTH = 5;

/**
 * Ten minutes. NextAuth's `EmailProvider` defaulted to 24 hours, which is far
 * longer than a code a user is reading out of an open inbox needs to live.
 */
export const SIGN_IN_OTP_EXPIRES_IN_SECONDS = 10 * 60;

/**
 * Wrong guesses before the code is burned. 36^5 is ~60M, so the code alone is
 * not strong enough to be the only thing standing in the way — this is what
 * makes brute force impractical rather than merely slow.
 */
export const SIGN_IN_OTP_ALLOWED_ATTEMPTS = 3;

/**
 * Generates a sign-in code.
 *
 * Replaces `Math.random().toString(36).substring(2, 7)`, which was not a CSPRNG
 * and — because `Math.random()` can produce a short fractional part — could
 * occasionally return fewer than five characters. `generateRandomString` is
 * backed by `crypto.getRandomValues` and is exact about its length.
 */
export function generateSignInOtp() {
  return generateRandomString(SIGN_IN_OTP_LENGTH, "a-z", "0-9");
}

/**
 * Absolute base URL for links we put in emails.
 *
 * `NEXTAUTH_URL` is still the required one while NextAuth serves the auth
 * routes; the branch collapses to `BETTER_AUTH_URL` when NextAuth is removed.
 */
export function getAppBaseUrl() {
  return env.BETTER_AUTH_URL ?? env.NEXTAUTH_URL;
}

/**
 * The clickable half of the sign-in email.
 *
 * better-auth's `emailOTP` plugin has no magic-link URL of its own — it is a
 * code-only flow — so the link points at our own verify page, which submits the
 * code on the user's behalf. Keeping both affordances in one email preserves
 * the current experience without adopting the `magicLink` plugin, whose
 * token-only lookup would make a five-character code globally guessable rather
 * than guessable only for a known address (see #8 §5).
 */
export function buildOtpSignInUrl(email: string, otp: string) {
  const url = new URL("/login/verify", getAppBaseUrl());

  url.searchParams.set("email", email);
  url.searchParams.set("otp", otp);

  return url.toString();
}

/**
 * Wires better-auth's `sendVerificationOTP` to the existing mailer. The
 * signature of `sendSignUpEmail` is unchanged — it already takes the code and
 * the URL separately and renders both.
 */
export async function sendSignInOtp({
  email,
  otp,
}: {
  email: string;
  otp: string;
}) {
  await sendSignUpEmail(email, otp, buildOtpSignInUrl(email, otp));
}

/**
 * Which sign-in methods are configured.
 *
 * Replaces NextAuth's `getProviders()`, which the login and signup pages call
 * to decide what to render. better-auth has no equivalent, and this is the same
 * set of `env` checks the NextAuth provider list was built from.
 */
export function getEnabledAuthProviders() {
  return {
    github: Boolean(env.GITHUB_ID && env.GITHUB_SECRET),
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    email: Boolean(env.FROM_EMAIL),
  };
}

export type EnabledAuthProviders = ReturnType<typeof getEnabledAuthProviders>;

/**
 * Social providers in better-auth's shape.
 *
 * The `issuer` pinned on the NextAuth GitHub provider is gone: it worked around
 * NextAuth v4 rejecting the `iss` GitHub now returns on OAuth callbacks, and
 * better-auth has no such problem.
 */
export function getSocialProviders() {
  const providers: Record<string, { clientId: string; clientSecret: string }> =
    {};

  if (env.GITHUB_ID && env.GITHUB_SECRET) {
    providers.github = {
      clientId: env.GITHUB_ID,
      clientSecret: env.GITHUB_SECRET,
    };
  }

  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providers.google = {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    };
  }

  return providers;
}

/**
 * Providers whose email claim we trust enough to link to an existing account.
 *
 * This is the port of `allowDangerousEmailAccountLinking: true`, which was set
 * on both NextAuth providers. GitHub and Google both verify addresses before
 * asserting them, which is what makes the linking safe.
 */
export function getTrustedProviders() {
  return Object.keys(getSocialProviders());
}

/**
 * Whether this user is the installation's admin.
 *
 * Both sides must be non-empty. `env.ADMIN_EMAIL` is optional and `email` is
 * nullable, and an equality check alone would hand out admin on an install that
 * configured neither.
 */
export function isAdminEmail(email?: string | null) {
  return Boolean(env.ADMIN_EMAIL && email && email === env.ADMIN_EMAIL);
}

export type AuthUserRow = {
  id: string | number;
  email?: string | null;
  isBetaUser?: boolean | null;
  isWaitlisted?: boolean | null;
};

/**
 * Normalises better-auth's user onto the shape the app already consumes.
 *
 * The `id` cast is not cosmetic. better-auth's adapter factory coerces `id` and
 * every field referencing it with `String(newValue)` regardless of the column
 * type, so a numeric primary key still arrives as a string
 * (`@better-auth/core/dist/db/adapter/factory.mjs:161-162`). `User.id` is
 * `Int`, and `trpc.ts` feeds `session.user.id` straight into
 * `eq(schema.teamUser.userId, …)`, where a string silently matches nothing.
 * Converting once here keeps all twelve readers of `session.user.id` unchanged.
 */
export function toAppSessionUser<T extends AuthUserRow>(user: T) {
  const id = Number(user.id);

  if (!Number.isInteger(id)) {
    throw new Error(`Expected a numeric user id, got ${String(user.id)}`);
  }

  return {
    ...user,
    id,
    isBetaUser: Boolean(user.isBetaUser),
    isWaitlisted: Boolean(user.isWaitlisted),
    isAdmin: isAdminEmail(user.email),
  };
}
