import { and, eq } from "drizzle-orm";

import { publicEnv } from "~/env.public";
import { notFound, unauthorized } from "~/server/app-error";
import { getServerAuthSession } from "~/server/auth";
import { isAdminEmail } from "~/server/better-auth";
import { drizzleDb, schema } from "~/server/drizzle";

/**
 * Who is allowed to do what, with no framework in it.
 *
 * This is the dashboard's authorisation boundary, ported from the procedure
 * ladder in `server/api/trpc.ts` (#9). It is a plain module on purpose:
 * `server/functions/middleware.ts` is a thin TanStack Start adapter over it,
 * and keeping the rules out of the adapter means they can be read, tested and
 * reasoned about without instantiating a request.
 *
 * The ladder, in the order it tightens:
 *
 * | tRPC procedure | here |
 * |---|---|
 * | `publicProcedure` | no call at all |
 * | `authedProcedure` | `requireUser` |
 * | `protectedProcedure` | `requireActiveUser` |
 * | `teamProcedure` | `requireTeam` |
 * | `teamAdminProcedure` | `requireTeamAdmin` |
 * | `adminProcedure` | `requireInstanceAdmin` |
 *
 * plus the six resource loaders, which are the part that actually stops one
 * team reading another's rows: every one of them filters on `teamId` as well
 * as the id the caller supplied. A handler that takes `teamId` from its own
 * input instead of from here has reintroduced the bug they exist to prevent.
 */

export type AppSessionUser = NonNullable<
  Awaited<ReturnType<typeof getServerAuthSession>>
>["user"];

/** A signed-in user, waitlisted or not. `authedProcedure`. */
export async function requireUser(headers: Headers): Promise<AppSessionUser> {
  const session = await getServerAuthSession(headers);

  if (!session?.user) {
    throw unauthorized();
  }

  return session.user;
}

/**
 * A signed-in user who is past the waitlist. `protectedProcedure`.
 *
 * Waitlisted users get `UNAUTHORIZED` rather than `FORBIDDEN`, which is what
 * tRPC returned. It is arguably the wrong code — they are authenticated and
 * merely not allowed — but the dashboard renders the waitlist screen from the
 * session rather than from this, so the code is only ever read by a log.
 */
export async function requireActiveUser(
  headers: Headers,
): Promise<AppSessionUser> {
  const user = await requireUser(headers);

  if (user.isWaitlisted) {
    throw unauthorized();
  }

  return user;
}

export type TeamContext = {
  user: AppSessionUser;
  team: typeof schema.team.$inferSelect;
  teamUser: typeof schema.teamUser.$inferSelect;
};

/**
 * The caller's team. `teamProcedure`.
 *
 * `findFirst` with no ordering, exactly as before: a user belongs to one team
 * in practice, and the dashboard's team switcher picks `teams[0]`. This is
 * where a real multi-team product would take the team from the request.
 */
export async function requireTeam(headers: Headers): Promise<TeamContext> {
  const user = await requireActiveUser(headers);

  const teamUser = await drizzleDb.query.teamUser.findFirst({
    where: eq(schema.teamUser.userId, user.id),
    with: { team: true },
  });

  if (!teamUser) {
    throw notFound("Team not found");
  }

  const { team, ...rest } = teamUser as typeof teamUser & {
    team: TeamContext["team"];
  };

  return { user, team, teamUser: rest as TeamContext["teamUser"] };
}

/** An `ADMIN` of the caller's team. `teamAdminProcedure`. */
export async function requireTeamAdmin(headers: Headers): Promise<TeamContext> {
  const context = await requireTeam(headers);

  if (context.teamUser.role !== "ADMIN") {
    throw unauthorized("You are not authorized to perform this action");
  }

  return context;
}

/**
 * The person who runs this installation. `adminProcedure`.
 *
 * On a self-hosted install every signed-in user is the admin, because they
 * installed it. On cloud it is the one address in `ADMIN_EMAIL`, which is what
 * `user.isAdmin` already means.
 *
 * Split into a predicate and a guard so the `/admin` route gate can ask the
 * question without throwing. Two copies of "or self-hosted" is how a UI ends up
 * offering a page the server refuses, or hiding one it would have allowed.
 *
 * The comparison is `isAdminEmail`, not `user.email === env.ADMIN_EMAIL`. A
 * bare equality check is true when *both* sides are undefined, so a cloud
 * install that had never set `ADMIN_EMAIL` handed instance admin to any user
 * whose session carried no email. `isAdminEmail` requires both to be
 * non-empty, and already existed for exactly this reason -- it was just not
 * what this function called.
 */
export function isInstanceAdmin(user: AppSessionUser) {
  return !publicEnv.NEXT_PUBLIC_IS_CLOUD || isAdminEmail(user.email);
}

export async function requireInstanceAdmin(
  headers: Headers,
): Promise<AppSessionUser> {
  const user = await requireActiveUser(headers);

  if (!isInstanceAdmin(user)) {
    throw unauthorized();
  }

  return user;
}

/**
 * The six resource loaders.
 *
 * Each one is the `and(eq(id), eq(teamId))` that keeps one team out of
 * another's rows, and each one turns a miss into `NOT_FOUND` rather than
 * `FORBIDDEN` — a caller who may not see a row should not learn that it
 * exists.
 */

export async function requireDomain(teamId: number, id: number) {
  const [domain] = await drizzleDb
    .select()
    .from(schema.domain)
    .where(and(eq(schema.domain.id, id), eq(schema.domain.teamId, teamId)))
    .limit(1);

  if (!domain) {
    throw notFound("Domain not found");
  }

  return domain;
}

export async function requireEmail(teamId: number, id: string) {
  const [email] = await drizzleDb
    .select()
    .from(schema.email)
    .where(and(eq(schema.email.id, id), eq(schema.email.teamId, teamId)))
    .limit(1);

  if (!email) {
    throw notFound("Email not found");
  }

  return email;
}

export async function requireApiKey(teamId: number, id: number) {
  const [apiKey] = await drizzleDb
    .select()
    .from(schema.apiKey)
    .where(and(eq(schema.apiKey.id, id), eq(schema.apiKey.teamId, teamId)))
    .limit(1);

  if (!apiKey) {
    throw notFound("API key not found");
  }

  return apiKey;
}

export async function requireContactBook(
  teamId: number,
  contactBookId: string,
) {
  const [contactBook] = await drizzleDb
    .select()
    .from(schema.contactBook)
    .where(
      and(
        eq(schema.contactBook.id, contactBookId),
        eq(schema.contactBook.teamId, teamId),
      ),
    )
    .limit(1);

  if (!contactBook) {
    throw notFound("Contact book not found");
  }

  return contactBook;
}

export async function requireCampaign(teamId: number, campaignId: string) {
  const [campaign] = await drizzleDb
    .select()
    .from(schema.campaign)
    .where(
      and(
        eq(schema.campaign.id, campaignId),
        eq(schema.campaign.teamId, teamId),
      ),
    )
    .limit(1);

  if (!campaign) {
    throw notFound("Campaign not found");
  }

  return campaign;
}

export async function requireTemplate(teamId: number, templateId: string) {
  const [template] = await drizzleDb
    .select()
    .from(schema.template)
    .where(
      and(
        eq(schema.template.id, templateId),
        eq(schema.template.teamId, teamId),
      ),
    )
    .limit(1);

  if (!template) {
    throw notFound("Template not found");
  }

  return template;
}
