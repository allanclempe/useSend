import { and, desc, eq } from "drizzle-orm";
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
  templateProcedure,
} from "~/server/api/trpc";
import { nanoid } from "~/server/nanoid";
import {
  getDocumentUploadUrl,
  isStorageConfigured,
} from "~/server/service/storage-service";

export const templateRouter = createTRPCRouter({
  getTemplates: teamProcedure
    .input(
      z.object({
        page: z.number().optional(),
      }),
    )
    .query(async ({ ctx: { team }, input }) => {
      const page = input.page || 1;
      const limit = 30;
      const offset = (page - 1) * limit;

      const where = eq(schema.template.teamId, team.id);

      const countP = drizzleDb.$count(schema.template, where);

      const templatesP = drizzleDb
        .select({
          id: schema.template.id,
          name: schema.template.name,
          subject: schema.template.subject,
          createdAt: schema.template.createdAt,
          updatedAt: schema.template.updatedAt,
          html: schema.template.html,
        })
        .from(schema.template)
        .where(where)
        .orderBy(desc(schema.template.createdAt))
        .offset(offset)
        .limit(limit);

      const [templates, count] = await Promise.all([templatesP, countP]);

      return { templates, totalPage: Math.ceil(count / limit) };
    }),

  createTemplate: teamProcedure
    .input(
      z.object({
        name: z.string(),
        subject: z.string(),
      }),
    )
    .mutation(async ({ ctx: { team }, input }) => {
      const [template] = await drizzleDb
        .insert(schema.template)
        .values(withUpdatedAt({ id: createId(), ...input, teamId: team.id }))
        .returning();

      if (!template) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create template",
        });
      }

      return template;
    }),

  updateTemplate: templateProcedure
    .input(
      z.object({
        name: z.string().optional(),
        subject: z.string().optional(),
        content: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { templateId, ...data } = input;
      let html: string | null = null;

      if (data.content) {
        const jsonContent = data.content ? JSON.parse(data.content) : null;

        const renderer = new EmailRenderer(jsonContent);
        html = await renderer.render();
      }

      const [template] = await drizzleDb
        .update(schema.template)
        .set(withUpdatedAt({ ...data, html }))
        .where(eq(schema.template.id, templateId))
        .returning();

      if (!template) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Template not found",
        });
      }

      return template;
    }),

  deleteTemplate: templateProcedure.mutation(
    async ({ ctx: { team }, input }) => {
      const [template] = await drizzleDb
        .delete(schema.template)
        .where(
          and(
            eq(schema.template.id, input.templateId),
            eq(schema.template.teamId, team.id),
          ),
        )
        .returning();

      if (!template) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Template not found",
        });
      }

      return template;
    },
  ),

  getTemplate: templateProcedure.query(async ({ ctx: { team }, input }) => {
    const [template] = await drizzleDb
      .select()
      .from(schema.template)
      .where(
        and(
          eq(schema.template.id, input.templateId),
          eq(schema.template.teamId, team.id),
        ),
      )
      .limit(1);

    if (!template) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Template not found",
      });
    }

    const imageUploadSupported = isStorageConfigured();

    return {
      ...template,
      imageUploadSupported,
    };
  }),

  duplicateTemplate: templateProcedure.mutation(
    async ({ ctx: { team, template }, input }) => {
      const [newTemplate] = await drizzleDb
        .insert(schema.template)
        .values(
          withUpdatedAt({
            id: createId(),
            name: `${template.name} (Copy)`,
            subject: template.subject,
            content: template.content,
            teamId: team.id,
          }),
        )
        .returning();

      if (!newTemplate) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to duplicate template",
        });
      }

      return newTemplate;
    },
  ),

  generateImagePresignedUrl: templateProcedure
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
