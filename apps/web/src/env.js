import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  /**
   * Specify your server-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars.
   */
  server: {
    DATABASE_URL: z
      .string()
      .url()
      .refine(
        (str) => !str.includes("YOUR_MYSQL_URL_HERE"),
        "You forgot to change the default URL",
      ),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    // Keys the hashes in the links we put in emails: campaign unsubscribe and
    // one-click-unsubscribe (`service/campaign-service.ts`), double-opt-in
    // confirmation tokens (`service/double-opt-in-service.ts`) and signed
    // upload URLs (`service/storage-service.ts`).
    //
    // **Rotating it breaks every unsubscribe link in every email already
    // delivered**, which is an RFC 8058 / bulk-sender compliance problem and
    // not merely a dead link. This is why it was renamed from `NEXTAUTH_SECRET`
    // (issue #59) without regenerating the value: carry the old value over.
    APP_SECRET:
      process.env.NODE_ENV === "production"
        ? z.string()
        : z.string().optional(),
    // The application's public base URL — every absolute link we generate hangs
    // off it: billing redirects, team invites, domain links, unsubscribe URLs,
    // the OpenAPI `servers` entry, and better-auth's `baseURL`.
    //
    // This is the single name for that concept. `NEXTAUTH_URL` (named after a
    // library that is gone) and `BETTER_AUTH_URL` (a same-valued override for
    // one consumer of it) both collapsed into it in issue #59.
    APP_URL: z.preprocess(
      // Vercel deployments get the URL for free rather than having to set it.
      (str) => process.env.VERCEL_URL ?? str,
      // VERCEL_URL doesn't include `https` so it cant be validated as a URL
      process.env.VERCEL ? z.string() : z.string().url(),
    ),
    // Signs the better-auth session cookie. Deliberately NOT shared with
    // APP_SECRET: the two never read each other's tokens, so there is
    // nothing to gain from one value and a blast radius to lose. Generate with
    // `openssl rand -base64 32`.
    BETTER_AUTH_SECRET:
      process.env.NODE_ENV === "production"
        ? z.string()
        : z.string().optional(),
    // Keys the HMAC that hashes API keys (`server/crypto.ts`, issue #48).
    // Generate with `openssl rand -hex 32`.
    //
    // Required in every environment, not just production, and deliberately
    // unlike `APP_SECRET`/`BETTER_AUTH_SECRET` above: those have library
    // fallbacks, this has none, and a default would be a hardcoded key that
    // verifies every API key in every install that forgot to set it. Failing to
    // boot is the better failure. Test runs get theirs from
    // `src/test/setup/setup-env.ts`.
    //
    // Rotating it invalidates every existing API key.
    API_KEY_HMAC_SECRET: z
      .string()
      .min(32, "API_KEY_HMAC_SECRET must be at least 32 characters"),
    GITHUB_ID: z.string().optional(),
    GITHUB_SECRET: z.string().optional(),
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),
    USESEND_API_KEY: z.string().optional(),
    UNSEND_API_KEY: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    AWS_SES_ENDPOINT: z.string().optional(),
    AWS_SNS_ENDPOINT: z.string().optional(),
    AWS_DEFAULT_REGION: z
      .string()
      .trim()
      .min(1, "Region is required")
      .default("us-east-1"),
    API_RATE_LIMIT: z
      .string()
      .default("1")
      .transform((str) => parseInt(str, 10)),
    AUTH_EMAIL_RATE_LIMIT: z
      .string()
      .default("0")
      .transform((str) => parseInt(str, 10)),
    FROM_EMAIL: z.string().optional(),
    ADMIN_EMAIL: z.string().optional(),
    FOUNDER_EMAIL: z.string().optional(),
    DISCORD_WEBHOOK_URL: z.string().optional(),
    REDIS_URL: z.string(),
    REDIS_KEY_PREFIX: z.string().default(""),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_BASIC_PRICE_ID: z.string().optional(),
    STRIPE_BASIC_USAGE_PRICE_ID: z.string().optional(),
    STRIPE_LEGACY_BASIC_PRICE_ID: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
    SMTP_HOST: z.string().default("smtp.usesend.com"),
    SMTP_USER: z.string().default("usesend"),
    CONTACT_BOOK_ID: z.string().optional(),
    EMAIL_CLEANUP_DAYS: z
        .string()
        .optional()
        .transform((str) => (str ? parseInt(str, 10) : undefined)),
    EMAIL_EVENT_RETENTION_DAYS: z
        .string()
        .optional()
        .transform((str) => (str ? parseInt(str, 10) : undefined)),
    // Defaults to 30 days rather than being opt-in. It was opt-in so that wiring
    // up a job that deletes rows would not quietly start deleting them at an
    // existing install on upgrade; the log is a debugging aid nobody reads at 31
    // days, and leaving it unbounded by default is the worse failure. Set to 0
    // to keep it indefinitely.
    WEBHOOK_CALL_RETENTION_DAYS: z
        .string()
        .default("30")
        .transform((str) => parseInt(str, 10)),
    /**
     * OpenTelemetry resource attributes stamped on every log record. Declared
     * here so they are validated and documented; `server/logger/log.ts` reads
     * them from `process.env` directly, because the logger has to be importable
     * from modules that run before env validation.
     */
    OTEL_SERVICE_NAME: z.string().optional(),
    OTEL_SERVICE_VERSION: z.string().optional(),
  },

  /**
   * Specify your client-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars. To expose them to the client, prefix them with
   * `NEXT_PUBLIC_`.
   */
  client: {
    // NEXT_PUBLIC_CLIENTVAR: z.string(),
    NEXT_PUBLIC_IS_CLOUD: z
      .string()
      .default("false")
      .transform((str) => str === "true"),
    NEXT_PUBLIC_APP_VERSION: z.string().optional(),
    NEXT_PUBLIC_GIT_SHA: z.string().optional(),
  },

  /**
   * You can't destruct `process.env` as a regular object in the Next.js edge runtimes (e.g.
   * middlewares) or client-side so we need to destruct manually.
   */
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: process.env.NODE_ENV,
    APP_SECRET: process.env.APP_SECRET,
    APP_URL: process.env.APP_URL,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    API_KEY_HMAC_SECRET: process.env.API_KEY_HMAC_SECRET,
    GITHUB_ID: process.env.GITHUB_ID,
    GITHUB_SECRET: process.env.GITHUB_SECRET,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_KEY,
    USESEND_API_KEY: process.env.USESEND_API_KEY,
    UNSEND_API_KEY: process.env.UNSEND_API_KEY,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
    AWS_SES_ENDPOINT: process.env.AWS_SES_ENDPOINT,
    AWS_SNS_ENDPOINT: process.env.AWS_SNS_ENDPOINT,
    API_RATE_LIMIT: process.env.API_RATE_LIMIT,
    AUTH_EMAIL_RATE_LIMIT: process.env.AUTH_EMAIL_RATE_LIMIT,
    NEXT_PUBLIC_IS_CLOUD: process.env.NEXT_PUBLIC_IS_CLOUD,
    NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION,
    NEXT_PUBLIC_GIT_SHA: process.env.NEXT_PUBLIC_GIT_SHA,
    ADMIN_EMAIL: process.env.ADMIN_EMAIL,
    FOUNDER_EMAIL: process.env.FOUNDER_EMAIL,
    DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
    REDIS_URL: process.env.REDIS_URL,
    REDIS_KEY_PREFIX: process.env.REDIS_KEY_PREFIX,
    FROM_EMAIL: process.env.FROM_EMAIL,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_BASIC_PRICE_ID: process.env.STRIPE_BASIC_PRICE_ID,
    STRIPE_BASIC_USAGE_PRICE_ID: process.env.STRIPE_BASIC_USAGE_PRICE_ID,
    STRIPE_LEGACY_BASIC_PRICE_ID: process.env.STRIPE_LEGACY_BASIC_PRICE_ID,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_USER: process.env.SMTP_USER,
    CONTACT_BOOK_ID: process.env.CONTACT_BOOK_ID,
    EMAIL_CLEANUP_DAYS: process.env.EMAIL_CLEANUP_DAYS,
    EMAIL_EVENT_RETENTION_DAYS: process.env.EMAIL_EVENT_RETENTION_DAYS,
    WEBHOOK_CALL_RETENTION_DAYS: process.env.WEBHOOK_CALL_RETENTION_DAYS,
    OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME,
    OTEL_SERVICE_VERSION: process.env.OTEL_SERVICE_VERSION,
  },
  /**
   * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially
   * useful for Docker builds.
   */
  skipValidation: process.env.SKIP_ENV_VALIDATION === "true",
  /**
   * Makes it so that empty strings are treated as undefined. `SOME_VAR: z.string()` and
   * `SOME_VAR=''` will throw an error.
   */
  emptyStringAsUndefined: true,
});
