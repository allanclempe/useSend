import { env } from "~/env";
import { logger } from "~/server/logger/log";
import {
  renderOtpEmail,
  renderTeamInviteEmail,
  renderUsageLimitReachedEmail,
  renderUsageWarningEmail,
} from "~/server/email-templates";

/**
 * `GET /api/dev/email-preview?type=…` — renders a transactional template with
 * made-up data so a human can look at it.
 *
 * Development only, and the check is the first thing it does: the templates
 * are jsx-email, which pulls a renderer, a minifier and a CSS inliner into the
 * request path, and none of that should be reachable on a deployed Worker for
 * a page nobody is meant to visit.
 *
 * It is also the only thing that exercises **jsx-email server-side rendering
 * inside a Worker**, which is an acceptance criterion of #9 and was not
 * previously proven anywhere. Everything else that renders a template does so
 * from a queue consumer, where a failure surfaces as a retry rather than a
 * response.
 */
const TYPES = [
  "otp",
  "invite",
  "usage-warning",
  "usage-limit",
] as const;

type PreviewType = (typeof TYPES)[number];

function isPreviewType(value: string): value is PreviewType {
  return (TYPES as readonly string[]).includes(value);
}

export async function handleEmailPreviewRequest(
  request: Request,
): Promise<Response> {
  if (env.NODE_ENV !== "development") {
    return Response.json({ error: "Not Found" }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type") ?? "otp";
  const isPaidPlan = searchParams.get("isPaidPlan") === "true";
  const period = searchParams.get("period") === "monthly" ? "monthly" : "daily";

  if (!isPreviewType(type)) {
    return Response.json({ error: "Invalid type" }, { status: 400 });
  }

  try {
    const html = await renderPreview(type, { isPaidPlan, period });

    return new Response(html, {
      headers: { "Content-Type": "text/html" },
    });
  } catch (err) {
    logger.error({ err, type }, "Failed to render an email template preview");
    return Response.json(
      { error: "Failed to render email template" },
      { status: 500 },
    );
  }
}

function renderPreview(
  type: PreviewType,
  options: { isPaidPlan: boolean; period: "daily" | "monthly" },
): Promise<string> {
  switch (type) {
    case "otp":
      return renderOtpEmail({
        otpCode: "ABC123",
        loginUrl: "https://app.usesend.com/login?token=abc123",
        hostName: "useSend",
      });
    case "invite":
      return renderTeamInviteEmail({
        teamName: "My Awesome Team",
        inviteUrl: "https://app.usesend.com/join-team?inviteId=123",
        inviterName: "John Doe",
        role: "admin",
      });
    case "usage-warning":
      return renderUsageWarningEmail({
        teamName: "Acme Inc",
        used: 8000,
        limit: 10000,
        period: options.period,
        manageUrl: "https://app.usesend.com/settings/billing",
        isPaidPlan: options.isPaidPlan,
      });
    case "usage-limit":
      return renderUsageLimitReachedEmail({
        teamName: "Acme Inc",
        limit: 10000,
        period: options.period,
        manageUrl: "https://app.usesend.com/settings/billing",
        isPaidPlan: options.isPaidPlan,
      });
  }
}
