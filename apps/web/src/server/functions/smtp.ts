import { createServerFn } from "@tanstack/react-start";

import { env } from "~/env";
import { protectedMiddleware } from "~/server/functions/middleware";

/**
 * What to put in an SMTP client, from `app/(dashboard)/dev-settings/smtp` (#9).
 *
 * The Next.js page was a server component that read `env.SMTP_HOST` and
 * `env.SMTP_USER` inline. There is no such thing under Vite: `~/env` reads
 * `process.env` at module load and `process` does not exist in the client
 * bundle, so importing it from a component is a `ReferenceError` on first
 * paint — a blank page, not a build error. A server function is the seam that
 * replaces `export const dynamic = "force-dynamic"`.
 *
 * It returns the two strings and nothing else. The port and the password are
 * literals the page prints, not configuration: the password field says
 * `YOUR_API_KEY` because the SMTP server authenticates with an API key, and
 * the ports are the fixed set the SMTP proxy listens on.
 *
 * Behind `protectedMiddleware` because it is a signed-in page. The values are
 * not secret — they are printed for the user to copy — but "which host does
 * this installation send through" is not a question an anonymous caller needs
 * answered.
 */
export const getSmtpSettings = createServerFn({ method: "GET" })
  .middleware([protectedMiddleware])
  .handler(() => ({
    host: env.SMTP_HOST,
    user: env.SMTP_USER,
  }));
