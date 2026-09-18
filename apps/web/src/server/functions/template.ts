import { createServerFn } from "@tanstack/react-start";
import { EmailRenderer } from "@usesend/email-editor/src/renderer";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { notFound } from "~/server/app-error";
import { drizzleDb, schema } from "~/server/drizzle";
import { createId } from "~/server/drizzle/id";
import { withUpdatedAt } from "~/server/drizzle/touch";
import {
  teamMiddleware,
  templateMiddleware,
} from "~/server/functions/middleware";
import { nanoid } from "~/server/nanoid";
import {
  getDocumentUploadUrl,
  getDocumentUrl,
  isStorageConfigured,
} from "~/server/service/storage-service";

/**
 * Email templates, from `server/api/routers/template.ts` (#9).
 *
 * `html` is derived, never sent: `updateTemplate` takes the editor's JSON in
 * `content` and renders it here, so the stored HTML cannot drift from the
 * document it came from. Passing `content` explicitly as `undefined` leaves
 * both alone; passing it as a string re-renders.
 *
 * `imageUploadSupported` rides along on `getTemplate` because R2 is a Worker
 * capability — under Node there is no bucket and the editor hides the picker.
 */

export const getTemplates = createServerFn({ method: "GET" })
  .middleware([teamMiddleware])
  .validator(z.object({ page: z.number().optional() }))
  .handler(async ({ data, context }) => {
    const page = data.page || 1;
    const limit = 30;
    const offset = (page - 1) * limit;

    const where = eq(schema.template.teamId, context.team.id);

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
  });

export const createTemplate = createServerFn({ method: "POST" })
  .middleware([teamMiddleware])
  .validator(z.object({ name: z.string(), subject: z.string() }))
  .handler(async ({ data, context }) => {
    const [template] = await drizzleDb
      .insert(schema.template)
      .values(
        withUpdatedAt({ id: createId(), ...data, teamId: context.team.id }),
      )
      .returning();

    if (!template) {
      throw new Error("Failed to create template");
    }

    return template;
  });

export const updateTemplate = createServerFn({ method: "POST" })
  .middleware([templateMiddleware])
  .validator(
    z.object({
      name: z.string().optional(),
      subject: z.string().optional(),
      content: z.string().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    let html: string | null = null;

    if (data.content) {
      const jsonContent = data.content ? JSON.parse(data.content) : null;

      const renderer = new EmailRenderer(jsonContent);
      html = await renderer.render();
    }

    const [template] = await drizzleDb
      .update(schema.template)
      .set(withUpdatedAt({ ...data, html }))
      .where(eq(schema.template.id, context.template.id))
      .returning();

    if (!template) {
      throw notFound("Template not found");
    }

    return template;
  });

export const deleteTemplate = createServerFn({ method: "POST" })
  .middleware([templateMiddleware])
  .handler(async ({ context }) => {
    const [template] = await drizzleDb
      .delete(schema.template)
      .where(
        and(
          eq(schema.template.id, context.template.id),
          eq(schema.template.teamId, context.team.id),
        ),
      )
      .returning();

    if (!template) {
      throw notFound("Template not found");
    }

    return template;
  });

/**
 * `templateMiddleware` already selected the whole row, scoped to the team, so
 * the tRPC version's second identical `SELECT` is gone. Its `BAD_REQUEST` on a
 * miss went with it — the loader answers `NOT_FOUND`, which is the code the
 * other five resources use.
 */
export const getTemplate = createServerFn({ method: "GET" })
  .middleware([templateMiddleware])
  .handler(({ context }) => ({
    ...context.template,
    imageUploadSupported: isStorageConfigured(),
  }));

export const duplicateTemplate = createServerFn({ method: "POST" })
  .middleware([templateMiddleware])
  .handler(async ({ context }) => {
    const { team, template } = context;

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
      throw new Error("Failed to duplicate template");
    }

    return newTemplate;
  });

export const generateImagePresignedUrl = createServerFn({ method: "POST" })
  .middleware([templateMiddleware])
  .validator(z.object({ name: z.string(), type: z.string() }))
  .handler(async ({ data, context }) => {
    const extension = data.name.split(".").pop();
    const randomName = `${nanoid()}.${extension}`;

    const key = `${context.team.id}/${randomName}`;
    const url = await getDocumentUploadUrl(key, data.type);
    const imageUrl = getDocumentUrl(key);

    return { uploadUrl: url, imageUrl };
  });
