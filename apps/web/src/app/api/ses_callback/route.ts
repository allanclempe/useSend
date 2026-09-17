import {
  handleSesCallbackRequest,
} from "~/server/service/ses-callback";

/**
 * The Next.js half of the SES callback.
 *
 * Everything it does lives in `server/service/ses-callback.ts`, because the
 * Worker serves the same path (`src/worker/ses-callback-route.ts`) and SNS is
 * subscribed to one URL. Two copies of the topic check would be one copy too
 * many.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ data: "Hello" });
}

export async function POST(req: Request) {
  return handleSesCallbackRequest(req);
}
