import { eq, sql } from "drizzle-orm";

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

export type NewSelfHostedUser = {
  email: string;
  name?: string | null;
  emailVerified?: boolean | null;
  image?: string | null;
};

/**
 * Creates a user on a self-hosted installation, enforcing the invitation rule
 * atomically.
 *
 * Callers must have already established that this is not cloud mode; there is
 * no `NEXT_PUBLIC_IS_CLOUD` short-circuit here, because a caller that reaches
 * this function on cloud would silently get self-hosted semantics.
 *
 * This is the whole gate. NextAuth also ran a cheaper advisory check in its
 * `signIn` callback, but that only ever blocked identities that were about to
 * become new users — an existing user, or an existing linked account, passed it
 * unconditionally. better-auth does not create a user for either of those, so
 * gating creation covers exactly the same set with one query path instead of
 * two that could disagree.
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

    // An empty installation always allows its bootstrap account.
    if (registeredUser) {
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
        name: user.name ?? "",
        email: user.email,
        emailVerified: user.emailVerified ?? false,
        image: user.image ?? null,
      })
      .returning();

    return created!;
  });
}
