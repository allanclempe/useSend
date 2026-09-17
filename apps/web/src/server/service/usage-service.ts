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

/**
 * UTC, matching the day bucket `ses-hook-parser` uses for every other counter on
 * the row. A `sent` figure bucketed on a different day boundary from the
 * `delivered` beside it would not be comparable.
 */
function usageDate(): string {
  return new Date().toISOString().split("T")[0] as string;
}

/** `Email.domainId` is nullable; `DailyEmailUsage.domainId` is part of the primary key. */
const NO_DOMAIN_BUCKET = sql`0`;

/**
 * Records `DailyEmailUsage.sent` for emails we have just accepted.
 *
 * `sent` used to be written by `ses-hook-parser`, from the SES `Send`
 * notification — about a quarter of the event pipeline spent learning something
 * we already knew, with billing hanging off an SNS round-trip that can be
 * delayed, dropped or replayed. It is counted here instead, at the moment the
 * email is handed to the send queue.
 *
 * **The billing semantic is "accepted", not "SES-acknowledged".** We bill for
 * what the customer asked us to do, measured at the point we took
 * responsibility for it. `reverseAcceptedSend` gives back the ones that
 * provably never reached SES.
 *
 * Idempotent. `WHERE "usageCountedAt" IS NULL` is the guard: only the statement
 * that wins that transition contributes, so a retried enqueue, a replayed job
 * or a redelivered queue message increments once. The guard is deliberately in
 * the database rather than leaning on `EnqueueOptions.jobId` — job-id dedup is a
 * BullMQ affordance and Cloudflare Queues has no equivalent, so a guard built on
 * it would quietly stop working during the migration.
 *
 * One statement, so the mark and the increment cannot come apart and a bulk
 * send costs one round trip rather than one per email.
 *
 * @param emailIds Emails just accepted. Ids already counted are ignored.
 * @returns How many were newly counted.
 */
export async function recordAcceptedSends(
  emailIds: readonly string[],
): Promise<number> {
  if (emailIds.length === 0) {
    return 0;
  }

  const ids = sql.join(
    emailIds.map((id) => sql`${id}`),
    sql`, `,
  );

  const rows = await drizzleDb.execute<{ counted: number }>(sql`
    WITH accepted AS (
      UPDATE "Email"
      -- Explicitly the UTC wall clock, not CURRENT_TIMESTAMP: the column is
      -- \`timestamp without time zone\`, and \`reverseAcceptedSend\` reads the day
      -- back out of it to find the row this increment landed on. Both ends have
      -- to agree with \`usageDate()\`, whatever the session timezone is.
      SET "usageCountedAt" = (now() AT TIME ZONE 'UTC'),
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" IN (${ids})
        AND "usageCountedAt" IS NULL
      RETURNING "teamId", "domainId", "campaignId"
    ),
    grouped AS MATERIALIZED (
      SELECT
        "teamId",
        COALESCE("domainId", ${NO_DOMAIN_BUCKET}) AS "domainId",
        (CASE WHEN "campaignId" IS NULL THEN 'TRANSACTIONAL' ELSE 'MARKETING' END)::"EmailUsageType" AS "type",
        COUNT(*)::integer AS "sent"
      FROM accepted
      GROUP BY 1, 2, 3
    ),
    -- A data-modifying CTE runs to completion whether or not the outer query
    -- reads it, so this INSERT happens even though the SELECT below ignores it.
    -- Written this way so the statement can still return a count.
    recorded AS (
      INSERT INTO "DailyEmailUsage" ("teamId", "domainId", "date", "type", "sent", "createdAt", "updatedAt")
      SELECT "teamId", "domainId", ${usageDate()}, "type", "sent", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM grouped
      ON CONFLICT ("teamId", "domainId", "date", "type") DO UPDATE
        SET "sent" = "DailyEmailUsage"."sent" + EXCLUDED."sent",
            "updatedAt" = CURRENT_TIMESTAMP
      RETURNING 1
    )
    SELECT COALESCE((SELECT SUM("sent") FROM grouped), 0)::integer AS "counted"
  `);

  return rows[0]?.counted ?? 0;
}

/**
 * Gives back a `sent` count for an email that was accepted but never handed to
 * SES — the customer cancelled a scheduled send, the team hit its plan limit
 * before the worker got to it, or `sendRawEmail` threw.
 *
 * Before `sent` moved to enqueue time these cost nothing: no SES handoff meant
 * no `Send` notification, so nothing was ever counted. Counting on acceptance
 * would start billing for them, which is the one way "bill for accepted sends"
 * reads as overcharging, so acceptance is reversed rather than left standing.
 *
 * **A SES `Reject` is deliberately not reversed.** Reject means SES took the
 * message and then refused it at handoff — we did the work and the message left
 * our system, so it stays billed. It also arrives over SNS, and honouring it
 * would put billing back on the round-trip this change exists to remove, days
 * after `usage-job` has already reported the figure to Stripe as metered usage
 * that cannot be corrected downwards.
 *
 * Idempotent and safe to call on an email that was never counted: clearing
 * `usageCountedAt` is the guard, so at most one decrement can follow one
 * increment, and `sent` cannot be driven below what was counted.
 *
 * @returns Whether a count was actually reversed.
 */
export async function reverseAcceptedSend(emailId: string): Promise<boolean> {
  const rows = await drizzleDb.execute<{ reversed: number }>(sql`
    WITH reversed AS (
      -- Self-joined so the statement can see the value it is about to clear.
      -- \`RETURNING\` yields post-update values, and the day to correct is the one
      -- \`usageCountedAt\` held before it was nulled; \`prev\` is read from the
      -- pre-update snapshot. The row lock on \`e\` still means only one of two
      -- concurrent reversals gets past \`IS NOT NULL\`.
      UPDATE "Email" AS e
      SET "usageCountedAt" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
      FROM "Email" AS prev
      WHERE e."id" = ${emailId}
        AND prev."id" = e."id"
        AND e."usageCountedAt" IS NOT NULL
      RETURNING e."teamId", e."domainId", e."campaignId", prev."usageCountedAt"
    ),
    grouped AS MATERIALIZED (
      SELECT
        "teamId",
        COALESCE("domainId", ${NO_DOMAIN_BUCKET}) AS "domainId",
        (CASE WHEN "campaignId" IS NULL THEN 'TRANSACTIONAL' ELSE 'MARKETING' END)::"EmailUsageType" AS "type",
        -- The row to correct is the one the increment landed on, which is the
        -- day it was accepted, not today. A send accepted at 23:59 and
        -- cancelled at 00:01 must not leave one day over and the next under.
        to_char("usageCountedAt", 'YYYY-MM-DD') AS "date"
      FROM reversed
    ),
    corrected AS (
      UPDATE "DailyEmailUsage" AS u
      SET "sent" = GREATEST(u."sent" - 1, 0),
          "updatedAt" = CURRENT_TIMESTAMP
      FROM grouped g
      WHERE u."teamId" = g."teamId"
        AND u."domainId" = g."domainId"
        AND u."date" = g."date"
        AND u."type" = g."type"
      RETURNING 1
    )
    SELECT COALESCE((SELECT COUNT(*) FROM grouped), 0)::integer AS "reversed"
  `);

  return (rows[0]?.reversed ?? 0) > 0;
}
