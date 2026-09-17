import { env } from "~/env";
import { eq } from "drizzle-orm";
import { drizzleDb, schema } from "~/server/drizzle";
import { withUpdatedAt } from "~/server/drizzle/touch";
import { logger } from "~/server/logger/log";
import {
  startTrace,
  TRACEPARENT_HEADER,
  withTraceContext,
} from "~/server/logger/trace-context";
import { parseSesHook, SesHookParser } from "~/server/service/ses-hook-parser";
import { SesSettingsService } from "~/server/service/ses-settings-service";
import { SnsNotificationMessage } from "~/types/aws-types";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ data: "Hello" });
}

export async function POST(req: Request) {
  // The SNS notification is the start of the event pipeline, so the trace
  // starts here and is carried onto the queue for the consumer (#18). SNS does
  // not send `traceparent`, but a replay or a test harness can.
  return withTraceContext(
    startTrace(req.headers.get(TRACEPARENT_HEADER)),
    () => handleSesCallback(req),
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
