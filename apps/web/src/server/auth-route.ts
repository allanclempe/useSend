import { auth } from "~/server/auth";
import { env } from "~/env";
import { logger } from "~/server/logger/log";
import { consumeRateLimitFailOpen, rateLimitBucket } from "~/server/rate-limit";

/**
 * `/api/auth/*` — better-auth's own endpoints, plus the one rate limit that
 * costs money.
 *
 * Framework-free on purpose, and for the same reason `service/ses-callback.ts`
 * is: two entry points serve this path while both frameworks are in the tree
 * (#9), and a rate limit that is enforced on one of them and not the other is
 * worse than no rate limit, because it looks like one. `toNextJsHandler(auth)`
 * was only ever `auth.handler`.
 */

/**
 * better-auth's endpoint that sends a sign-in code. This is the one that costs
 * an email, so it is the one worth rate limiting — the NextAuth equivalent was
 * `/signin/email`.
 */
const SEND_OTP_PATH = "/email-otp/send-verification-otp";

/** `AUTH_EMAIL_RATE_LIMIT` OTP sends per IP per minute. */
const AUTH_EMAIL_RATE_LIMIT_WINDOW_SECONDS = 60;

export function getClientIp(req: Request): string | null {
  const h = req.headers;
  const direct =
    h.get("x-forwarded-for") ??
    h.get("x-real-ip") ??
    h.get("cf-connecting-ip") ??
    h.get("x-client-ip") ??
    h.get("true-client-ip") ??
    h.get("fastly-client-ip") ??
    h.get("x-cluster-client-ip") ??
    null;

  let ip = direct?.split(",")[0]?.trim() ?? "";

  if (!ip) {
    const fwd = h.get("forwarded");
    if (fwd) {
      const first = fwd.split(",")[0];
      const match = first?.match(/for=([^;]+)/i);
      if (match && match[1]) {
        const raw = match[1].trim().replace(/^"|"$/g, "");
        if (raw.startsWith("[")) {
          const end = raw.indexOf("]");
          ip = end !== -1 ? raw.slice(1, end) : raw;
        } else {
          const parts = raw.split(":");
          if (parts.length > 0 && parts[0]) {
            ip =
              parts.length === 2 && /^\d+(?:\.\d+){3}$/.test(parts[0])
                ? parts[0]
                : raw;
          }
        }
      }
    }
  }

  return ip || null;
}

/**
 * Whether this request should be refused before it reaches better-auth.
 *
 * Fails open, as it always has: an OTP that cannot be sent is a user who
 * cannot sign in, and the limiter is a cost control rather than an
 * authentication control. See `server/rate-limit/index.ts`.
 */
async function isAuthEmailRateLimited(request: Request): Promise<boolean> {
  if (env.AUTH_EMAIL_RATE_LIMIT <= 0) {
    return false;
  }

  if (!new URL(request.url).pathname.endsWith(SEND_OTP_PATH)) {
    return false;
  }

  const ip = getClientIp(request);

  if (!ip) {
    logger.warn("Auth email rate limit skipped: missing client IP");
    return false;
  }

  const result = await consumeRateLimitFailOpen(
    rateLimitBucket.authEmail(ip),
    {
      limit: env.AUTH_EMAIL_RATE_LIMIT,
      windowSeconds: AUTH_EMAIL_RATE_LIMIT_WINDOW_SECONDS,
    },
    (error) => logger.error({ err: error }, "Auth email rate limit failed"),
  );

  if (result?.limited) {
    logger.warn({ ip }, "Auth email rate limit exceeded");
    return true;
  }

  return false;
}

export function isAuthRequest(url: URL): boolean {
  return url.pathname.startsWith("/api/auth/");
}

export async function handleAuthRequest(request: Request): Promise<Response> {
  if (request.method === "POST" && (await isAuthEmailRateLimited(request))) {
    return Response.json(
      { error: { code: "RATE_LIMITED", message: "Too many requests" } },
      { status: 429 },
    );
  }

  return auth.handler(request);
}
