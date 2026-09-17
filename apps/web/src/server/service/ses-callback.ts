import { eq } from "drizzle-orm";
import { env } from "~/env";
import { drizzleDb, schema } from "~/server/drizzle";
import { withUpdatedAt } from "~/server/drizzle/touch";
import { logger } from "~/server/logger/log";
import {
  startTrace,
  TRACEPARENT_HEADER,
  withTraceContext,
} from "~/server/logger/trace-context";
import { SesHookParser } from "~/server/service/ses-hook-parser";
import { SesSettingsService } from "~/server/service/ses-settings-service";
import { SnsNotificationMessage } from "~/types/aws-types";

/**
 * The SES event pipeline's front door: SNS POSTs here, and this enqueues.
 *
 * Runtime-agnostic on purpose. It is reached two ways today — the Next.js route
 * at `app/api/ses_callback/route.ts` under Node, and `src/worker/ses-callback-route.ts`
 * inside the Worker — and the two must not drift, because the URL SNS is
 * subscribed to (`ses-settings-service.ts:129`) is the same one either way.
 *
 * Keeping the HTTP hop is deliberate (§2): SNS already posts to
 * `setting.callbackUrl`, so the Worker's job is to validate the topic, hand the
 * event to a queue and return — the parsing and the database writes happen in
 * the consumer, off the request path.
 */

export const SES_CALLBACK_PATH = "/api/ses_callback";

export function isSesCallbackRequest(url: URL): boolean {
  return url.pathname === SES_CALLBACK_PATH;
}

/**
 * Handles one SNS delivery.
 *
 * The trace starts here: this is the beginning of the event pipeline, and the
 * queue seam carries the `traceparent` on to the consumer, so an SNS POST and
 * the `EmailEvent` row it produces share one `trace_id` (#18). SNS does not
 * send the header, but a replay or a test harness can.
 */
export async function handleSesCallbackRequest(
  request: Request,
): Promise<Response> {
  if (request.method === "GET") {
    return Response.json({ data: "Hello" });
  }

  return await withTraceContext(
    startTrace(request.headers.get(TRACEPARENT_HEADER)),
    () => handleSesCallback(request),
  );
}

async function handleSesCallback(req: Request) {
  const data = await req.json();

  // Only the identifiers. The SNS envelope carries the recipient address, the
  // subject and the full message headers — none of which belong in a log.
  logger.debug(
    { snsType: data.Type, snsMessageId: data.MessageId },
    "Received SES callback",
  );

  const isEventValid = await checkEventValidity(data);

  if (!isEventValid) {
    logger.warn(
      { snsMessageId: data.MessageId },
      "Rejected SES callback: unknown topic",
    );
    return Response.json({ data: "Event is not valid" });
  }

  if (data.Type === "SubscriptionConfirmation") {
    return handleSubscription(data);
  }

  let message = null;

  try {
    message = JSON.parse(data.Message || "{}");
    // Enqueue failures throw; the catch below turns them into an error response.
    await SesHookParser.queue({
      event: message,
      messageId: data.MessageId,
    });

    return Response.json({ data: "Success" });
  } catch (e) {
    logger.error(
      { err: e, snsMessageId: data.MessageId },
      "Failed to parse or enqueue SES callback",
    );
    return Response.json({ data: "Error is parsing hook" });
  }
}

/**
 * Handles the subscription confirmation event. called only once for a webhook
 */
async function handleSubscription(message: any) {
  await fetch(message.SubscribeURL, {
    method: "GET",
  });

  const topicArn = message.TopicArn as string;
  const [setting] = await drizzleDb
    .select()
    .from(schema.sesSetting)
    .where(eq(schema.sesSetting.topicArn, topicArn))
    .limit(1);

  if (!setting) {
    return Response.json({ data: "Setting not found" });
  }

  await drizzleDb
    .update(schema.sesSetting)
    .set(withUpdatedAt({ callbackSuccess: true }))
    .where(eq(schema.sesSetting.id, setting.id));

  SesSettingsService.invalidateCache();

  return Response.json({ data: "Success" });
}

/**
 * A simple check to ensure that the event is from the correct topic
 */
async function checkEventValidity(message: SnsNotificationMessage) {
  if (env.NODE_ENV === "development") {
    return true;
  }

  const { TopicArn } = message;
  const configuredTopicArn = await SesSettingsService.getTopicArns();

  if (!configuredTopicArn.includes(TopicArn)) {
    return false;
  }

  return true;
}
