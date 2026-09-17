import { CampaignStatus } from "~/types/db";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import { drizzleDb, schema } from "~/server/drizzle";
import { createId } from "~/server/drizzle/id";
import { withUpdatedAt } from "~/server/drizzle/touch";
import { TRPCError } from "@trpc/server";
import { EmailRenderer } from "@usesend/email-editor/src/renderer";
import { z } from "zod";
import { env } from "~/env";
import {
  teamProcedure,
  createTRPCRouter,
  campaignProcedure,
  publicProcedure,
} from "~/server/api/trpc";
import { logger } from "~/server/logger/log";
import { nanoid } from "~/server/nanoid";
import * as campaignService from "~/server/service/campaign-service";
import { toCampaign } from "~/server/service/campaign-service";
import { validateDomainFromEmail } from "~/server/service/domain-service";
import {
  getDocumentUploadUrl,
  isStorageConfigured,
} from "~/server/service/storage-service";

const statuses = Object.values(CampaignStatus) as [CampaignStatus];

export const campaignRouter = createTRPCRouter({
  getCampaigns: teamProcedure
    .input(
      z.object({
        page: z.number().optional(),
        status: z.enum(statuses).optional().nullable(),
        search: z.string().optional().nullable(),
      }),
    )
    .query(async ({ ctx: { team }, input }) => {
      const page = input.page || 1;
      const limit = 30;
      const offset = (page - 1) * limit;

      const where = and(
        eq(schema.campaign.teamId, team.id),
        input.status ? eq(schema.campaign.status, input.status) : undefined,
        input.search
          ? or(
              ilike(schema.campaign.name, `%${input.search}%`),
              ilike(schema.campaign.subject, `%${input.search}%`),
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
    }),

  createCampaign: teamProcedure
    .input(
      z.object({
        name: z.string(),
        from: z.string(),
        subject: z.string(),
      }),
    )
    .mutation(async ({ ctx: { team }, input }) => {
      const domain = await validateDomainFromEmail(input.from, team.id);

      const [campaign] = await drizzleDb
        .insert(schema.campaign)
        .values(
          withUpdatedAt({
            id: createId(),
            ...input,
            teamId: team.id,
            domainId: domain.id,
          }),
        )
        .returning();

      if (!campaign) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create campaign",
        });
      }

      return campaign;
    }),

  updateCampaign: campaignProcedure
    .input(
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
    .mutation(async ({ ctx: { team, campaign: campaignOld }, input }) => {
      const { html: htmlInput, campaignId, ...data } = input;
      if (data.contactBookId) {
        const [contactBook] = await drizzleDb
          .select({ id: schema.contactBook.id })
          .from(schema.contactBook)
          .where(
            and(
              eq(schema.contactBook.id, data.contactBookId),
              eq(schema.contactBook.teamId, team.id),
            ),
          )
          .limit(1);

        if (!contactBook) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Contact book not found",
          });
        }
      }
      let domainId = campaignOld.domainId;
      if (data.from) {
        const domain = await validateDomainFromEmail(data.from, team.id);
        domainId = domain.id;
      }

      let htmlToSave: string | undefined;

      if (data.content) {
        const jsonContent = data.content ? JSON.parse(data.content) : null;

        const renderer = new EmailRenderer(jsonContent);
        htmlToSave = await renderer.render();
      } else if (typeof htmlInput === "string") {
        htmlToSave = htmlInput;
      }

      const campaignUpdateData: Partial<typeof schema.campaign.$inferInsert> = {
        ...data,
        domainId,
      };

      if (htmlToSave !== undefined) {
        campaignUpdateData.html = htmlToSave;
      }

      const [campaign] = await drizzleDb
        .update(schema.campaign)
        .set(withUpdatedAt(campaignUpdateData))
        .where(eq(schema.campaign.id, campaignId))
        .returning();

      if (!campaign) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Campaign not found",
        });
      }

      return campaign;
    }),

  deleteCampaign: campaignProcedure.mutation(async ({ ctx: { team }, input }) => {
    return await campaignService.deleteCampaign(input.campaignId, team.id);
  }),

  getCampaign: campaignProcedure.query(async ({ ctx: { team }, input }) => {
    const [campaign] = await drizzleDb
      .select()
      .from(schema.campaign)
      .where(
        and(
          eq(schema.campaign.id, input.campaignId),
          eq(schema.campaign.teamId, team.id),
        ),
      )
      .limit(1);

    if (!campaign) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Campaign not found",
      });
    }

    const imageUploadSupported = isStorageConfigured();

    if (campaign?.contactBookId) {
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
  }),

  latestEmails: campaignProcedure.query(
    async ({ ctx: { team, campaign } }) => {
      const emails = await drizzleDb
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
            eq(schema.email.teamId, team.id),
            eq(schema.email.campaignId, campaign.id),
          ),
        )
        .orderBy(desc(schema.email.updatedAt), desc(schema.email.createdAt))
        .limit(10);

      return emails;
    },
  ),

  reSubscribeContact: publicProcedure
    .input(
      z.object({
        id: z.string(),
        hash: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      await campaignService.subscribeContact(input.id, input.hash);
    }),

  duplicateCampaign: campaignProcedure.mutation(
    async ({ ctx: { team, campaign } }) => {
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
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to duplicate campaign",
        });
      }

      return newCampaign;
    },
  ),

  scheduleCampaign: campaignProcedure
    .input(
      z.object({
        campaignId: z.string(),
        scheduledAt: z.union([z.string().datetime(), z.date()]).optional(),
        batchSize: z.number().min(1).max(100_000).optional(),
      }),
    )
    .mutation(async ({ ctx: { team }, input }) => {
      await campaignService.scheduleCampaign({
        campaignId: input.campaignId,
        teamId: team.id,
        scheduledAt: input.scheduledAt,
        batchSize: input.batchSize,
      });
      return { ok: true };
    }),

  pauseCampaign: campaignProcedure.mutation(async ({ ctx: { campaign } }) => {
    await campaignService.pauseCampaign({
      campaignId: campaign.id,
      teamId: campaign.teamId,
    });
    return { ok: true };
  }),

  resumeCampaign: campaignProcedure.mutation(async ({ ctx: { campaign } }) => {
    await campaignService.resumeCampaign({
      campaignId: campaign.id,
      teamId: campaign.teamId,
    });
    return { ok: true };
  }),

  generateImagePresignedUrl: campaignProcedure
    .input(
      z.object({
        name: z.string(),
        type: z.string(),
      }),
    )
    .mutation(async ({ ctx: { team }, input }) => {
      const extension = input.name.split(".").pop();
      const randomName = `${nanoid()}.${extension}`;

      const url = await getDocumentUploadUrl(
        `${team.id}/${randomName}`,
        input.type,
      );

      const imageUrl = `${env.S3_COMPATIBLE_PUBLIC_URL}/${team.id}/${randomName}`;

      return { uploadUrl: url, imageUrl };
    }),
});
