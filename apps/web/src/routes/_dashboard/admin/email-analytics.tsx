import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { Card, CardContent, CardHeader, CardTitle } from "@usesend/ui/src/card";
import { Label } from "@usesend/ui/src/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usesend/ui/src/select";
import Spinner from "@usesend/ui/src/spinner";
import { Switch } from "@usesend/ui/src/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@usesend/ui/src/table";

import { adminQueries } from "~/queries/admin";
import { isCloud } from "~/utils/common";

const timeframeOptions = [
  { label: "Today", value: "today" },
  { label: "This month", value: "thisMonth" },
] as const;

/**
 * `/admin/email-analytics`.
 *
 * The two filters live in the URL rather than in `useState`, which is the
 * change worth noticing: this is a page whose whole purpose is to be looked at
 * and then shown to someone else, and "this month, paid teams only" was not
 * linkable before. Both fields `.catch`, so a hand-edited URL falls back to the
 * default instead of throwing where the table was.
 *
 * `keepPreviousData` is kept: flipping the switch re-queries, and dropping the
 * table to a spinner for every toggle made the numbers harder to compare, which
 * is the only reason to toggle it.
 */
const searchSchema = z.object({
  timeframe: z.enum(["today", "thisMonth"]).default("today").catch("today"),
  paidOnly: z.boolean().default(false).catch(false),
});

export const Route = createFileRoute("/_dashboard/admin/email-analytics")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    isCloud()
      ? context.queryClient.ensureQueryData(adminQueries.emailAnalytics(deps))
      : null,
  component: AdminEmailAnalyticsPage,
});

const EMPTY_TOTALS = {
  sent: 0,
  delivered: 0,
  opened: 0,
  clicked: 0,
  bounced: 0,
  complained: 0,
  hardBounced: 0,
};

/** Ten columns, and the empty states have to say so. */
const COLUMN_COUNT = 10;

function AdminEmailAnalyticsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();

  const analyticsQuery = useQuery({
    ...adminQueries.emailAnalytics(search),
    enabled: isCloud(),
    placeholderData: keepPreviousData,
  });

  if (!isCloud()) {
    return (
      <div className="rounded-lg border bg-muted/30 p-6 text-sm text-muted-foreground">
        Email analytics are available only in the cloud deployment.
      </div>
    );
  }

  const data = analyticsQuery.data;
  const totals = data?.totals ?? EMPTY_TOTALS;
  const rows = data?.rows ?? [];

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">Email analytics</h2>
      <div className="flex flex-wrap gap-4">
        <div className="w-48">
          <Label htmlFor="timeframe">Timeframe</Label>
          <Select
            value={search.timeframe}
            onValueChange={(value) =>
              void navigate({
                to: "/admin/email-analytics",
                search: (prev) => ({
                  ...prev,
                  timeframe:
                    value as (typeof timeframeOptions)[number]["value"],
                }),
                replace: true,
              })
            }
          >
            <SelectTrigger id="timeframe">
              <SelectValue placeholder="Select timeframe" />
            </SelectTrigger>
            <SelectContent>
              {timeframeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center space-x-3">
          <Switch
            id="paid"
            checked={search.paidOnly}
            onCheckedChange={(paidOnly) =>
              void navigate({
                to: "/admin/email-analytics",
                search: (prev) => ({ ...prev, paidOnly }),
                replace: true,
              })
            }
          />
          <Label htmlFor="paid">Paid users only</Label>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Sent" value={totals.sent} />
        <SummaryCard label="Delivered" value={totals.delivered} />
        <SummaryCard label="Opened" value={totals.opened} />
        <SummaryCard label="Clicked" value={totals.clicked} />
        <SummaryCard label="Bounced" value={totals.bounced} />
        <SummaryCard label="Complained" value={totals.complained} />
        <SummaryCard label="Hard bounced" value={totals.hardBounced} />
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Usage by team</CardTitle>
            {data ? (
              <p className="text-sm text-muted-foreground">
                Since {data.timeframe === "today" ? "today" : data.periodStart}
              </p>
            ) : null}
          </div>
          {analyticsQuery.isFetching ? <Spinner className="h-4 w-4" /> : null}
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Team</TableHead>
                <TableHead>Team ID</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead className="text-right">Sent</TableHead>
                <TableHead className="text-right">Delivered</TableHead>
                <TableHead className="text-right">Opened</TableHead>
                <TableHead className="text-right">Clicked</TableHead>
                <TableHead className="text-right">Bounced</TableHead>
                <TableHead className="text-right">Complained</TableHead>
                <TableHead className="text-right">Hard bounced</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {analyticsQuery.isLoading ? (
                <TableRow>
                  <TableCell
                    colSpan={COLUMN_COUNT}
                    className="py-12 text-center"
                  >
                    <Spinner className="h-6 w-6" />
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={COLUMN_COUNT}
                    className="py-12 text-center"
                  >
                    No email activity found for this period.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <TableRow key={row.teamId}>
                    <TableCell>{row.name}</TableCell>
                    <TableCell>{row.teamId}</TableCell>
                    <TableCell>{row.plan}</TableCell>
                    <TableCell className="text-right">{row.sent}</TableCell>
                    <TableCell className="text-right">
                      {row.delivered}
                    </TableCell>
                    <TableCell className="text-right">{row.opened}</TableCell>
                    <TableCell className="text-right">{row.clicked}</TableCell>
                    <TableCell className="text-right">{row.bounced}</TableCell>
                    <TableCell className="text-right">
                      {row.complained}
                    </TableCell>
                    <TableCell className="text-right">
                      {row.hardBounced}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold">{value.toLocaleString()}</p>
      </CardContent>
    </Card>
  );
}
