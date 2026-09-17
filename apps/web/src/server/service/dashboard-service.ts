import { and, asc, eq, gte, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { drizzleDb, schema } from "../drizzle";
import { format, subDays } from "date-fns";
import { Team } from "~/types/db";

type EmailTimeSeries = {
  days?: number;
  domain?: number;
  team: Team;
};

export async function emailTimeSeries(input: EmailTimeSeries) {
  const days = input.days !== 7 ? 30 : 7;
  const { domain, team } = input;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const isoStartDate = startDate.toISOString().split("T")[0] as string;

  type DailyEmailUsage = {
    date: string;
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
    bounced: number;
    complained: number;
  };

  // A grouped sum, which the query builder expresses directly. The ::integer
  // casts stay: SUM over an integer column returns bigint.
  const sum = (column: AnyPgColumn) => sql<number>`SUM(${column})::integer`;

  const result = await drizzleDb
    .select({
      date: schema.dailyEmailUsage.date,
      sent: sum(schema.dailyEmailUsage.sent),
      delivered: sum(schema.dailyEmailUsage.delivered),
      opened: sum(schema.dailyEmailUsage.opened),
      clicked: sum(schema.dailyEmailUsage.clicked),
      bounced: sum(schema.dailyEmailUsage.bounced),
      complained: sum(schema.dailyEmailUsage.complained),
    })
    .from(schema.dailyEmailUsage)
    .where(
      and(
        eq(schema.dailyEmailUsage.teamId, team.id),
        gte(schema.dailyEmailUsage.date, isoStartDate),
        domain ? eq(schema.dailyEmailUsage.domainId, domain) : undefined,
      ),
    )
    .groupBy(schema.dailyEmailUsage.date)
    .orderBy(asc(schema.dailyEmailUsage.date));

  // Fill in any missing dates with 0 values
  const filledResult: DailyEmailUsage[] = [];
  const endDateObj = new Date();

  for (let i = days; i > -1; i--) {
    const dateStr = subDays(endDateObj, i)
      .toISOString()
      .split("T")[0] as string;
    const existingData = result.find((r) => r.date === dateStr);

    if (existingData) {
      filledResult.push({
        ...existingData,
        date: format(dateStr, "MMM dd"),
      });
    } else {
      filledResult.push({
        date: format(dateStr, "MMM dd"),
        sent: 0,
        delivered: 0,
        opened: 0,
        clicked: 0,
        bounced: 0,
        complained: 0,
      });
    }
  }

  const totalCounts = result.reduce(
    (acc, curr) => {
      acc.sent += curr.sent;
      acc.delivered += curr.delivered;
      acc.opened += curr.opened;
      acc.clicked += curr.clicked;
      acc.bounced += curr.bounced;
      acc.complained += curr.complained;
      return acc;
    },
    {
      sent: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
      bounced: 0,
      complained: 0,
    },
  );

  return { result: filledResult, totalCounts };
}

type ReputationMetricsData = {
  domain?: number;
  team: Team;
};

export async function reputationMetricsData(input: ReputationMetricsData) {
  const { domain, team } = input;

  const reputations = await drizzleDb
    .select()
    .from(schema.cumulatedMetrics)
    .where(
      and(
        eq(schema.cumulatedMetrics.teamId, team.id),
        domain ? eq(schema.cumulatedMetrics.domainId, domain) : undefined,
      ),
    );

  const results = reputations.reduce(
    (acc, curr) => {
      acc.delivered += Number(curr.delivered);
      acc.hardBounced += Number(curr.hardBounced);
      acc.complained += Number(curr.complained);
      return acc;
    },
    { delivered: 0, hardBounced: 0, complained: 0 },
  );

  const resultWithRates = {
    ...results,
    bounceRate: results.delivered
      ? (results.hardBounced / results.delivered) * 100
      : 0,
    complaintRate: results.delivered
      ? (results.complained / results.delivered) * 100
      : 0,
  };

  return resultWithRates;
}
