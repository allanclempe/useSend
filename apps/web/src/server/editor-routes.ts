import { EmailRenderer } from "@usesend/email-editor/src/renderer";

import { logger } from "~/server/logger/log";
import { unsubscribeContactFromLink } from "~/server/service/campaign-service";

/**
 * Two small public endpoints, framework-free so both entry points serve the
 * same code while `src/app` is still in the tree (#9).
 *
 * `POST /api/to-html` renders editor JSON to HTML. It is CORS-open because the
 * editor package calls it from wherever it is embedded, and it takes only what
 * the caller already has — there is nothing here to authorise.
 *
 * `POST /api/unsubscribe-oneclick` is the RFC 8058 endpoint named in the
 * `List-Unsubscribe-Post` header of every campaign we have ever sent. The URL
 * cannot move and the hash cannot be recomputed (`AGENTS.md`: `APP_SECRET`
 * cannot be rotated), so this is a port, not a rewrite.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
} as const;

export async function handleToHtmlRequest(request: Request): Promise<Response> {
  try {
    const renderer = new EmailRenderer(await request.json());
    const html = await renderer.render({
      shouldReplaceVariableValues: true,
      linkValues: {
        "{{usesend_unsubscribe_url}}": "https://usesend.com/unsubscribe",
        "{{unsend_unsubscribe_url}}": "https://usesend.com/unsubscribe",
      },
    });

    return Response.json({ data: html }, { headers: CORS_HEADERS });
  } catch (err) {
    // 200 with an error string in `data`, as before: the editor renders
    // whatever comes back into its preview pane and has no error path.
    logger.error({ err }, "Failed to render editor content to HTML");
    return Response.json(
      { data: "Error in converting to html" },
      { headers: CORS_HEADERS },
    );
  }
}

export function handleToHtmlPreflight(): Response {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function handleOneClickUnsubscribe(
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const hash = url.searchParams.get("hash");

  if (!id || !hash) {
    logger.warn(
      { hasId: Boolean(id), hasHash: Boolean(hash) },
      "One-click unsubscribe: missing id or hash",
    );
    return Response.json({ error: "Invalid unsubscribe link" }, { status: 400 });
  }

  try {
    const contact = await unsubscribeContactFromLink(id, hash);

    logger.info(
      { contactId: contact.id, campaignId: id.split("-")[1] },
      "One-click unsubscribe successful",
    );

    return Response.json({ success: true, message: "Successfully unsubscribed" });
  } catch (err) {
    logger.error({ err }, "One-click unsubscribe failed");
    return Response.json(
      { error: "Failed to process unsubscribe request" },
      { status: 500 },
    );
  }
}
