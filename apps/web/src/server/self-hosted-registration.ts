import { and, eq, sql } from "drizzle-orm";

import { env } from "~/env";
import { drizzleDb, schema } from "~/server/drizzle";

/**
 * PostgreSQL advisory-lock namespace for self-hosted user creation.
 *
 * The lock serializes only transactions that request this same key; it does not
 * lock the User table or any rows. Because pg_advisory_xact_lock is scoped to
 * the current transaction, PostgreSQL releases it automatically on commit,
 * rollback, or connection loss. A concurrent registration may wait briefly for
 * the active registration transaction to finish.
 */
const SELF_HOSTED_REGISTRATION_LOCK_ID = 1431520590;

export class SelfHostedRegistrationError extends Error {
  constructor() {
    super("A team invitation is required to create an account");
    this.name = "SelfHostedRegistrationError";
  }
}

/**
 * The parts of a provider account the gate needs. Narrower than NextAuth's
 * `Account` on purpose: this module is the half of `auth.ts` that outlives
 * NextAuth (issue #8), so it must not depend on NextAuth's types.
 */
export type RegistrationAccount = {
  provider: string;
  providerAccountId: string;
  type: string;
};

export type NewSelfHostedUser = {
  name?: string | null;
  email?: string | null;
  emailVerified?: Date | null;
  image?: string | null;
};

/**
 * Cheap pre-check: may this identity register on a self-hosted installation?
 *
 * Advisory only. It reads outside any transaction, so a `true` here can be
 * stale by the time the row is written — {@link createSelfHostedUser} re-checks
 * under the advisory lock and is the actual gate.
 */
export async function canRegisterSelfHostedUser(
  email?: string | null,
  account?: RegistrationAccount | null,
) {
  if (env.NEXT_PUBLIC_IS_CLOUD) {
    return true;
  }

  if (account?.type === "oauth") {
    const [existingAccount] = await drizzleDb
      .select({ id: schema.account.id })
      .from(schema.account)
      .where(
        and(
          eq(schema.account.provider, account.provider),
          eq(schema.account.providerAccountId, account.providerAccountId),
        ),
      )
      .limit(1);

    if (existingAccount) {
      return true;
    }
  }

  if (email) {
    const [existingUser] = await drizzleDb
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, email))
      .limit(1);

    if (existingUser) {
      return true;
    }
  }

  const [registeredUser] = await drizzleDb
    .select({ id: schema.user.id })
    .from(schema.user)
    .limit(1);

  // An empty installation always allows its bootstrap account.
  if (!registeredUser) {
    return true;
  }

  if (!email) {
    return false;
  }

  const [invite] = await drizzleDb
    .select({ id: schema.teamInvite.id })
    .from(schema.teamInvite)
    .where(eq(schema.teamInvite.email, email))
    .limit(1);

  return Boolean(invite);
}

/**
 * Creates a user on a self-hosted installation, enforcing the invitation rule
 * atomically.
 *
 * Callers must have already established that this is not cloud mode; there is
 * no `NEXT_PUBLIC_IS_CLOUD` short-circuit here, because a caller that reaches
 * this function on cloud would silently get self-hosted semantics.
 *
 * @throws {SelfHostedRegistrationError} when the installation already has a
 * user and this email has no matching invitation.
 */
export async function createSelfHostedUser(user: NewSelfHostedUser) {
  return drizzleDb.transaction(async (tx) => {
    // Acquire the lock before checking for the first user. Without this,
    // two concurrent callbacks could both observe an empty User table and
    // both create an account without an invitation.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${SELF_HOSTED_REGISTRATION_LOCK_ID})`,
    );

    const [registeredUser] = await tx
      .select({ id: schema.user.id })
      .from(schema.user)
      .limit(1);

    if (registeredUser) {
      if (!user.email) {
        throw new SelfHostedRegistrationError();
      }

      const [invite] = await tx
        .select({ id: schema.teamInvite.id })
        .from(schema.teamInvite)
        .where(eq(schema.teamInvite.email, user.email))
        .limit(1);

      if (!invite) {
        throw new SelfHostedRegistrationError();
      }
    }

    const [created] = await tx
      .insert(schema.user)
      .values({
        name: user.name ?? null,
        email: user.email ?? null,
        emailVerified: user.emailVerified ?? null,
        image: user.image ?? null,
      })
      .returning();

    return created!;
  });
}
