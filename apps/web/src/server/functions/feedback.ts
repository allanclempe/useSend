import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { env } from "~/env";
import { forbidden } from "~/server/app-error";
import { teamMiddleware } from "~/server/functions/middleware";
import { sendMail } from "~/server/mailer";
import { toPlainHtml } from "~/server/utils/email-content";
import { isCloud } from "~/utils/common";

/**
 * The "send feedback" box, from `server/api/routers/feedback.ts` (#9).
 *
 * Cloud only, and the self-host check is the first thing it does: a
 * self-hosted install has no founder to mail, and `FOUNDER_EMAIL` unset there
 * is the normal state rather than a misconfiguration.
 *
 * There is no rate limit on this one and there was not one before. It is
 * `teamMiddleware`, so the caller is a signed-in member of a real team, and
 * the message caps at 2000 characters.
 */

export const send = createServerFn({ method: "POST" })
  .middleware([teamMiddleware])
  .validator(
    z.object({
      message: z.string().trim().min(1, "Feedback cannot be empty").max(2000),
    }),
  )
  .handler(async ({ data, context }) => {
    if (!isCloud()) {
      throw forbidden("Feedback is only available on the cloud version.");
    }

    if (!env.FOUNDER_EMAIL) {
      // `AppError` has no code for this: it is our mistake, not the caller's,
      // and there is nothing they can do differently. A plain Error carries
      // the same message to the toast that `INTERNAL_SERVER_ERROR` did.
      throw new Error("Feedback email is not configured.");
    }

    const { user, team } = context;
    const senderEmail = user.email ?? "Unknown";
    const senderName = user.name ?? "Unknown";

    const text = `New feedback received\n\nFrom: ${senderName} (${senderEmail})\nUser ID: ${user.id}\nTeam: ${team.name} (ID: ${team.id})\n\nMessage:\n${
      data.message
    }`;

    await sendMail(
      env.FOUNDER_EMAIL,
      `Product feedback from ${team.name}`,
      text,
      toPlainHtml(text),
      user.email ?? undefined,
    );

    return { success: true };
  });
