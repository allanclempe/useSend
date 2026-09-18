import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { H1 } from "@usesend/ui";

import { dashboardQueries } from "~/queries/dashboard";
import { domainQueries } from "~/queries/domain";
import { DashboardFilters } from "./-dashboard-filters";
import EmailChart from "./-email-chart";
import { ReputationMetrics } from "./-reputation-metrics";

/**
 * `/dashboard` — the analytics page.
 *
 * The two filters keep the names `useUrlState` gave them, `days` and `domain`,
 * because they are in people's bookmarks. `days` is restricted to the two the
 * tabs offer: the service caps the window by plan anyway, and a URL asking for
 * 3,650 days should show 30, not an error page. Both fields `.catch`.
 *
 * `ssr: false` is **not** set here even though this is the chart page. recharts
 * renders to SVG through `ResponsiveContainer`, which measures its parent and
 * therefore draws nothing until it is in a document — on the server it emits an
 * empty wrapper and no warning, and hydration fills it in. That is a wasted
 * measurement, not a crash, and skipping SSR would cost the surrounding page
 * its server render too.
 */
const searchSchema = z.object({
  days: z.coerce
    .number()
    .refine((value): value is 7 | 30 => value === 7 || value === 30)
    .catch(30),
  domain: z.coerce.number().int().positive().optional().catch(undefined),
});

export const Route = createFileRoute("/_dashboard/dashboard")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(
        dashboardQueries.timeSeries(deps.days, deps.domain),
      ),
      context.queryClient.ensureQueryData(
        dashboardQueries.reputation(deps.domain),
      ),
      // The filter dropdown names the domain in the URL; without this a
      // filtered link says "All Domains" for a moment and then corrects.
      context.queryClient.ensureQueryData(domainQueries.list()),
    ]),
  component: DashboardPage,
});

function DashboardPage() {
  const { days, domain } = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <div className="w-full">
      <div className="mb-10 flex items-center justify-between">
        <H1>Analytics</H1>
        <DashboardFilters
          days={days}
          domain={domain}
          onDaysChange={(next) =>
            void navigate({
              search: (previous) => ({ ...previous, days: next }),
              replace: true,
            })
          }
          onDomainChange={(next) =>
            void navigate({
              search: (previous) => ({ ...previous, domain: next }),
              replace: true,
            })
          }
        />
      </div>
      <div className="space-y-12">
        <EmailChart days={days} domain={domain} />
        <ReputationMetrics domain={domain} />
      </div>
    </div>
  );
}
