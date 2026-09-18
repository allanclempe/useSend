import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  Bar,
  BarChart,
  Rectangle,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from "recharts";

import { dashboardQueries } from "~/queries/dashboard";
import { EmailStatus } from "~/types/db";
import { useColors } from "./-chart-colors";

/**
 * Sends per day, stacked by outcome.
 *
 * The stack order is fixed rather than derived from the data, because the bar
 * has to look the same from one day to the next, and `createRoundedTopShape`
 * needs to know which segment is on top *for that bar* -- a day with no clicks
 * has a different top segment from the day beside it.
 *
 * Clicking a metric filters the stack. An empty selection means "all of them",
 * not "none": that is what makes the first render show a full chart rather
 * than an empty one.
 */

const STACK_ORDER = [
  "delivered",
  "bounced",
  "complained",
  "opened",
  "clicked",
] as const;

type StackKey = (typeof STACK_ORDER)[number];

type ChartRow = Partial<Record<StackKey, number>>;

/**
 * Rounds the top corners of whichever segment is highest in *this* bar.
 *
 * Rounding every segment would put a notch between each pair; rounding only
 * the last key in the stack order would round a segment buried under another
 * one on any day where the metrics above it are zero.
 */
function createRoundedTopShape(
  currentKey: StackKey,
  visibleStackOrder: Array<StackKey>,
) {
  const currentIndex = visibleStackOrder.indexOf(currentKey);

  // recharts types `shape` as `(props: unknown) => Element`, so the row it
  // hands back has to be narrowed here rather than declared in the signature.
  // The Next.js version reached for `any` at this seam; this keeps the cast to
  // the one property that is read.
  return function RoundedTop(props: unknown) {
    const row = (props as { payload?: ChartRow }).payload;

    const above = visibleStackOrder
      .slice(currentIndex + 1)
      .some((key) => (row?.[key] ?? 0) > 0);

    return (
      <Rectangle
        {...(props as React.ComponentProps<typeof Rectangle>)}
        radius={above ? 0 : [2.5, 2.5, 0, 0]}
      />
    );
  };
}

export default function EmailChart({
  days,
  domain,
}: {
  days: number;
  domain: number | undefined;
}) {
  const [selectedMetrics, setSelectedMetrics] = useState<Array<StackKey>>([]);
  const statusQuery = useQuery(dashboardQueries.timeSeries(days, domain));

  const colors = useColors();

  const metricMeta: Record<StackKey, { label: string; color: string }> = {
    delivered: { label: "Delivered", color: colors.delivered },
    bounced: { label: "Bounced", color: colors.bounced },
    complained: { label: "Complained", color: colors.complained },
    opened: { label: "Opened", color: colors.opened },
    clicked: { label: "Clicked", color: colors.clicked },
  };

  const visibleMetrics: Array<StackKey> =
    selectedMetrics.length === 0
      ? [...STACK_ORDER]
      : STACK_ORDER.filter((key) => selectedMetrics.includes(key));

  function toggleMetric(metric: StackKey) {
    setSelectedMetrics((previous) => {
      if (previous.includes(metric)) {
        return previous.filter((key) => key !== metric);
      }

      // Kept in stack order, not click order, so the legend and the bars agree.
      const next = new Set([...previous, metric]);
      return STACK_ORDER.filter((key) => next.has(key));
    });
  }

  // The fixed height is held even while loading, so the reputation cards below
  // do not jump up the page and back down again.
  if (statusQuery.isLoading || !statusQuery.data) {
    return <div className="h-[450px]" />;
  }

  const { totalCounts, result } = statusQuery.data;

  return (
    <div className="h-[450px] w-full rounded-xl border p-4 shadow">
      <div className="overflow-x-auto p-2">
        <div className="flex gap-10">
          <EmailChartItem
            status="total"
            count={totalCounts.sent}
            percentage={100}
            isActive={selectedMetrics.length === 0}
            isClickable={false}
          />
          {STACK_ORDER.map((key) => {
            const status = key.toUpperCase() as EmailStatus;

            return (
              <EmailChartItem
                key={key}
                status={status}
                count={totalCounts[key]}
                percentage={totalCounts[key] / totalCounts.sent}
                isActive={
                  selectedMetrics.length === 0 || selectedMetrics.includes(key)
                }
                onClick={() => toggleMetric(key)}
              />
            );
          })}
        </div>
      </div>
      <ResponsiveContainer width="100%" height="80%">
        <BarChart
          data={result}
          margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
        >
          <XAxis
            dataKey="date"
            fontSize={12}
            className="font-mono"
            stroke={colors.xaxis}
            tick={{ fill: colors.xaxis, fillOpacity: 0.65 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            cursor={false}
            content={({ payload }) => {
              const row = payload?.[0]?.payload as
                (ChartRow & { date: string }) | undefined;

              if (!row) {
                return null;
              }

              const shown = visibleMetrics.filter((key) => row[key]);

              // A day with nothing in it gets no tooltip rather than an empty
              // box that follows the cursor across the gaps.
              if (shown.length === 0) {
                return null;
              }

              return (
                <div className="flex flex-col gap-2 rounded-xl border bg-background p-2 px-4 shadow-lg">
                  <p className="text-sm text-muted-foreground">{row.date}</p>
                  {shown.map((key) => (
                    <div key={key} className="flex items-center gap-2">
                      <div
                        className="h-2.5 w-2.5 rounded-[2px]"
                        style={{ backgroundColor: metricMeta[key].color }}
                      />
                      <p className="w-[70px] text-xs text-muted-foreground">
                        {metricMeta[key].label}
                      </p>
                      <p className="font-mono text-xs">{row[key]}</p>
                    </div>
                  ))}
                </div>
              );
            }}
          />
          {visibleMetrics.map((key) => (
            <Bar
              key={key}
              barSize={20}
              dataKey={key}
              stackId="a"
              fill={metricMeta[key].color}
              shape={createRoundedTopShape(key, visibleMetrics)}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

const EmailChartItem: React.FC<{
  status: EmailStatus | "total";
  count: number;
  percentage: number;
  onClick?: () => void;
  isActive?: boolean;
  isClickable?: boolean;
}> = ({
  status,
  count,
  percentage,
  onClick,
  isActive = false,
  isClickable = true,
}) => {
  const colors = useColors();

  const swatch: Partial<Record<EmailStatus | "total", string>> = {
    DELIVERED: colors.delivered,
    BOUNCED: colors.bounced,
    COMPLAINED: colors.complained,
    OPENED: colors.opened,
    CLICKED: colors.clicked,
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!isClickable}
      aria-pressed={isClickable ? isActive : undefined}
      className={`flex items-stretch gap-3 font-mono transition-opacity ${
        isClickable ? "cursor-pointer" : "pointer-events-none cursor-default"
      } ${isActive ? "opacity-100" : "opacity-45 hover:opacity-100"}`}
    >
      <div>
        <div className="flex items-center gap-2">
          <div
            className="h-2.5 w-2.5 rounded-[3px]"
            style={{ backgroundColor: swatch[status] ?? "#6b7280" }}
          />
          <div className="text-xs uppercase text-muted-foreground">
            {status.toLowerCase()}
          </div>
        </div>
        <div className="-ml-0.5 mt-1">
          <span className="font-mono text-xl">{count}</span>
          <span className="ml-2 font-mono text-xs">
            {status !== "total" && Number.isFinite(percentage)
              ? `(${count > 0 ? (percentage * 100).toFixed(0) : 0}%)`
              : null}
          </span>
        </div>
      </div>
    </button>
  );
};
