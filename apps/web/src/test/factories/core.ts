import { Role } from "@prisma/client";
import { drizzleDb, schema } from "~/server/drizzle";
import { withUpdatedAt } from "~/server/drizzle/touch";

type UserInsert = typeof schema.user.$inferInsert;
type TeamInsert = typeof schema.team.$inferInsert;

let sequence = 1;

function nextValue() {
  const value = sequence;
  sequence += 1;
  return value;
}

export async function createUser(data?: Partial<UserInsert>) {
  const n = nextValue();
  const [user] = await drizzleDb
    .insert(schema.user)
    .values(
      withUpdatedAt({
        name: `User ${n}`,
        email: `user-${n}@example.com`,
        isBetaUser: true,
        isWaitlisted: false,
        ...data,
      }),
    )
    .returning();

  return user!;
}

export async function createTeam(data?: Partial<TeamInsert>) {
  const n = nextValue();
  const [team] = await drizzleDb
    .insert(schema.team)
    .values(
      withUpdatedAt({
        name: `Team ${n}`,
        ...data,
      }),
    )
    .returning();

  return team!;
}

export async function attachUserToTeam(
  userId: number,
  teamId: number,
  role: Role = Role.ADMIN,
) {
  const [teamUser] = await drizzleDb
    .insert(schema.teamUser)
    .values(withUpdatedAt({ userId, teamId, role }))
    .returning();

  return teamUser!;
}

export async function createTeamWithUser(role: Role = Role.ADMIN) {
  const user = await createUser();
  const team = await createTeam();
  const teamUser = await attachUserToTeam(user.id, team.id, role);

  return { user, team, teamUser };
}
