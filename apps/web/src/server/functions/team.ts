import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { TeamService } from "~/server/service/team-service";
import {
  protectedMiddleware,
  teamAdminMiddleware,
  teamMiddleware,
} from "~/server/functions/middleware";

/**
 * `server/api/routers/team.ts`, as server functions (#9).
 *
 * The shape every ported area follows:
 *
 * - one module per area under `server/functions/`
 * - the procedure's middleware becomes `.middleware([...])`
 * - the procedure's `.input()` becomes `.validator()`
 * - `ctx.team` / `ctx.session.user` become `context.team` / `context.user`
 * - `{ method: "POST" }` for what used to be a mutation, so it is not
 *   cacheable and does not end up in a URL
 *
 * The handler bodies are unchanged: they were already one call into a service,
 * which is where the logic lives and stays.
 */

export const getTeams = createServerFn({ method: "GET" })
  .middleware([protectedMiddleware])
  .handler(({ context }) => TeamService.getUserTeams(context.user.id));

export const createTeam = createServerFn({ method: "POST" })
  .middleware([protectedMiddleware])
  .validator(z.object({ name: z.string() }))
  .handler(({ context, data }) =>
    TeamService.createTeam(context.user.id, data.name),
  );

export const getTeamUsers = createServerFn({ method: "GET" })
  .middleware([teamMiddleware])
  .handler(({ context }) => TeamService.getTeamUsers(context.team.id));

export const getTeamInvites = createServerFn({ method: "GET" })
  .middleware([teamMiddleware])
  .handler(({ context }) => TeamService.getTeamInvites(context.team.id));

export const createTeamInvite = createServerFn({ method: "POST" })
  .middleware([teamAdminMiddleware])
  .validator(
    z.object({
      email: z.string(),
      role: z.enum(["MEMBER", "ADMIN"]),
      sendEmail: z.boolean().default(true),
    }),
  )
  .handler(({ context, data }) =>
    TeamService.createTeamInvite(
      context.team.id,
      data.email,
      data.role,
      context.team.name,
      data.sendEmail,
    ),
  );

export const updateTeamUserRole = createServerFn({ method: "POST" })
  .middleware([teamAdminMiddleware])
  .validator(
    z.object({ userId: z.string(), role: z.enum(["MEMBER", "ADMIN"]) }),
  )
  .handler(({ context, data }) =>
    TeamService.updateTeamUserRole(context.team.id, data.userId, data.role),
  );

/**
 * Deliberately `teamMiddleware`, not `teamAdminMiddleware`: a MEMBER is
 * allowed to remove *themselves*, and `TeamService.deleteTeamUser` is what
 * decides that, from the role and the caller's own id. Tightening this to
 * admins would take away the only way to leave a team.
 */
export const deleteTeamUser = createServerFn({ method: "POST" })
  .middleware([teamMiddleware])
  .validator(z.object({ userId: z.string() }))
  .handler(({ context, data }) =>
    TeamService.deleteTeamUser(
      context.team.id,
      data.userId,
      context.teamUser.role,
      context.user.id,
    ),
  );

export const resendTeamInvite = createServerFn({ method: "POST" })
  .middleware([teamAdminMiddleware])
  .validator(z.object({ inviteId: z.string() }))
  .handler(({ context, data }) =>
    TeamService.resendTeamInvite(
      context.team.id,
      data.inviteId,
      context.team.name,
    ),
  );

export const deleteTeamInvite = createServerFn({ method: "POST" })
  .middleware([teamAdminMiddleware])
  .validator(z.object({ inviteId: z.string() }))
  .handler(({ context, data }) =>
    TeamService.deleteTeamInvite(context.team.id, data.inviteId),
  );
