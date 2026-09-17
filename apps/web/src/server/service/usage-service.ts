import { EmailUsageType } from "~/types/db";
import { and, asc, eq, gte, sql, type SQL } from "drizzle-orm";
import { drizzleDb, schema } from "../drizzle";
import { format } from "date-fns";

type UsageRow = { type: EmailUsageType; sent: number };

/**
 * Sums sent email per usage type for a team, over whichever `date` predicate is
 * given.
 *
 * `DailyEmailUsage.date` is a text column holding `yyyy-MM-dd`, so string
 * comparison is the correct filter here, not a date cast.
 *
 * The `::integer` cast is load-bearing: Postgres `SUM` over an integer column
 * returns bigint, which postgres-js hands back as a string. Prisma's raw query
 * cast it the same way, so the shape callers see is unchanged.
 */
function sumSentByType(teamId: number, dateFilter: SQL) {
  return drizzleDb
    .select({
      type: schema.dailyEmailUsage.type,
      sent: sql<number>`SUM(${schema.dailyEmailUsage.sent})::integer`,
    })
    .from(schema.dailyEmailUsage)
    .where(and(eq(schema.dailyEmailUsage.teamId, teamId), dateFilter))
    .groupBy(schema.dailyEmailUsage.type);
}

/**
 * Gets the monthly and daily usage for a team
 * @param teamId - The team ID to get usage for
 * @returns Object containing month and day usage arrays
 */
export async function getThisMonthUsage(teamId: number) {
  const [team] = await drizzleDb
    .select({ id: schema.team.id, plan: schema.team.plan })
    .from(schema.team)
    .where(eq(schema.team.id, teamId))
    .limit(1);

  if (!team) {
    throw new Error("Team not found");
  }

  const isPaidPlan = team.plan !== "FREE";

  const [subscription] = isPaidPlan
    ? await drizzleDb
        .select({ currentPeriodStart: schema.subscription.currentPeriodStart })
        .from(schema.subscription)
        .where(eq(schema.subscription.teamId, team.id))
        .orderBy(asc(schema.subscription.status))
        .limit(1)
    : [];

  const isoStartDate = subscription?.currentPeriodStart
    ? format(subscription.currentPeriodStart, "yyyy-MM-dd")
    : format(new Date(), "yyyy-MM-01"); // First day of current month
  const today = format(new Date(), "yyyy-MM-dd");

  const [monthUsage, dayUsage] = await Promise.all([
    sumSentByType(team.id, gte(schema.dailyEmailUsage.date, isoStartDate)),
    // Deliberately equality, not `>= today`: the two diverge as soon as a row is
    // dated ahead of today, and this feeds billing.
    sumSentByType(team.id, eq(schema.dailyEmailUsage.date, today)),
  ]);

  return {
    month: monthUsage satisfies UsageRow[],
    day: dayUsage satisfies UsageRow[],
  };
}
