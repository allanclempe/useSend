import { TRPCError } from "@trpc/server";

import { env } from "~/env";
import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";
import { logger } from "~/server/logger/log";
import { maskEmail } from "~/server/logger/redact";
import { sendMail } from "~/server/mailer";
import { consumeRateLimit, rateLimitBucket } from "~/server/rate-limit";
import {
  WAITLIST_EMAIL_TYPES,
  waitlistSubmissionSchema,
} from "~/lib/zod/waitlist-schema";
import { escapeHtml } from "~/server/utils/email-content";

const RATE_LIMIT_WINDOW_SECONDS = 60 * 60 * 6; // 6 hours
const RATE_LIMIT_MAX_ATTEMPTS = 3;

const EMAIL_TYPE_LABEL: Record<(typeof WAITLIST_EMAIL_TYPES)[number], string> = {
  transactional: "Transactional",
  marketing: "Marketing",
};

export const waitlistRouter = createTRPCRouter({
  submitRequest: authedProcedure
    .input(waitlistSubmissionSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.session || !ctx.session.user) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const { user } = ctx.session;

      const founderEmail = env.FOUNDER_EMAIL ?? env.ADMIN_EMAIL;

      if (!founderEmail) {
        logger.error("FOUNDER_EMAIL/ADMIN_EMAIL is not configured; skipping waitlist notification");
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Waitlist notifications are not configured",
        });
      }

      // Fail *closed*, unlike the other two limiters: a throw here is a tRPC
      // error shown to one user submitting one form, and what it protects is
      // the founder's inbox. See `server/rate-limit/index.ts`.
      const rateLimit = await consumeRateLimit(
        rateLimitBucket.waitlist(user.id),
        {
          limit: RATE_LIMIT_MAX_ATTEMPTS,
          windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
        },
      );

      if (rateLimit.limited) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "You have reached the waitlist request limit. Please try later.",
        });
      }

      const typesLabel = input.emailTypes
        .map((type) => EMAIL_TYPE_LABEL[type])
        .join(", ");

      const escapedDescription = escapeHtml(input.description);
      const escapedDomain = escapeHtml(input.domain);
      const escapedEmailVolume = escapeHtml(input.emailVolume);
      const subject = `Waitlist request from ${user.email ?? "unknown user"}`;

      const textBody = `A waitlisted user submitted a request:\n\nEmail: ${
        user.email ?? "Unknown"
      }\nDomain: ${input.domain}\nInterested emails: ${typesLabel}\nExpected sending volume: ${
        input.emailVolume
      }\n\nDescription:\n${input.description}`;

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

      await sendMail(founderEmail, subject, textBody, htmlBody, user.email ?? undefined);

      logger.info(
        {
          userId: user.id,
          email: maskEmail(user.email),
        },
        "Waitlist request submitted"
      );

      return { ok: true };
    }),
});
