import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { customSession, emailOTP } from "better-auth/plugins";
import { eq } from "drizzle-orm";

import { env } from "~/env";
import { publicEnv } from "~/env.public";
import { drizzleDb, schema } from "~/server/drizzle";
import {
  AUTH_MODEL_NAMES,
  SIGN_IN_OTP_ALLOWED_ATTEMPTS,
  SIGN_IN_OTP_EXPIRES_IN_SECONDS,
  SIGN_IN_OTP_LENGTH,
  generateSignInOtp,
  getSocialProviders,
  getTrustedProviders,
  sendSignInOtp,
  toAppSessionUser,
} from "~/server/better-auth";
import {
  createSelfHostedUser,
  SelfHostedRegistrationError,
} from "~/server/self-hosted-registration";

/**
 * Tables, keyed by the name better-auth will ask for.
 *
 * The Drizzle adapter looks up `config.schema[modelName]`, and `modelName` is
 * what we set below — so these keys are the PascalCase table names, not
 * better-auth's lowercase model names.
 */
const authTables = {
  [AUTH_MODEL_NAMES.user]: schema.user,
  [AUTH_MODEL_NAMES.session]: schema.session,
  [AUTH_MODEL_NAMES.account]: schema.account,
  [AUTH_MODEL_NAMES.verification]: schema.verification,
};

const baseAdapter = drizzleAdapter(drizzleDb, {
  provider: "pg",
  transaction: true,
  schema: authTables,
});

type AuthAdapter = ReturnType<typeof baseAdapter>;

/**
 * Wraps the Drizzle adapter so self-hosted user creation runs inside a
 * transaction holding `pg_advisory_xact_lock`.
 *
 * This has to happen at the adapter, not in a `databaseHooks` entry.
 * `createWithHooks` runs `user.create.before` and *then* calls
 * `adapter.create` (`better-auth/dist/db/with-hooks.mjs:7-41`); the hook never
 * sees the transaction, so a lock taken there commits and releases before the
 * insert it is supposed to protect, and the race it exists to prevent reopens.
 *
 * At this level the payload is in better-auth's field names and the return
 * value has to look like better-auth's own output — which means `id` as a
 * string, since the factory's `transformOutput` has already run by the time we
 * intercept (`@better-auth/core/dist/db/adapter/factory.mjs:161-162`).
 */
const authDatabase = (
  options: Parameters<typeof baseAdapter>[0],
): AuthAdapter => {
  const adapter = baseAdapter(options);

  return {
    ...adapter,
    create: async (args) => {
      if (args.model !== "user" || publicEnv.NEXT_PUBLIC_IS_CLOUD) {
        return adapter.create(args);
      }

      const data = args.data as Record<string, unknown>;
      const email = data.email;

      if (typeof email !== "string" || email.length === 0) {
        throw new APIError("BAD_REQUEST", {
          code: "EMAIL_REQUIRED",
          message: "An email address is required to create an account",
        });
      }

      try {
        const created = await createSelfHostedUser({
          email,
          name: typeof data.name === "string" ? data.name : null,
          emailVerified: data.emailVerified === true,
          image: typeof data.image === "string" ? data.image : null,
        });

        return { ...created, id: String(created.id) } as never;
      } catch (error) {
        if (error instanceof SelfHostedRegistrationError) {
          throw new APIError("FORBIDDEN", {
            code: "REGISTRATION_NOT_ALLOWED",
            message: error.message,
          });
        }

        throw error;
      }
    },
  };
};

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  // `APP_URL`, not a `BETTER_AUTH_URL` of its own. better-auth's base URL is
  // the application's public base URL by definition — a second name for it only
  // created the chance for the two to disagree (issue #59). Always passing it
  // also means better-auth never has to infer the origin from request headers,
  // which is the thing that goes wrong behind a reverse proxy.
  baseURL: env.APP_URL,
  database: authDatabase,
  // `User.id` is `Int @default(autoincrement())` and stays that way — see #8.
  // This makes better-auth leave `id` out of inserts so Postgres assigns it,
  // and coerce it back to a number on lookup.
  advanced: { database: { generateId: "serial" } },
  user: {
    modelName: AUTH_MODEL_NAMES.user,
    additionalFields: {
      isBetaUser: { type: "boolean", input: false, defaultValue: false },
      isWaitlisted: { type: "boolean", input: false, defaultValue: false },
    },
  },
  session: { modelName: AUTH_MODEL_NAMES.session },
  account: {
    modelName: AUTH_MODEL_NAMES.account,
    // The port of `allowDangerousEmailAccountLinking`, which was set on both
    // NextAuth providers. GitHub and Google both verify an address before
    // asserting it, which is what makes linking on email safe.
    accountLinking: { enabled: true, trustedProviders: getTrustedProviders() },
  },
  verification: { modelName: AUTH_MODEL_NAMES.verification },
  socialProviders: getSocialProviders(),
  databaseHooks: {
    user: {
      create: {
        // The port of NextAuth's `events.createUser`. Everyone is a beta user;
        // cloud additionally waitlists anyone who arrived without an invite.
        after: async (user) => {
          const invites = await drizzleDb
            .select({ id: schema.teamInvite.id })
            .from(schema.teamInvite)
            .where(eq(schema.teamInvite.email, user.email))
            .limit(1);

          const isWaitlisted =
            publicEnv.NEXT_PUBLIC_IS_CLOUD &&
            env.NODE_ENV !== "development" &&
            invites.length === 0;

          await drizzleDb
            .update(schema.user)
            .set({ isBetaUser: true, isWaitlisted, updatedAt: new Date() })
            .where(eq(schema.user.id, Number(user.id)));
        },
      },
    },
  },
  plugins: [
    emailOTP({
      otpLength: SIGN_IN_OTP_LENGTH,
      expiresIn: SIGN_IN_OTP_EXPIRES_IN_SECONDS,
      allowedAttempts: SIGN_IN_OTP_ALLOWED_ATTEMPTS,
      // The code is the whole credential, so it does not sit in the database in
      // the clear. NextAuth's `VerificationToken` stored it plainly.
      storeOTP: "hashed",
      generateOTP: () => generateSignInOtp(),
      sendVerificationOTP: async ({ email, otp }) => {
        await sendSignInOtp({ email, otp });
      },
    }),
    customSession(async ({ user, session }) => ({
      session,
      user: toAppSessionUser(user),
    })),
  ],
});

/**
 * Wrapper for the session lookup, so callers don't reach for `auth.api`
 * themselves. Keeps the name `getServerAuthSession` had under NextAuth.
 *
 * **The headers are an argument, not something this reads for itself.** They
 * used to come from `next/headers`, which does not exist on Workers and which
 * a Vite build would have had to bundle into the Worker to find out. Each
 * runtime hands over the headers it already has: a Next.js page passes
 * `await headers()`, a TanStack Start server function passes
 * `getRequest().headers`, and a route handler passes `request.headers`.
 *
 * The `nextCookies()` plugin went with it. It exists to flush better-auth's
 * `Set-Cookie` through Next's cookie API for **server actions**, and this app
 * has none: every sign-in goes through `authClient` in the browser, so the
 * cookie arrives on the HTTP response like any other.
 */
export const getServerAuthSession = async (headers: Headers) =>
  auth.api.getSession({ headers });

export type ServerAuthSession = Awaited<
  ReturnType<typeof getServerAuthSession>
>;
