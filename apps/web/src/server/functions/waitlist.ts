import { createServerFn } from "@tanstack/react-start";

import {
  waitlistSubmissionSchema,
  WAITLIST_EMAIL_TYPES,
} from "~/app/wait-list/schema";
import { env } from "~/env";
import { AppError } from "~/server/app-error";
import { authedMiddleware } from "~/server/functions/middleware";
import { logger } from "~/server/logger/log";
import { maskEmail } from "~/server/logger/redact";
import { sendMail } from "~/server/mailer";
import { consumeRateLimit, rateLimitBucket } from "~/server/rate-limit";
import { escapeHtml } from "~/server/utils/email-content";

/**
 * The waitlist request form, from `server/api/routers/waitlist.ts` (#9).
 *
 * `authedMiddleware` and not `protectedMiddleware`: the only people who can
 * submit this are the ones still on the waitlist, and `protectedMiddleware` is
 * precisely the rung that shuts them out.
 *
 * The submission schema is still imported from `src/app/wait-list`, which the
 * form shares. It is plain Zod with no React in it, so it is safe to reach for
 * from the server half; it moves out of `src/app` when that tree is deleted.
 */

const RATE_LIMIT_WINDOW_SECONDS = 60 * 60 * 6; // 6 hours
const RATE_LIMIT_MAX_ATTEMPTS = 3;

const EMAIL_TYPE_LABEL: Record<(typeof WAITLIST_EMAIL_TYPES)[number], string> =
  {
    transactional: "Transactional",
    marketing: "Marketing",
  };

export const submitRequest = createServerFn({ method: "POST" })
  .middleware([authedMiddleware])
  .validator(waitlistSubmissionSchema)
  .handler(async ({ data, context }) => {
    const { user } = context;

    const founderEmail = env.FOUNDER_EMAIL ?? env.ADMIN_EMAIL;

    if (!founderEmail) {
      logger.error(
        "FOUNDER_EMAIL/ADMIN_EMAIL is not configured; skipping waitlist notification",
      );
      throw new Error("Waitlist notifications are not configured");
    }

    // Fail *closed*, unlike the other two limiters: a throw here is an error
    // shown to one user submitting one form, and what it protects is the
    // founder's inbox. See `server/rate-limit/index.ts`.
    const rateLimit = await consumeRateLimit(
      rateLimitBucket.waitlist(user.id),
      {
        limit: RATE_LIMIT_MAX_ATTEMPTS,
        windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
      },
    );

    if (rateLimit.limited) {
      // tRPC had `TOO_MANY_REQUESTS`; `AppError` has no code for it and the
      // dashboard only ever renders the message. `FORBIDDEN` is the closest
      // honest one — the request is refused for who is asking, not for what
      // they sent.
      throw new AppError(
        "FORBIDDEN",
        "You have reached the waitlist request limit. Please try later.",
      );
    }

    const typesLabel = data.emailTypes
      .map((type) => EMAIL_TYPE_LABEL[type])
      .join(", ");

    const escapedDescription = escapeHtml(data.description);
    const escapedDomain = escapeHtml(data.domain);
    const escapedEmailVolume = escapeHtml(data.emailVolume);
    const subject = `Waitlist request from ${user.email ?? "unknown user"}`;

    const textBody = `A waitlisted user submitted a request:\n\nEmail: ${
      user.email ?? "Unknown"
    }\nDomain: ${data.domain}\nInterested emails: ${typesLabel}\nExpected sending volume: ${
      data.emailVolume
    }\n\nDescription:\n${data.description}`;

    const htmlBody = `
        <p>A waitlisted user submitted a request.</p>
        <ul>
          <li><strong>Email:</strong> ${escapeHtml(user.email ?? "Unknown")}</li>
          <li><strong>Domain:</strong> ${escapedDomain}</li>
          <li><strong>Interested emails:</strong> ${escapeHtml(typesLabel)}</li>
          <li><strong>Expected sending volume:</strong> ${escapedEmailVolume}</li>
        </ul>
        <p><strong>Description</strong></p>
        <p style="white-space: pre-wrap;">${escapedDescription}</p>
      `;

    await sendMail(
      founderEmail,
      subject,
      textBody,
      htmlBody,
      user.email ?? undefined,
    );

    logger.info(
      { userId: user.id, email: maskEmail(user.email) },
      "Waitlist request submitted",
    );

    return { ok: true };
  });
