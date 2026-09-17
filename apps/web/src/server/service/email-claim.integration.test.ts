import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzleDb, schema } from "~/server/drizzle";
import { createId } from "~/server/drizzle/id";
import { withUpdatedAt } from "~/server/drizzle/touch";
import { createTeam } from "~/test/factories/core";
import {
  closeIntegrationConnections,
  integrationEnabled,
  resetDatabase,
} from "~/test/integration/helpers";
// `email-queue-service` reaches `mailer`, which pulls the SDK workspace package
// into the module graph for no reason this test cares about. Every other
// integration test that touches a send path stubs it the same way.
vi.mock("~/server/mailer", () => ({
  sendMail: vi.fn(),
  sendTeamInviteEmail: vi.fn(),
  sendSignUpEmail: vi.fn(),
}));

import { claimEmailForSending } from "~/server/service/email-queue-service";

const describeIntegration = integrationEnabled ? describe : describe.skip;

/**
 * The claim-UPDATE from §4.4. Its own file rather than sharing the sweeper's,
 * because the sweeper's tests mock `email-queue-service` outright and this is
 * the real thing.
 */
describeIntegration("claimEmailForSending", () => {
  let teamId: number;
  let domainId: number;

  beforeEach(async () => {
    await resetDatabase();
    const team = await createTeam({ name: "claim-team" });
    teamId = team.id;

    const [domain] = await drizzleDb
      .insert(schema.domain)
      .values(
        withUpdatedAt({
          name: "example.com",
          teamId,
          publicKey: "pk",
          region: "us-east-1",
          dkimSelector: "usesend",
        }),
      )
      .returning();
    domainId = domain!.id;
  });

  afterAll(async () => {
    await closeIntegrationConnections();
  });

  async function makeEmail(latestStatus: "SCHEDULED" | "CANCELLED" | "SENT") {
    const [email] = await drizzleDb
      .insert(schema.email)
      .values(
        withUpdatedAt({
          id: createId(),
          to: ["to@example.com"],
          from: "from@example.com",
          subject: "hi",
          text: "hi",
          teamId,
          domainId,
          latestStatus,
        }),
      )
      .returning();

    return email!;
  }

  it("claims a scheduled email exactly once", async () => {
    const email = await makeEmail("SCHEDULED");

    expect(await claimEmailForSending(email.id)).toBe(true);
    // The second delivery of the same message. This is the case Cloudflare's
    // at-least-once guarantee makes routine (§4.4).
    expect(await claimEmailForSending(email.id)).toBe(false);

    const [stored] = await drizzleDb
      .select({ latestStatus: schema.email.latestStatus })
      .from(schema.email)
      .where(eq(schema.email.id, email.id))
      .limit(1);
    expect(stored?.latestStatus).toBe("QUEUED");
  });

  it("gives the claim to exactly one of two concurrent deliveries", async () => {
    const email = await makeEmail("SCHEDULED");

    const results = await Promise.all([
      claimEmailForSending(email.id),
      claimEmailForSending(email.id),
      claimEmailForSending(email.id),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("refuses a cancelled email", async () => {
    const email = await makeEmail("CANCELLED");

    expect(await claimEmailForSending(email.id)).toBe(false);
  });

  it("refuses an email that has already been sent", async () => {
    const email = await makeEmail("SENT");

    expect(await claimEmailForSending(email.id)).toBe(false);
  });

  it("refuses an email that does not exist", async () => {
    expect(await claimEmailForSending("does-not-exist")).toBe(false);
  });
});
