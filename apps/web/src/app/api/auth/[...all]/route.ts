import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "~/server/auth";
import { env } from "~/env";
import {
  consumeRateLimitFailOpen,
  rateLimitBucket,
} from "~/server/rate-limit";
import { logger } from "~/server/logger/log";

/**
 * better-auth's endpoint that sends a sign-in code. This is the one that costs
 * an email, so it is the one worth rate limiting — the NextAuth equivalent was
 * `/signin/email`.
 */
const SEND_OTP_PATH = "/email-otp/send-verification-otp";

/** `AUTH_EMAIL_RATE_LIMIT` OTP sends per IP per minute. */
const AUTH_EMAIL_RATE_LIMIT_WINDOW_SECONDS = 60;

const handler = toNextJsHandler(auth);

export const { GET } = handler;

function getClientIp(req: Request): string | null {
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

export async function POST(req: Request) {
  if (env.AUTH_EMAIL_RATE_LIMIT > 0) {
    const url = new URL(req.url);
    if (url.pathname.endsWith(SEND_OTP_PATH)) {
      const ip = getClientIp(req);

      if (!ip) {
        logger.warn("Auth email rate limit skipped: missing client IP");
        return handler.POST(req);
      }

      // Fail open, as this has always done: an OTP that cannot be sent is a
      // user who cannot sign in, and the limiter is a cost control rather than
      // an authentication control. See `server/rate-limit/index.ts`.
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
        return Response.json(
          {
            error: {
              code: "RATE_LIMITED",
              message: "Too many requests",
            },
          },
          { status: 429 }
        );
      }
    }
  }
  return handler.POST(req);
}
