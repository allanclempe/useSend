import { SesSetting } from "@prisma/client";
import { eq } from "drizzle-orm";
import { drizzleDb, schema } from "../drizzle";
import { createId } from "../drizzle/id";
import { withUpdatedAt } from "../drizzle/touch";
import { env } from "~/env";
import * as sns from "~/server/aws/sns";
import * as ses from "~/server/aws/ses";
import { EventType } from "@aws-sdk/client-sesv2";
import { EmailQueueService } from "./email-queue-service";
import { smallNanoid } from "../nanoid";
import { logger } from "../logger/log";
import { sesRegionSchema } from "~/lib/zod/ses-setting-schema";

/**
 * Deliberately excludes SUBSCRIPTION. SES fires it when a recipient uses its
 * subscription-management page, but `SesEventType` has no such member and
 * `getEmailStatus` has no branch for it, so the event walked the whole pipeline
 * and then failed on the NOT NULL `EmailEvent.status` insert -- which sent the
 * job back through its full retry schedule, repeating the work each time.
 *
 * Subscribing to an event we cannot handle costs requests, queue operations and
 * retries for nothing. Add it back only alongside a handler.
 */
const GENERAL_EVENTS: EventType[] = [
  "BOUNCE",
  "COMPLAINT",
  "DELIVERY",
  "DELIVERY_DELAY",
  "REJECT",
  "RENDERING_FAILURE",
  "SEND",
];

export class SesSettingsService {
  private static cache: Record<string, SesSetting> = {};
  private static topicArns: Array<string> = [];
  private static initialized = false;

  public static async getSetting(
    region = env.AWS_DEFAULT_REGION
  ): Promise<SesSetting | null> {
    const normalizedRegion = sesRegionSchema.parse(region);

    await this.checkInitialized();

    if (this.cache[normalizedRegion]) {
      return this.cache[normalizedRegion] as SesSetting;
    }
    return null;
  }

  public static async getTopicArns() {
    await this.checkInitialized();
    return this.topicArns;
  }

  public static async getAllSettings() {
    await this.checkInitialized();
    return Object.values(this.cache);
  }

  /**
   * Creates a new setting in AWS for the given region and usesendUrl
   *
   * @param region
   * @param usesendUrl
   */
  public static async createSesSetting({
    region,
    usesendUrl,
    sendingRateLimit,
    transactionalQuota,
  }: {
    region: string;
    usesendUrl: string;
    sendingRateLimit: number;
    transactionalQuota: number;
  }) {
    region = sesRegionSchema.parse(region);

    await this.checkInitialized();
    if (this.cache[region]) {
      throw new Error(`SesSetting for region ${region} already exists`);
    }

    const parsedUrl = usesendUrl.endsWith("/")
      ? usesendUrl.substring(0, usesendUrl.length - 1)
      : usesendUrl;

    const usesendUrlValidation = await isValidUsesendUrl(parsedUrl);

    if (!usesendUrlValidation.isValid) {
      throw new Error(
        `Callback URL: ${usesendUrl} is not valid, status: ${usesendUrlValidation.code} message:${usesendUrlValidation.error}`
      );
    }

    const idPrefix = smallNanoid(10);
    let topicArn: string | undefined;

    let settingId: string | undefined;

    try {
      const topicName = `${idPrefix}-${region}-unsend`;
      topicArn = await sns.createTopic(topicName, region);
      if (!topicArn) {
        throw new Error("Failed to create SNS topic");
      }

      const [setting] = await drizzleDb
        .insert(schema.sesSetting)
        .values(
          withUpdatedAt({
            id: createId(),
            region,
            callbackUrl: `${parsedUrl}/api/ses_callback`,
            topic: topicName,
            topicArn,
            sesEmailRateLimit: sendingRateLimit,
            transactionalQuota,
            idPrefix,
          }),
        )
        .returning();

      if (!setting) {
        throw new Error("Failed to create setting");
      }

      settingId = setting.id;

      await this.invalidateCache();

      await sns.subscribeEndpoint(
        topicArn!,
        `${setting.callbackUrl}`,
        setting.region
      );

      if (!setting) {
        throw new Error("Failed to create setting");
      }

      await registerConfigurationSet(setting);

      EmailQueueService.initializeQueue(
        region,
        setting.sesEmailRateLimit,
        setting.transactionalQuota
      );
      logger.info(
        {
          transactionalQueue: EmailQueueService.transactionalQueue,
          marketingQueue: EmailQueueService.marketingQueue,
        },
        "Email queues initialized"
      );

      await this.invalidateCache();
    } catch (error) {
      if (topicArn) {
        try {
          await sns.deleteTopic(topicArn, region);
        } catch (deleteError) {
          logger.error(
            { err: deleteError },
            "Failed to delete SNS topic after error"
          );
        }
      }
      if (settingId) {
        await drizzleDb
          .delete(schema.sesSetting)
          .where(eq(schema.sesSetting.id, settingId));
      }
      await this.invalidateCache();
      logger.error({ err: error }, "Failed to create SES setting");
      throw error;
    }
  }

