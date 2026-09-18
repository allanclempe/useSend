import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { LimitReason } from "~/lib/constants/plans";
import { teamMiddleware } from "~/server/functions/middleware";
import { LimitService } from "~/server/service/limit-service";

/**
 * Plan limits, from `server/api/routers/limits.ts` (#9).
 *
 * One function over four checks, because the dashboard asks the same question
 * ("may I add another one of these?") from four different dialogs and wants
 * the same `{ isLimitReached, limit }` answer each time. `LimitReason` also
 * covers the email send limit, which is deliberately not reachable from here:
 * it is enforced at the send seam, and answering it per request would put a
 * usage query in front of every page.
 */

export const get = createServerFn({ method: "GET" })
  .middleware([teamMiddleware])
  .validator(z.object({ type: z.nativeEnum(LimitReason) }))
  .handler(({ data, context }) => {
    switch (data.type) {
      case LimitReason.CONTACT_BOOK:
        return LimitService.checkContactBookLimit(context.team.id);
      case LimitReason.DOMAIN:
        return LimitService.checkDomainLimit(context.team.id);
      case LimitReason.TEAM_MEMBER:
        return LimitService.checkTeamMemberLimit(context.team.id);
      case LimitReason.WEBHOOK:
        return LimitService.checkWebhookLimit(context.team.id);
      default:
        // exhaustive guard
        throw new Error("Unsupported limit type");
    }
  });
