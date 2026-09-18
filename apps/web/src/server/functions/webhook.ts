import { createServerFn } from "@tanstack/react-start";
import { WebhookEvents } from "@usesend/lib/src/webhook/webhook-events";
import { z } from "zod";

import { teamMiddleware } from "~/server/functions/middleware";
import { WebhookService } from "~/server/service/webhook-service";
import { WebhookCallStatus, WebhookStatus } from "~/types/db";

/**
 * Webhook endpoints and their delivery log, from
 * `server/api/routers/webhook.ts` (#9).
 *
 * Every one of these is `teamMiddleware` plus a `teamId` handed to
 * `WebhookService`, which is where the ownership check lives — there is no
 * `webhookMiddleware`, so the id in the input is never trusted on its own.
 *
 * The tRPC procedure was called `delete`, which cannot be an exported binding
 * in JavaScript; this one is `deleteWebhook`.
 */

const EVENT_TYPES_ENUM = z.enum(WebhookEvents);

export const list = createServerFn({ method: "GET" })
  .middleware([teamMiddleware])
  .handler(({ context }) => WebhookService.listWebhooks(context.team.id));

export const getById = createServerFn({ method: "GET" })
  .middleware([teamMiddleware])
  .validator(z.object({ id: z.string() }))
  .handler(({ data, context }) =>
    WebhookService.getWebhook({ id: data.id, teamId: context.team.id }),
  );

export const create = createServerFn({ method: "POST" })
  .middleware([teamMiddleware])
  .validator(
    z.object({
      url: z.string().url(),
      description: z.string().optional(),
      eventTypes: z.array(EVENT_TYPES_ENUM),
      domainIds: z.array(z.number().int().positive()).optional(),
      secret: z.string().min(16).optional(),
    }),
  )
  .handler(({ data, context }) =>
    WebhookService.createWebhook({
      teamId: context.team.id,
      userId: context.user.id,
      url: data.url,
      description: data.description,
      eventTypes: data.eventTypes,
      domainIds: data.domainIds,
      secret: data.secret,
    }),
  );

export const update = createServerFn({ method: "POST" })
  .middleware([teamMiddleware])
  .validator(
    z.object({
      id: z.string(),
      url: z.string().url().optional(),
      description: z.string().nullable().optional(),
      eventTypes: z.array(EVENT_TYPES_ENUM).optional(),
      domainIds: z.array(z.number().int().positive()).optional(),
      rotateSecret: z.boolean().optional(),
      secret: z.string().min(16).optional(),
    }),
  )
  .handler(({ data, context }) =>
    WebhookService.updateWebhook({
      id: data.id,
      teamId: context.team.id,
      url: data.url,
      description: data.description,
      eventTypes: data.eventTypes,
      domainIds: data.domainIds,
      rotateSecret: data.rotateSecret,
      secret: data.secret,
    }),
  );

export const setStatus = createServerFn({ method: "POST" })
  .middleware([teamMiddleware])
  .validator(z.object({ id: z.string(), status: z.nativeEnum(WebhookStatus) }))
  .handler(({ data, context }) =>
    WebhookService.setWebhookStatus({
      id: data.id,
      teamId: context.team.id,
      status: data.status,
    }),
  );

export const deleteWebhook = createServerFn({ method: "POST" })
  .middleware([teamMiddleware])
  .validator(z.object({ id: z.string() }))
  .handler(({ data, context }) =>
    WebhookService.deleteWebhook({ id: data.id, teamId: context.team.id }),
  );

export const test = createServerFn({ method: "POST" })
  .middleware([teamMiddleware])
  .validator(z.object({ id: z.string() }))
  .handler(({ data, context }) =>
    WebhookService.testWebhook({
      webhookId: data.id,
      teamId: context.team.id,
    }),
  );

export const listCalls = createServerFn({ method: "GET" })
  .middleware([teamMiddleware])
  .validator(
    z.object({
      webhookId: z.string().optional(),
      status: z.nativeEnum(WebhookCallStatus).optional(),
      limit: z.number().min(1).max(50).default(20),
      cursor: z.string().optional(),
    }),
  )
  .handler(({ data, context }) =>
    WebhookService.listWebhookCalls({
      teamId: context.team.id,
      webhookId: data.webhookId,
      status: data.status,
      limit: data.limit,
      cursor: data.cursor,
    }),
  );

export const getCall = createServerFn({ method: "GET" })
  .middleware([teamMiddleware])
  .validator(z.object({ id: z.string() }))
  .handler(({ data, context }) =>
    WebhookService.getWebhookCall({ id: data.id, teamId: context.team.id }),
  );

export const retryCall = createServerFn({ method: "POST" })
  .middleware([teamMiddleware])
  .validator(z.object({ id: z.string() }))
  .handler(({ data, context }) =>
    WebhookService.retryCall({ callId: data.id, teamId: context.team.id }),
  );
