import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { teamMiddleware } from "~/server/functions/middleware";
import {
  emailTimeSeries as emailTimeSeriesForTeam,
  reputationMetricsData as reputationMetricsDataForTeam,
} from "~/server/service/dashboard-service";

/**
 * The dashboard's two charts, from `server/api/routers/dashboard.ts` (#9).
 *
 * Both take the whole `team` row rather than its id, because the services read
 * the plan off it to decide how far back the series may go.
 */

export const emailTimeSeries = createServerFn({ method: "GET" })
  .middleware([teamMiddleware])
  .validator(
    z.object({
      days: z.number().optional(),
      domain: z.number().optional(),
    }),
  )
  .handler(({ data, context }) =>
    emailTimeSeriesForTeam({
      team: context.team,
      days: data.days,
      domain: data.domain,
    }),
  );

export const reputationMetricsData = createServerFn({ method: "GET" })
  .middleware([teamMiddleware])
  .validator(z.object({ domain: z.number().optional() }))
  .handler(({ data, context }) =>
    reputationMetricsDataForTeam({ team: context.team, domain: data.domain }),
  );
