import { badRequest, forbidden, notFound, unauthorized } from "~/server/app-error";
import { env } from "~/env";
import { publicEnv } from "~/env.public";
import { and, eq } from "drizzle-orm";
import { drizzleDb, schema } from "~/server/drizzle";
import { createId } from "~/server/drizzle/id";
import { withUpdatedAt } from "~/server/drizzle/touch";
import { sendMail, sendTeamInviteEmail } from "~/server/mailer";
import { logger } from "~/server/logger/log";
type Team = typeof schema.team.$inferSelect;
type TeamInvite = typeof schema.teamInvite.$inferSelect;
import { UnsendApiError } from "../public-api/api-error";
import { cacheAdd, cacheDelete, cacheGet, cachePut } from "~/server/cache";
import { LimitReason } from "~/lib/constants/plans";
import { LimitService } from "./limit-service";
import { renderUsageLimitReachedEmail } from "../email-templates/UsageLimitReachedEmail";
import { renderUsageWarningEmail } from "../email-templates/UsageWarningEmail";

// Cache stores exactly the Team row shape (no counts)

/**
 * Two minutes, and on Workers that is a floor rather than a ceiling.
 *
 * KV serves reads from a colo edge cache whose own TTL is also 60 seconds, so a
 * team row can be up to about three minutes stale rather than the two this
 * asks for. `invalidateTeamCache` narrows that but does not close it: a KV delete
 * is eventually consistent like everything else. Every reader of this cache is
 * a limit check or a plan lookup, where being a minute behind a plan change is
 * a billing question rather than a correctness one — and the hard limits
 * (`isBlocked`, the daily cap) are re-read from Postgres on the paths that
 * enforce them.
 */
const TEAM_CACHE_TTL_SECONDS = 120; // 2 minutes

/**
 * One limit notification per team per reason per day.
 *
 * `cacheAdd` is a read-then-write on KV rather than a conditional write, so
 * two callers racing inside KV's consistency window can both win and the team
 * gets two copies of the same email. That is the whole cost, it is
 * bounded by how often a team crosses a limit, and the alternative — a Durable
 * Object per team per reason — buys exactness nobody is asking for here. The
 * cases that genuinely cannot tolerate this are idempotency and rate limiting,
 * and neither of them is on KV.
 */
const NOTIFICATION_COOLDOWN_SECONDS = 24 * 60 * 60;

export class TeamService {
  private static cacheKey(teamId: number) {
    return `team:${teamId}`;
  }

  static async refreshTeamCache(teamId: number): Promise<Team | null> {
    const [team] = await drizzleDb
      .select()
      .from(schema.team)
      .where(eq(schema.team.id, teamId))
      .limit(1);

    if (!team) return null;

    await cachePut(TeamService.cacheKey(teamId), JSON.stringify(team), {
      ttlSeconds: TEAM_CACHE_TTL_SECONDS,
    });
    return team;
  }

  static async invalidateTeamCache(teamId: number) {
    await cacheDelete(TeamService.cacheKey(teamId));
  }

  static async getTeamCached(teamId: number): Promise<Team> {
    const raw = await cacheGet(TeamService.cacheKey(teamId));
    if (raw) {
      return JSON.parse(raw) as Team;
    }
    const fresh = await TeamService.refreshTeamCache(teamId);
    if (!fresh) {
      throw notFound("Team not found");
    }
    return fresh;
  }

  static async createTeam(
    userId: number,
    name: string,
  ): Promise<Team | undefined> {
    // Prisma's `teamUsers: { some: ... }` relation filter becomes a join.
    const teams = await drizzleDb
      .select({ id: schema.team.id })
      .from(schema.team)
      .innerJoin(schema.teamUser, eq(schema.teamUser.teamId, schema.team.id))
      .where(eq(schema.teamUser.userId, userId));

    if (teams.length > 0) {
      logger.info({ userId }, "User already has a team");
      return;
    }

    if (!publicEnv.NEXT_PUBLIC_IS_CLOUD) {
      const [_team] = await drizzleDb.select().from(schema.team).limit(1);
      if (_team) {
        throw unauthorized("Can't have multiple teams in self hosted version");
      }
    }

    // Prisma wrote the team and its owning TeamUser as one nested create.
    // Drizzle has no nested writes, so the two inserts need a transaction to
    // keep a team from ever existing without an admin.
    const created = await drizzleDb.transaction(async (tx) => {
      const [team] = await tx
        .insert(schema.team)
        .values(withUpdatedAt({ name }))
        .returning();

      if (!team) {
        throw new Error("Failed to create team");
      }

      await tx
        .insert(schema.teamUser)
        .values({ teamId: team.id, userId, role: "ADMIN" });

      return team;
    });
    // Warm cache for the new team
    await TeamService.refreshTeamCache(created.id);
    return created;
  }

