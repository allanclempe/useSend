import { EmailStatus, type Email } from "~/types/db";
import {
  type EmailBasePayload,
  type EmailWebhookEventType,
} from "@usesend/lib/src/webhook/webhook-events";

/**
 * The parts of the outbound email webhook payload that carry no SES event data.
 *
 * Split out of `ses-hook-parser` so it is not the only place that can emit one.
 * `email.sent` is now raised by `email-queue-service` at the SES handoff rather
 * than by the SES `Send` notification, and it needs exactly this much: the
 * event name and the base payload. The SES-shaped extras (`bounce`, `open`,
 * `click`) stay in the parser, because only an inbound SES event has them.
 *
 * Pure — no database, no queue — so importing it cannot create a cycle.
 */
export function emailStatusToEvent(
  status: EmailStatus,
): EmailWebhookEventType {
  switch (status) {
    case EmailStatus.QUEUED:
      return "email.queued";
    case EmailStatus.SENT:
      return "email.sent";
    case EmailStatus.DELIVERY_DELAYED:
      return "email.delivery_delayed";
    case EmailStatus.DELIVERED:
      return "email.delivered";
    case EmailStatus.BOUNCED:
      return "email.bounced";
    case EmailStatus.REJECTED:
      return "email.rejected";
    case EmailStatus.RENDERING_FAILURE:
      return "email.rendering_failure";
    case EmailStatus.COMPLAINED:
      return "email.complained";
    case EmailStatus.FAILED:
      return "email.failed";
    case EmailStatus.CANCELLED:
      return "email.cancelled";
    case EmailStatus.SUPPRESSED:
      return "email.suppressed";
    case EmailStatus.OPENED:
      return "email.opened";
    case EmailStatus.CLICKED:
      return "email.clicked";
    default:
      return "email.queued";
  }
}

/** The status-independent half of every outbound email webhook payload. */
export function buildEmailBasePayload(params: {
  email: Email;
  status: EmailStatus;
  occurredAt: string;
  metadata?: Record<string, unknown>;
}): EmailBasePayload {
  const { email, status, occurredAt, metadata } = params;

  return {
    id: email.id,
    status,
    from: email.from,
    to: email.to,
    occurredAt,
    campaignId: email.campaignId ?? undefined,
    contactId: email.contactId ?? undefined,
    domainId: email.domainId ?? null,
    subject: email.subject,
    metadata,
  };
}
