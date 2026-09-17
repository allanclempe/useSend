import { z } from "@hono/zod-openapi";
import {
  MAX_ATTACHMENTS_PER_EMAIL,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from "~/server/service/attachment-limits";

/**
 * Reusable Zod schema for a single email payload used in public API requests.
 */
export const emailSchema = z
  .object({
    to: z.string().or(z.array(z.string())),
    from: z.string(),
    subject: z.string().min(1).optional().openapi({
      description: "Optional when templateId is provided",
    }),
    templateId: z.string().optional().openapi({
      description: "ID of a template from the dashboard",
    }),
    variables: z.record(z.string()).optional(),
    replyTo: z.string().or(z.array(z.string())).optional(),
    cc: z.string().or(z.array(z.string())).optional(),
    bcc: z.string().or(z.array(z.string())).optional(),
    text: z.string().min(1).optional().nullable(),
    html: z.coerce.string().min(1).optional().nullable(),
    headers: z.record(z.string().min(1)).optional().openapi({
      description: "Custom headers to included with the emails",
    }),
    // The count and size limits are documented here but enforced in
    // `service/attachment-limits.ts`, which every send path goes through --
    // this schema only sees JSON arriving on the public API. See that module
    // for why the boundary sits there and where 25 MB comes from.
    attachments: z
      .array(
        z.object({
          filename: z.string().min(1),
          content: z.string().min(1).openapi({
            description: "File contents, base64-encoded",
          }),
        })
      )
      .optional()
      .openapi({
        maxItems: MAX_ATTACHMENTS_PER_EMAIL,
        description: `Up to ${MAX_ATTACHMENTS_PER_EMAIL} attachments totalling at most ${MAX_TOTAL_ATTACHMENT_BYTES / (1024 * 1024)} MB once decoded. The ceiling comes from SES, which rejects any message over 40 MB after base64 encoding.`,
      }),
    scheduledAt: z.string().datetime({ offset: true }).optional(), // Ensure ISO 8601 format with offset
    inReplyToId: z.string().optional().nullable(),
  })
  .refine(
    (data) => !!data.subject || !!data.templateId,
    "Either subject or templateId must be provided."
  )
  .refine(
    (data) => !!data.text || !!data.html,
    "Either text or html content must be provided."
  );