  /**
   * Update a team and refresh the cache.
   * Returns the full Prisma Team object.
   */
  static async updateTeam(
    teamId: number,
    data: Partial<typeof schema.team.$inferInsert>,
  ): Promise<Team> {
    const [updated] = await drizzleDb
      .update(schema.team)
      .set(withUpdatedAt(data))
      .where(eq(schema.team.id, teamId))
      .returning();

    if (!updated) {
      throw notFound("Team not found");
    }

    await TeamService.refreshTeamCache(teamId);
    return updated;
  }

  static async getUserTeams(userId: number) {
    // Prisma returned each team with its (filtered) teamUsers nested. The join
    // gives one row per pair, which is reshaped back into that form.
    const rows = await drizzleDb
      .select({ team: schema.team, teamUser: schema.teamUser })
      .from(schema.team)
      .innerJoin(schema.teamUser, eq(schema.teamUser.teamId, schema.team.id))
      .where(eq(schema.teamUser.userId, userId));

    return rows.map(({ team, teamUser }) => ({
      ...team,
      teamUsers: [teamUser],
    }));
  }

  static async getTeamUsers(teamId: number) {
    const rows = await drizzleDb
      .select({ teamUser: schema.teamUser, user: schema.user })
      .from(schema.teamUser)
      .innerJoin(schema.user, eq(schema.user.id, schema.teamUser.userId))
      .where(eq(schema.teamUser.teamId, teamId));

    return rows.map(({ teamUser, user }) => ({ ...teamUser, user }));
  }

  static async getTeamInvites(teamId: number) {
    return drizzleDb
      .select()
      .from(schema.teamInvite)
      .where(eq(schema.teamInvite.teamId, teamId));
  }

  static async createTeamInvite(
    teamId: number,
    email: string,
    role: "MEMBER" | "ADMIN",
    teamName: string,
    sendEmail: boolean = true,
  ): Promise<TeamInvite> {
    if (!email) {
      throw badRequest("Email is required");
    }

    const { isLimitReached } = await LimitService.checkTeamMemberLimit(teamId);
    if (isLimitReached) {
      throw new UnsendApiError({
        code: "FORBIDDEN",
        message: "Team invite limit reached",
      });
    }

    const userRows = await drizzleDb
      .select({ userId: schema.user.id, teamUserId: schema.teamUser.userId })
      .from(schema.user)
      .leftJoin(schema.teamUser, eq(schema.teamUser.userId, schema.user.id))
      .where(eq(schema.user.email, email));

    const user = userRows[0];
    const userTeamCount = userRows.filter(
      (row) => row.teamUserId !== null,
    ).length;

    if (user && userTeamCount > 0) {
      throw badRequest("User already part of a team");
    }

    const [teamInvite] = await drizzleDb
      .insert(schema.teamInvite)
      .values(withUpdatedAt({ id: createId(), teamId, email, role }))
      .returning();

    if (!teamInvite) {
      throw new Error("Failed to create invite");
    }

    const teamUrl = `${env.APP_URL}/join-team?inviteId=${teamInvite.id}`;

    if (sendEmail) {
      await sendTeamInviteEmail(email, teamUrl, teamName);
    }

    return teamInvite;
  }

  static async updateTeamUserRole(
    teamId: number,
    userId: string,
    role: "MEMBER" | "ADMIN",
  ) {
    const [teamUser] = await drizzleDb
      .select()
      .from(schema.teamUser)
      .where(
        and(
          eq(schema.teamUser.teamId, teamId),
          eq(schema.teamUser.userId, Number(userId)),
        ),
      )
      .limit(1);

    if (!teamUser) {
      throw notFound("Team member not found");
    }

    // Check if this is the last admin
    const adminCount = await drizzleDb.$count(
      schema.teamUser,
      and(
        eq(schema.teamUser.teamId, teamId),
        eq(schema.teamUser.role, "ADMIN"),
      ),
    );

    if (adminCount === 1 && teamUser.role === "ADMIN") {
      throw forbidden("Need at least one admin");
    }

    const [updated] = await drizzleDb
      .update(schema.teamUser)
      .set({ role })
      .where(
        and(
          eq(schema.teamUser.teamId, teamId),
          eq(schema.teamUser.userId, Number(userId)),
        ),
      )
      .returning();

    if (!updated) {
      throw notFound("Team member not found");
    }
    // Role updates might influence permissions; refresh cache to be safe
    await TeamService.invalidateTeamCache(teamId);
    return updated;
  }

