import { env } from "~/env";
import { eq } from "drizzle-orm";
import { drizzleDb, schema } from "~/server/drizzle";
import { withUpdatedAt } from "~/server/drizzle/touch";
import { logger } from "~/server/logger/log";
import { parseSesHook, SesHookParser } from "~/server/service/ses-hook-parser";
import { SesSettingsService } from "~/server/service/ses-settings-service";
import { SnsNotificationMessage } from "~/types/aws-types";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ data: "Hello" });
}

export async function POST(req: Request) {
  const data = await req.json();

  console.log(data, data.Message);

  const isEventValid = await checkEventValidity(data);

  console.log("Is event valid: ", isEventValid);

  if (!isEventValid) {
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
    console.error(e);
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
