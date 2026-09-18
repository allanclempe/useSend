import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2Icon,
  InfoIcon,
  OctagonAlertIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  YAxis,
} from "recharts";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@usesend/ui/src/tooltip";

import {
  COMPLAINED_RISK_RATE,
  COMPLAINED_WARNING_RATE,
  HARD_BOUNCE_RISK_RATE,
  HARD_BOUNCE_WARNING_RATE,
} from "~/lib/constants";
import { dashboardQueries } from "~/queries/dashboard";
import { useColors } from "./-chart-colors";

/**
 * Bounce rate and complaint rate against the thresholds SES suspends accounts
 * over.
 *
 * The Next.js version was two near-identical 180-line blocks that differed in
 * six values: the heading, the explanation, the rate, the Y-axis scale and the
 * two thresholds. They are one `ReputationCard` here. The duplication was not
 * cosmetic -- the complaint card's `YAxis` had lost its `tickLine={false}`
 * somewhere along the way, so the two charts did not match.
 *
 * `days` is not a parameter. `reputationMetricsData` reports on the whole
 * account, not a window, and the Next.js page passed `days` to it anyway --
 * where it was accepted and ignored. Passing it would have suggested the
 * timeframe tabs changed these numbers, which they never did.
 */

type AccountStatus = "HEALTHY" | "WARNING" | "RISK";

function statusFor(rate: number, warningAt: number, riskAt: number) {
  if (rate > riskAt) {
    return "RISK";
  }

  return rate > warningAt ? "WARNING" : "HEALTHY";
}

export function ReputationMetrics({ domain }: { domain: number | undefined }) {
  const metricsQuery = useQuery(dashboardQueries.reputation(domain));
  const metrics = metricsQuery.data;

  return (
    <TooltipProvider>
      <div className="flex w-full flex-col gap-10 sm:flex-row">
        <ReputationCard
          title="Bounce Rate"
          explanation="The percentage of emails sent from your account that resulted in a hard bounce."
          rate={metrics?.bounceRate}
          warningAt={HARD_BOUNCE_WARNING_RATE}
          riskAt={HARD_BOUNCE_RISK_RATE}
          axisMax={15}
          axisTicks={[0, 5, 10, 15]}
        />
        <ReputationCard
          title="Complaint Rate"
          explanation="The percentage of emails sent from your account that resulted in recipients reporting them as spam."
          rate={metrics?.complaintRate}
          warningAt={COMPLAINED_WARNING_RATE}
          riskAt={COMPLAINED_RISK_RATE}
          axisMax={0.8}
          axisTicks={[0, 0.2, 0.4, 0.6, 0.8]}
        />
      </div>
    </TooltipProvider>
  );
}

function ReputationCard({
  title,
  explanation,
  rate,
  warningAt,
  riskAt,
  axisMax,
  axisTicks,
}: {
  title: string;
  explanation: string;
  rate: number | undefined;
  warningAt: number;
  riskAt: number;
  axisMax: number;
  axisTicks: Array<number>;
}) {
  const colors = useColors();
  const data = rate === undefined ? [] : [{ name: title, value: rate }];

  return (
    <div className="w-full rounded-xl border p-4 shadow sm:w-1/2">
      <div className="flex items-center gap-2">
        <div className="font-mono text-muted-foreground">{title}</div>
        <Tooltip>
          <TooltipTrigger>
            <InfoIcon className="h-3.5 w-3.5 text-muted-foreground" />
          </TooltipTrigger>
          <TooltipContent className="w-[300px]">{explanation}</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex items-baseline gap-4">
        <div className="mt-2 font-mono text-2xl">{rate?.toFixed(2)}%</div>
        <StatusBadge status={statusFor(rate ?? 0, warningAt, riskAt)} />
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ top: 20, left: -30, bottom: 5 }}>
          <YAxis
            domain={[0, axisMax]}
            ticks={axisTicks}
            fontSize={12}
            tickFormatter={(value) => `${value}%`}
            axisLine={false}
            tickLine={false}
            interval={0}
          />
          <CartesianGrid
            vertical={false}
            strokeDasharray="3 3"
            stroke={`${colors.xaxis}50`}
          />
          <ReferenceLine
            y={warningAt}
            stroke={`${colors.complained}A0`}
            strokeDasharray="3 3"
          />
          <ReferenceLine
            y={riskAt}
            stroke={`${colors.bounced}A0`}
            strokeDasharray="3 3"
          />
          <RechartsTooltip
            cursor={false}
            content={({ payload }) => {
              const row = payload?.[0]?.payload as
                { name: string; value: number } | undefined;

              if (!row) {
                return null;
              }

              return (
                <div className="flex flex-col gap-2 rounded-xl border bg-background p-2 px-4 shadow-lg">
                  <p className="text-sm text-muted-foreground">{row.name}</p>
                  <TooltipRow
                    swatch={colors.clicked}
                    label="Current"
                    value={`${row.value.toFixed(2)}%`}
                  />
                  <TooltipRow
                    swatch={colors.complained}
                    label="Warning at"
                    value={`${warningAt}%`}
                  />
                  <TooltipRow
                    swatch={colors.bounced}
                    label="Risk at"
                    value={`${riskAt}%`}
                  />
                </div>
              );
            }}
          />
          <Bar
            barSize={150}
            dataKey="value"
            fill={colors.clicked}
            radius={[8, 8, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function TooltipRow({
  swatch,
  label,
  value,
}: {
  swatch: string;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-2.5 w-2.5 rounded-[2px]"
        style={{ background: swatch }}
      />
      <p className="w-[70px] text-xs text-muted-foreground">{label}</p>
      <p className="font-mono text-xs">{value}</p>
    </div>
  );
}

export const StatusBadge: React.FC<{ status: AccountStatus }> = ({
  status,
}) => {
  const className =
    status === "HEALTHY"
      ? "text-success border-success"
      : status === "WARNING"
        ? "text-warning border-warning"
        : "text-destructive border-destructive";

  const StatusIcon =
    status === "HEALTHY"
      ? CheckCircle2Icon
      : status === "WARNING"
        ? TriangleAlertIcon
        : OctagonAlertIcon;

  return (
    <div
      className={`flex items-center gap-1 rounded-lg text-xs capitalize ${className}`}
    >
      <StatusIcon className="h-3.5 w-3.5" />
      {status.toLowerCase()}
    </div>
  );
};

export default ReputationMetrics;