  static async deleteTeamUser(
    teamId: number,
    userId: string,
    requestorRole: string,
    requestorId: number,
  ) {
    const [teamUser] = await drizzleDb
      .select()
      .from(schema.teamUser)
      .where(
        and(
          eq(schema.teamUser.teamId, teamId),
          eq(schema.teamUser.userId, Number(userId)),
        ),
      )
      .limit(1);

    if (!teamUser) {
      throw notFound("Team member not found");
    }

    if (requestorRole !== "ADMIN" && requestorId !== Number(userId)) {
      throw unauthorized("You are not authorized to delete this team member");
    }

    // Check if this is the last admin
    const adminCount = await drizzleDb.$count(
      schema.teamUser,
      and(
        eq(schema.teamUser.teamId, teamId),
        eq(schema.teamUser.role, "ADMIN"),
      ),
    );

    if (adminCount === 1 && teamUser.role === "ADMIN") {
      throw forbidden("Need at least one admin");
    }

    const [deleted] = await drizzleDb
      .delete(schema.teamUser)
      .where(
        and(
          eq(schema.teamUser.teamId, teamId),
          eq(schema.teamUser.userId, Number(userId)),
        ),
      )
      .returning();

    if (!deleted) {
      throw notFound("Team member not found");
    }
    await TeamService.invalidateTeamCache(teamId);
    return deleted;
  }

  static async resendTeamInvite(
    teamId: number,
    inviteId: string,
    teamName: string,
  ) {
    const [invite] = await drizzleDb
      .select()
      .from(schema.teamInvite)
      .where(
        and(
          eq(schema.teamInvite.teamId, teamId),
          eq(schema.teamInvite.id, inviteId),
        ),
      )
      .limit(1);

    if (!invite) {
      throw notFound("Invite not found");
    }

    const teamUrl = `${env.APP_URL}/join-team?inviteId=${invite.id}`;

    await sendTeamInviteEmail(invite.email, teamUrl, teamName);

    return { success: true };
  }

  static async deleteTeamInvite(teamId: number, inviteId: string) {
    const [invite] = await drizzleDb
      .select()
      .from(schema.teamInvite)
      .where(
        and(
          eq(schema.teamInvite.teamId, teamId),
          eq(schema.teamInvite.id, inviteId),
        ),
      )
      .limit(1);

    if (!invite) {
      throw notFound("Invite not found");
    }

    const [deleted] = await drizzleDb
      .delete(schema.teamInvite)
      .where(
        and(
          eq(schema.teamInvite.teamId, teamId),
          eq(schema.teamInvite.email, invite.email),
        ),
      )
      .returning();

    if (!deleted) {
      throw notFound("Invite not found");
    }

    return deleted;
  }

  /**
   * Notify all team users that email limit has been reached, at most once per day.
   */
  static async maybeNotifyEmailLimitReached(
    teamId: number,
    limit: number,
    reason: LimitReason | undefined,
  ) {
    logger.info(
      { teamId, limit, reason },
      "[TeamService]: maybeNotifyEmailLimitReached called",
    );
    if (!reason) {
      logger.info(
        { teamId },
        "[TeamService]: Skipping notify — no reason provided",
      );
      return;
    }
    // Only notify on actual email limit reasons
    if (
      ![
        LimitReason.EMAIL_DAILY_LIMIT_REACHED,
        LimitReason.EMAIL_FREE_PLAN_MONTHLY_LIMIT_REACHED,
      ].includes(reason)
    ) {
      logger.info(
        { teamId, reason },
        "[TeamService]: Skipping notify — reason not eligible",
      );
      return;
    }

    const cacheKey = `limit:notify:${teamId}:${reason}`;
    const acquired = await cacheAdd(cacheKey, "1", {
      ttlSeconds: NOTIFICATION_COOLDOWN_SECONDS,
    });
    if (!acquired) {
      logger.info(
        { teamId, cacheKey },
        "[TeamService]: Skipping notify — cooldown active",
      );
      return; // another request already claimed this window
    }

    const team = await TeamService.getTeamCached(teamId);
    // Only consider it a paid plan if the subscription is active
    const isPaidPlan = team.isActive && team.plan !== "FREE";

    const html = await getLimitReachedEmail(teamId, limit, reason);

    const subject =
      reason === LimitReason.EMAIL_FREE_PLAN_MONTHLY_LIMIT_REACHED
        ? "useSend: You've reached your monthly email limit"
        : "useSend: You've reached your daily email limit";

    const text = `Hi ${team.name} team,\n\nYou've reached your ${
      reason === LimitReason.EMAIL_FREE_PLAN_MONTHLY_LIMIT_REACHED
        ? "monthly"
        : "daily"
    } limit of ${limit.toLocaleString()} emails.\n\nSending is temporarily paused until your limit resets or ${
      isPaidPlan ? "your team is verified" : "your plan is upgraded"
    }.\n\nManage plan: ${env.APP_URL}/settings`;

    const teamUsers = await TeamService.getTeamUsers(teamId);
    const recipients = teamUsers
      .map((tu) => tu.user?.email)
      .filter((e): e is string => Boolean(e));

    logger.info(
      { teamId, recipientsCount: recipients.length, reason },
      "[TeamService]: Sending limit reached notifications",
    );

    // Send individually to all team users
    try {
      await Promise.all(
        recipients.map((to) =>
          sendMail(to, subject, text, html, "hey@usesend.com"),
        ),
      );
      logger.info(
        { teamId, recipientsCount: recipients.length },
        "[TeamService]: Limit reached notifications sent",
      );
    } catch (err) {
      logger.error(
        { err, teamId },
        "[TeamService]: Failed sending limit reached notifications",
      );
      throw err;
    }
  }

