import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { teamMiddleware } from "~/server/functions/middleware";
import { SuppressionService } from "~/server/service/suppression-service";
import { SuppressionReason } from "~/types/db";

/**
 * The suppression list, from `server/api/routers/suppression.ts` (#9).
 *
 * `exportSuppressions` is the same query as `getSuppressions` with the
 * pagination taken off and a hard cap of 10,000 rows in its place. It stays a
 * `GET` because it reads, even though the dashboard turns the result into a
 * file download.
 */

export const getSuppressions = createServerFn({ method: "GET" })
  .middleware([teamMiddleware])
  .validator(
    z.object({
      page: z.number().min(1).default(1),
      limit: z.number().min(1).max(100).default(20),
      search: z.string().optional(),
      reason: z.nativeEnum(SuppressionReason).optional().nullable(),
      sortBy: z.enum(["email", "reason", "createdAt"]).default("createdAt"),
      sortOrder: z.enum(["asc", "desc"]).default("desc"),
    }),
  )
  .handler(async ({ data, context }) => {
    const { page, limit, search, reason, sortBy, sortOrder } = data;

    const result = await SuppressionService.getSuppressionList({
      teamId: context.team.id,
      page,
      limit,
      search,
      reason,
      sortBy,
      sortOrder,
    });

    return {
      suppressions: result.suppressions,
      pagination: {
        page,
        limit,
        totalCount: result.total,
        totalPages: Math.ceil(result.total / limit),
        hasNext: page * limit < result.total,
        hasPrev: page > 1,
      },
    };
  });

export const addSuppression = createServerFn({ method: "POST" })
  .middleware([teamMiddleware])
  .validator(
    z.object({
      email: z.string().email(),
      reason: z.nativeEnum(SuppressionReason).default(SuppressionReason.MANUAL),
    }),
  )
  .handler(({ data, context }) =>
    SuppressionService.addSuppression({
      email: data.email,
      teamId: context.team.id,
      reason: data.reason,
    }),
  );

export const removeSuppression = createServerFn({ method: "POST" })
  .middleware([teamMiddleware])
  .validator(z.object({ email: z.string().email() }))
  .handler(async ({ data, context }) => {
    await SuppressionService.removeSuppression(data.email, context.team.id);
  });

export const bulkAddSuppressions = createServerFn({ method: "POST" })
  .middleware([teamMiddleware])
  .validator(
    z.object({
      emails: z.array(z.string().email()).max(1000),
      reason: z.nativeEnum(SuppressionReason).default(SuppressionReason.MANUAL),
    }),
  )
  .handler(({ data, context }) =>
    SuppressionService.addMultipleSuppressions(
      context.team.id,
      data.emails,
      data.reason,
    ),
  );

export const checkSuppression = createServerFn({ method: "GET" })
  .middleware([teamMiddleware])
  .validator(z.object({ email: z.string().email() }))
  .handler(({ data, context }) =>
    SuppressionService.isEmailSuppressed(data.email, context.team.id),
  );

export const checkMultipleSuppressions = createServerFn({ method: "GET" })
  .middleware([teamMiddleware])
  .validator(z.object({ emails: z.array(z.string().email()).max(100) }))
  .handler(({ data, context }) =>
    SuppressionService.checkMultipleEmails(data.emails, context.team.id),
  );

export const getSuppressionStats = createServerFn({ method: "GET" })
  .middleware([teamMiddleware])
  .handler(({ context }) =>
    SuppressionService.getSuppressionStats(context.team.id),
  );

export const exportSuppressions = createServerFn({ method: "GET" })
  .middleware([teamMiddleware])
  .validator(
    z.object({
      reason: z.nativeEnum(SuppressionReason).optional().nullable(),
      search: z.string().optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    // Get all suppressions without pagination for export
    const result = await SuppressionService.getSuppressionList({
      teamId: context.team.id,
      page: 1,
      limit: 10000, // Large limit for export
      search: data.search,
      reason: data.reason,
      sortBy: "createdAt",
      sortOrder: "desc",
    });

    return result.suppressions.map((suppression) => ({
      email: suppression.email,
      reason: suppression.reason,
      source: suppression.source,
      createdAt: suppression.createdAt.toISOString(),
    }));
  });
