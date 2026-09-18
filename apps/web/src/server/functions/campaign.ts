import { createServerFn } from "@tanstack/react-start";
import { EmailRenderer } from "@usesend/email-editor/src/renderer";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";

import { badRequest, notFound } from "~/server/app-error";
import { drizzleDb, schema } from "~/server/drizzle";
import { createId } from "~/server/drizzle/id";
import { withUpdatedAt } from "~/server/drizzle/touch";
import {
  campaignMiddleware,
  teamMiddleware,
} from "~/server/functions/middleware";
import { nanoid } from "~/server/nanoid";
import * as campaignService from "~/server/service/campaign-service";
import { toCampaign } from "~/server/service/campaign-service";
import { validateDomainFromEmail } from "~/server/service/domain-service";
import {
  getDocumentUploadUrl,
  getDocumentUrl,
  isStorageConfigured,
} from "~/server/service/storage-service";
import { CampaignStatus } from "~/types/db";

/**
 * Campaigns, from `server/api/routers/campaign.ts` (#9).
 *
 * The write path is the interesting part. `from` is never taken on trust:
 * every mutation that can change it runs `validateDomainFromEmail`, which is
 * what ties a campaign to a verified domain this team owns. `content` is the
 * editor's JSON and `html` is rendered from it here rather than accepted from
 * the browser, with a raw `html` field as the escape hatch for the two places
 * that have no JSON document.
 *
 * `reSubscribeContact` is the one function in this module with no middleware
 * at all. It is reached from a link in a delivered email by someone who is not
 * signed in and never will be; what stands in for authorisation is the hash in
 * the URL, checked inside `subscribeContact`.
 */

const statuses = Object.values(CampaignStatus) as [CampaignStatus];

export const getCampaigns = createServerFn({ method: "GET" })
  .middleware([teamMiddleware])
  .validator(
    z.object({
      page: z.number().optional(),
      status: z.enum(statuses).optional().nullable(),
      search: z.string().optional().nullable(),
    }),
  )
  .handler(async ({ data, context }) => {
    const page = data.page || 1;
    const limit = 30;
    const offset = (page - 1) * limit;

    const where = and(
      eq(schema.campaign.teamId, context.team.id),
      data.status ? eq(schema.campaign.status, data.status) : undefined,
      data.search
        ? or(
            ilike(schema.campaign.name, `%${data.search}%`),
            ilike(schema.campaign.subject, `%${data.search}%`),
          )
        : undefined,
    );

    const countP = drizzleDb.$count(schema.campaign, where);

    const campaignsP = drizzleDb
      .select({
        id: schema.campaign.id,
        name: schema.campaign.name,
        from: schema.campaign.from,
        subject: schema.campaign.subject,
        createdAt: schema.campaign.createdAt,
        updatedAt: schema.campaign.updatedAt,
        status: schema.campaign.status,
        scheduledAt: schema.campaign.scheduledAt,
        total: schema.campaign.total,
        sent: schema.campaign.sent,
        delivered: schema.campaign.delivered,
        unsubscribed: schema.campaign.unsubscribed,
      })
      .from(schema.campaign)
      .where(where)
      .orderBy(desc(schema.campaign.createdAt))
      .offset(offset)
      .limit(limit);

    const [campaigns, count] = await Promise.all([campaignsP, countP]);

    return { campaigns, totalPage: Math.ceil(count / limit) };
  });

export const createCampaign = createServerFn({ method: "POST" })
  .middleware([teamMiddleware])
  .validator(
    z.object({
      name: z.string(),
      from: z.string(),
      subject: z.string(),
    }),
  )
  .handler(async ({ data, context }) => {
    const domain = await validateDomainFromEmail(data.from, context.team.id);

    const [campaign] = await drizzleDb
      .insert(schema.campaign)
      .values(
        withUpdatedAt({
          id: createId(),
          ...data,
          teamId: context.team.id,
          domainId: domain.id,
        }),
      )
      .returning();

    if (!campaign) {
      throw new Error("Failed to create campaign");
    }

    return campaign;
  });