  /**
   * Notify all team users that they're nearing their email limit.
   * Cooled down to avoid spamming; sends at most once per day per reason.
   */
  static async sendWarningEmail(
    teamId: number,
    used: number,
    limit: number,
    reason: LimitReason | undefined,
  ) {
    logger.info(
      { teamId, used, limit, reason },
      "[TeamService]: sendWarningEmail called",
    );
    if (!reason) {
      logger.info(
        { teamId },
        "[TeamService]: Skipping warning — no reason provided",
      );
      return;
    }

    if (
      ![
        LimitReason.EMAIL_DAILY_LIMIT_REACHED,
        LimitReason.EMAIL_FREE_PLAN_MONTHLY_LIMIT_REACHED,
      ].includes(reason)
    ) {
      logger.info(
        { teamId, reason },
        "[TeamService]: Skipping warning — reason not eligible",
      );
      return;
    }

    const cacheKey = `limit:warning:${teamId}:${reason}`;
    const acquired = await cacheAdd(cacheKey, "1", {
      ttlSeconds: NOTIFICATION_COOLDOWN_SECONDS,
    });
    if (!acquired) {
      logger.info(
        { teamId, cacheKey },
        "[TeamService]: Skipping warning — cooldown active",
      );
      return; // another request already claimed this window
    }

    const team = await TeamService.getTeamCached(teamId);
    // Only consider it a paid plan if the subscription is active
    const isPaidPlan = team.isActive && team.plan !== "FREE";

    const period =
      reason === LimitReason.EMAIL_FREE_PLAN_MONTHLY_LIMIT_REACHED
        ? "monthly"
        : "daily";

    const html = await renderUsageWarningEmail({
      teamName: team.name,
      used,
      limit,
      isPaidPlan,
      period,
      manageUrl: `${env.APP_URL}/settings`,
    });

    const subject =
      period === "monthly"
        ? "useSend: You're nearing your monthly email limit"
        : "useSend: You're nearing your daily email limit";

    const text = `Hi ${team.name} team,\n\nYou've used ${used.toLocaleString()} of your ${period} limit of ${limit.toLocaleString()} emails.\n\nConsider ${
      isPaidPlan
        ? "verifying your team by replying to this email"
        : "upgrading your plan"
    }.\n\nManage plan: ${env.APP_URL}/settings`;

    const teamUsers = await TeamService.getTeamUsers(teamId);
    const recipients = teamUsers
      .map((tu) => tu.user?.email)
      .filter((e): e is string => Boolean(e));

    logger.info(
      { teamId, recipientsCount: recipients.length, reason },
      "[TeamService]: Sending warning notifications",
    );

    try {
      await Promise.all(
        recipients.map((to) =>
          sendMail(to, subject, text, html, "hey@usesend.com"),
        ),
      );
      logger.info(
        { teamId, recipientsCount: recipients.length },
        "[TeamService]: Warning notifications sent",
      );
    } catch (err) {
      logger.error(
        { err, teamId },
        "[TeamService]: Failed sending warning notifications",
      );
      throw err;
    }
  }
}

async function getLimitReachedEmail(
  teamId: number,
  limit: number,
  reason: LimitReason,
) {
  const team = await TeamService.getTeamCached(teamId);
  const isPaidPlan = team.isActive && team.plan !== "FREE";
  const email = await renderUsageLimitReachedEmail({
    teamName: team.name,
    limit,
    isPaidPlan,
    period:
      reason === LimitReason.EMAIL_FREE_PLAN_MONTHLY_LIMIT_REACHED
        ? "monthly"
        : "daily",
    manageUrl: `${env.APP_URL}/settings`,
  });
  return email;
}
