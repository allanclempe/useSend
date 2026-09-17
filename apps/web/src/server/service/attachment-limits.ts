import { UnsendApiError } from "~/server/public-api/api-error";
import type { EmailAttachment } from "~/types";

/**
 * How large an email's attachments are allowed to be, and where that number
 * comes from.
 *
 * ## Where the limit is enforced
 *
 * In `email-service.ts`, at `sendEmail` and `sendBulkEmails` — deliberately not
 * in the public API's Zod schema. The schema only sees requests that arrive as
 * JSON on `/v1/emails`; the service sees every path that can produce an email:
 * the public API, the batch endpoint, the SMTP server (which posts to the
 * public API, but has its own `size` limit that could be raised), the
 * dashboard's domain test-send and double-opt-in confirmations. A cap that can
 * be bypassed by a second entry point is not a cap, and a cap repeated in each
 * schema is a cap that drifts.
 *
 * ## Where the number comes from
 *
 * Work backwards from SES, not from a round number. SES v2 rejects a message
 * over **40 MB measured after base64 encoding**, and that ceiling is not
 * adjustable — no quota request raises it. So:
 *
 * 1. Ceiling: 40,000,000 bytes post-encoding. Decimal MB rather than MiB
 *    because AWS does not say which it means and the smaller reading is the
 *    safe one.
 * 2. Reserve 10% (4,000,000 bytes) for everything in the message that is not
 *    attachment payload: MIME headers and boundaries, the recipient lists, and
 *    the HTML and text bodies — which are themselves encoded and can be large
 *    on a templated send. Leaves 36,000,000 bytes of encoded attachment.
 * 3. Base64 inflates by 4/3, and nodemailer wraps the output at 76 characters
 *    with a CRLF, so the real factor is (4/3) x (78/76) = 1.3684.
 * 4. 36,000,000 / 1.3684 = 26,307,000 raw bytes, or 25.09 MiB.
 * 5. Round down to a flat **25 MiB**, which is both under that and the number
 *    people already expect from Gmail.
 *
 * If SES's limit ever moves, change `SES_MAX_MESSAGE_BYTES` and re-derive —
 * do not nudge the raw number.
 */
const SES_MAX_MESSAGE_BYTES = 40_000_000;
const NON_ATTACHMENT_RESERVE = 0.1;
const BASE64_INFLATION = (4 / 3) * (78 / 76);

/** 25 MiB. See the derivation above. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * The count cap that predates the size cap. Kept, because the two bound
 * different things: 25 MiB in one file and 25 MiB spread over 500 files cost
 * the same bandwidth but not the same MIME-assembly work, and each part carries
 * headers that come out of the same 40 MB budget. Size is the binding
 * constraint; this is a guard on shape.
 */
export const MAX_ATTACHMENTS_PER_EMAIL = 10;

/**
 * Size of the payload a base64 string decodes to, without decoding it.
 *
 * Decoding a 25 MiB attachment only to measure it would cost real CPU on a
 * metered platform, and measuring is all we want. Length arithmetic is O(1).
 *
 * Over-counts slightly if the caller sends base64 with embedded line breaks,
 * which errs towards rejecting — the conservative direction against a hard
 * provider limit.
 */
export function base64DecodedBytes(content: string): number {
  const { length } = content;
  if (length === 0) return 0;

  let padding = 0;
  if (content.charCodeAt(length - 1) === 0x3d) padding += 1;
  if (length > 1 && content.charCodeAt(length - 2) === 0x3d) padding += 1;

  return Math.max(0, Math.floor((length * 3) / 4) - padding);
}

/** Aggregate decoded size of an email's attachments. */
export function totalAttachmentBytes(
  attachments: Array<EmailAttachment> | undefined,
): number {
  if (!attachments?.length) return 0;

  let total = 0;
  for (const attachment of attachments) {
    total += base64DecodedBytes(attachment.content);
  }
  return total;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Rejects an oversized or over-long attachment set before any work is done on
 * it.
 *
 * Without this the message is accepted, rendered, serialised into MIME,
 * persisted and enqueued, and only fails at the SES call — on a path that
 * retries, so the same doomed work runs again. The caller gets a late and
 * unspecific failure instead of an immediate one that names the limit.
 */
export function assertAttachmentsWithinLimit(
  attachments: Array<EmailAttachment> | undefined,
): void {
  if (!attachments?.length) return;

  if (attachments.length > MAX_ATTACHMENTS_PER_EMAIL) {
    throw new UnsendApiError({
      code: "BAD_REQUEST",
      message: `Too many attachments: ${attachments.length}. An email can carry at most ${MAX_ATTACHMENTS_PER_EMAIL}.`,
    });
  }

  const total = totalAttachmentBytes(attachments);
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new UnsendApiError({
      code: "BAD_REQUEST",
      message:
        `Attachments total ${formatMegabytes(total)}, which is over the ` +
        `${formatMegabytes(MAX_TOTAL_ATTACHMENT_BYTES)} limit for a single email. ` +
        `SES rejects a message larger than 40 MB once base64-encoded, and that ceiling cannot be raised.`,
    });
  }
}

/**
 * Not used at runtime — it exists so the derivation above is checked rather
 * than asserted, and so a future edit to the reserve or the ceiling shows up as
 * a failing test instead of a comment nobody re-ran.
 */
export function derivedMaxAttachmentBytes(): number {
  return Math.floor(
    (SES_MAX_MESSAGE_BYTES * (1 - NON_ATTACHMENT_RESERVE)) / BASE64_INFLATION,
  );
}