  public static async updateSesSetting({
    id,
    sendingRateLimit,
    transactionalQuota,
  }: {
    id: string;
    sendingRateLimit: number;
    transactionalQuota: number;
  }) {
    await this.checkInitialized();

    const [setting] = await drizzleDb
      .update(schema.sesSetting)
      .set(
        withUpdatedAt({
          transactionalQuota,
          sesEmailRateLimit: sendingRateLimit,
        }),
      )
      .where(eq(schema.sesSetting.id, id))
      .returning();

    if (!setting) {
      throw new Error("SES setting not found");
    }
    logger.info(
      {
        transactionalQueue: EmailQueueService.transactionalQueue,
        marketingQueue: EmailQueueService.marketingQueue,
      },
      "Email queues before update"
    );

    EmailQueueService.initializeQueue(
      setting.region,
      setting.sesEmailRateLimit,
      setting.transactionalQuota
    );

    logger.info(
      {
        transactionalQueue: EmailQueueService.transactionalQueue,
        marketingQueue: EmailQueueService.marketingQueue,
      },
      "Email queues after update"
    );

    await this.invalidateCache();
  }

  public static async checkInitialized() {
    if (!this.initialized) {
      await this.invalidateCache();
      this.initialized = true;
    }
  }

  static async invalidateCache() {
    const settings = await drizzleDb.select().from(schema.sesSetting);
    this.cache = {};
    this.topicArns = [];
    settings.forEach((setting) => {
      this.cache[setting.region] = setting;
      if (setting.topicArn) {
        this.topicArns.push(setting.topicArn);
      }
    });
  }
}

/**
 * Creates a new configuration set in AWS for given region
 * Totally consist of 4 configs.
 * 1. General - for general events
 * 2. Click - for click tracking
 * 3. Open - for open tracking
 * 4. Full - for click and open tracking
 */
async function registerConfigurationSet(setting: SesSetting) {
  if (!setting.topicArn) {
    throw new Error("Setting does not have a topic ARN");
  }

  const configGeneral = `${setting.idPrefix}-${setting.region}-unsend-general`;
  const generalStatus = await ses.addWebhookConfiguration(
    configGeneral,
    setting.topicArn,
    GENERAL_EVENTS,
    setting.region
  );

  const configClick = `${setting.idPrefix}-${setting.region}-unsend-click`;
  const clickStatus = await ses.addWebhookConfiguration(
    configClick,
    setting.topicArn,
    [...GENERAL_EVENTS, "CLICK"],
    setting.region
  );

  const configOpen = `${setting.idPrefix}-${setting.region}-unsend-open`;
  const openStatus = await ses.addWebhookConfiguration(
    configOpen,
    setting.topicArn,
    [...GENERAL_EVENTS, "OPEN"],
    setting.region
  );

  const configFull = `${setting.idPrefix}-${setting.region}-unsend-full`;
  const fullStatus = await ses.addWebhookConfiguration(
    configFull,
    setting.topicArn,
    [...GENERAL_EVENTS, "CLICK", "OPEN"],
    setting.region
  );

  const [updated] = await drizzleDb
    .update(schema.sesSetting)
    .set(
      withUpdatedAt({
        configGeneral,
        configGeneralSuccess: generalStatus,
        configClick,
        configClickSuccess: clickStatus,
        configOpen,
        configOpenSuccess: openStatus,
        configFull,
        configFullSuccess: fullStatus,
      }),
    )
    .where(eq(schema.sesSetting.id, setting.id))
    .returning();

  if (!updated) {
    throw new Error("SES setting not found");
  }

  return updated;
}

async function isValidUsesendUrl(url: string) {
  logger.info({ url }, "Checking if URL is valid");
  try {
    const response = await fetch(`${url}/api/ses_callback`, {
      method: "GET",
    });
    return {
      isValid: response.status === 200,
      code: response.status,
      error: response.statusText,
    };
  } catch (e) {
    logger.error({ err: e }, "Error checking if URL is valid");
    return {
      isValid: false,
      code: 500,
      error: e,
    };
  }
}