export const updateCampaign = createServerFn({ method: "POST" })
  .middleware([campaignMiddleware])
  .validator(
    z.object({
      name: z.string().optional(),
      from: z.string().optional(),
      subject: z.string().optional(),
      previewText: z.string().optional(),
      content: z.string().optional(),
      html: z.string().optional(),
      contactBookId: z.string().optional(),
      replyTo: z.string().array().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const { team, campaign: campaignOld } = context;
    const { html: htmlInput, ...rest } = data;

    if (rest.contactBookId) {
      const [contactBook] = await drizzleDb
        .select({ id: schema.contactBook.id })
        .from(schema.contactBook)
        .where(
          and(
            eq(schema.contactBook.id, rest.contactBookId),
            eq(schema.contactBook.teamId, team.id),
          ),
        )
        .limit(1);

      if (!contactBook) {
        throw badRequest("Contact book not found");
      }
    }

    let domainId = campaignOld.domainId;
    if (rest.from) {
      const domain = await validateDomainFromEmail(rest.from, team.id);
      domainId = domain.id;
    }

    let htmlToSave: string | undefined;

    if (rest.content) {
      const jsonContent = rest.content ? JSON.parse(rest.content) : null;

      const renderer = new EmailRenderer(jsonContent);
      htmlToSave = await renderer.render();
    } else if (typeof htmlInput === "string") {
      htmlToSave = htmlInput;
    }

    const campaignUpdateData: Partial<typeof schema.campaign.$inferInsert> = {
      ...rest,
      domainId,
    };

    if (htmlToSave !== undefined) {
      campaignUpdateData.html = htmlToSave;
    }

    const [campaign] = await drizzleDb
      .update(schema.campaign)
      .set(withUpdatedAt(campaignUpdateData))
      .where(eq(schema.campaign.id, campaignOld.id))
      .returning();

    if (!campaign) {
      throw notFound("Campaign not found");
    }

    return campaign;
  });

export const deleteCampaign = createServerFn({ method: "POST" })
  .middleware([campaignMiddleware])
  .handler(({ context }) =>
    campaignService.deleteCampaign(context.campaign.id, context.team.id),
  );

/**
 * `campaignMiddleware` already selected the whole row, scoped to the team, so
 * the tRPC version's second identical `SELECT` — and its `BAD_REQUEST` on a
 * miss, which the loader answers as `NOT_FOUND` — are gone. The contact book
 * lookup below is a different query and stays.
 */
export const getCampaign = createServerFn({ method: "GET" })
  .middleware([campaignMiddleware])
  .handler(async ({ context }) => {
    const { team, campaign } = context;
    const imageUploadSupported = isStorageConfigured();

    if (campaign.contactBookId) {
      const [contactBook] = await drizzleDb
        .select()
        .from(schema.contactBook)
        .where(
          and(
            eq(schema.contactBook.id, campaign.contactBookId),
            eq(schema.contactBook.teamId, team.id),
          ),
        )
        .limit(1);

      return {
        ...toCampaign(campaign),
        contactBook: contactBook
          ? {
              ...contactBook,
              // jsonb reads as `unknown`; the editor expects a string map.
              properties: (contactBook.properties ?? {}) as Record<
                string,
                string
              >,
            }
          : null,
        imageUploadSupported,
      };
    }

    return {
      ...toCampaign(campaign),
      contactBook: null,
      imageUploadSupported,
    };
  });

export const latestEmails = createServerFn({ method: "GET" })
  .middleware([campaignMiddleware])
  .handler(({ context }) =>
    drizzleDb
      .select({
        id: schema.email.id,
        subject: schema.email.subject,
        to: schema.email.to,
        latestStatus: schema.email.latestStatus,
        createdAt: schema.email.createdAt,
        updatedAt: schema.email.updatedAt,
        scheduledAt: schema.email.scheduledAt,
      })
      .from(schema.email)
      .where(
        and(
          eq(schema.email.teamId, context.team.id),
          eq(schema.email.campaignId, context.campaign.id),
        ),
      )
      .orderBy(desc(schema.email.updatedAt), desc(schema.email.createdAt))
      .limit(10),
  );

export const reSubscribeContact = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string(), hash: z.string() }))
  .handler(async ({ data }) => {
    await campaignService.subscribeContact(data.id, data.hash);
  });

export const duplicateCampaign = createServerFn({ method: "POST" })
  .middleware([campaignMiddleware])
  .handler(async ({ context }) => {
    const { team, campaign } = context;

    const [newCampaign] = await drizzleDb
      .insert(schema.campaign)
      .values(
        withUpdatedAt({
          id: createId(),
          name: `${campaign.name} (Copy)`,
          from: campaign.from,
          replyTo: campaign.replyTo,
          cc: campaign.cc,
          bcc: campaign.bcc,
          subject: campaign.subject,
          previewText: campaign.previewText,
          content: campaign.content,
          html: campaign.html,
          teamId: team.id,
          domainId: campaign.domainId,
          contactBookId: campaign.contactBookId,
        }),
      )
      .returning();

    if (!newCampaign) {
      throw new Error("Failed to duplicate campaign");
    }

    return newCampaign;
  });

export const scheduleCampaign = createServerFn({ method: "POST" })
  .middleware([campaignMiddleware])
  .validator(
    z.object({
      scheduledAt: z.union([z.string().datetime(), z.date()]).optional(),
      batchSize: z.number().min(1).max(100_000).optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    await campaignService.scheduleCampaign({
      campaignId: context.campaign.id,
      teamId: context.team.id,
      scheduledAt: data.scheduledAt,
      batchSize: data.batchSize,
    });
    return { ok: true };
  });

export const pauseCampaign = createServerFn({ method: "POST" })
  .middleware([campaignMiddleware])
  .handler(async ({ context }) => {
    await campaignService.pauseCampaign({
      campaignId: context.campaign.id,
      teamId: context.campaign.teamId,
    });
    return { ok: true };
  });

export const resumeCampaign = createServerFn({ method: "POST" })
  .middleware([campaignMiddleware])
  .handler(async ({ context }) => {
    await campaignService.resumeCampaign({
      campaignId: context.campaign.id,
      teamId: context.campaign.teamId,
    });
    return { ok: true };
  });

export const generateImagePresignedUrl = createServerFn({ method: "POST" })
  .middleware([campaignMiddleware])
  .validator(z.object({ name: z.string(), type: z.string() }))
  .handler(async ({ data, context }) => {
    const extension = data.name.split(".").pop();
    const randomName = `${nanoid()}.${extension}`;

    const key = `${context.team.id}/${randomName}`;
    const url = await getDocumentUploadUrl(key, data.type);
    const imageUrl = getDocumentUrl(key);

    return { uploadUrl: url, imageUrl };
  });
