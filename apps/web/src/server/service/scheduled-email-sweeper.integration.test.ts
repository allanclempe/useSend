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

const { mockQueueBulk } = vi.hoisted(() => ({ mockQueueBulk: vi.fn() }));

// The queue is the edge; the query is what is under test, so it runs against
// the real database and only the enqueue is faked.
vi.mock("~/server/service/email-queue-service", () => ({
  EmailQueueService: { queueBulk: mockQueueBulk },
}));

import { sweepDueScheduledEmails } from "~/server/service/scheduled-email-sweeper";

const describeIntegration = integrationEnabled ? describe : describe.skip;

/**
 * §4.5 replaced a delayed queue message with a row and a sweep, which makes the
 * whole of reschedule and cancel a `WHERE` clause. These are the cases the plan
 * named: reschedule earlier, reschedule later, and cancel.
 */
describeIntegration("scheduled email sweeper", () => {
  let teamId: number;
  let domainId: number;

  beforeEach(async () => {
    await resetDatabase();
    vi.clearAllMocks();

    const team = await createTeam({ name: "sweep-team" });
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

  async function scheduleEmail(scheduledAt: Date, overrides = {}) {
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
          scheduledAt,
          latestStatus: "SCHEDULED" as const,
          ...overrides,
        }),
      )
      .returning();

    return email!;
  }

  function sweptIds() {
    return (mockQueueBulk.mock.calls[0]?.[0] ?? []).map(
      (job: { emailId: string }) => job.emailId,
    );
  }

  it("enqueues an email whose time has come", async () => {
    const email = await scheduleEmail(new Date(Date.now() - 1_000));

    expect(await sweepDueScheduledEmails()).toBe(1);
    expect(sweptIds()).toEqual([email.id]);
    expect(mockQueueBulk.mock.calls[0]?.[0][0]).toMatchObject({
      region: "us-east-1",
      teamId,
      transactional: true,
    });
  });

  it("leaves an email that is not due yet", async () => {
    await scheduleEmail(new Date(Date.now() + 60_000));

    expect(await sweepDueScheduledEmails()).toBe(0);
    expect(mockQueueBulk).not.toHaveBeenCalled();
  });

  it("picks up an email rescheduled earlier, on the next tick", async () => {
    const email = await scheduleEmail(new Date(Date.now() + 60_000));
    expect(await sweepDueScheduledEmails()).toBe(0);

    await drizzleDb
      .update(schema.email)
      .set(withUpdatedAt({ scheduledAt: new Date(Date.now() - 1_000) }))
      .where(eq(schema.email.id, email.id));

    expect(await sweepDueScheduledEmails()).toBe(1);
    expect(sweptIds()).toEqual([email.id]);
  });

  it("drops an email rescheduled later back out of the sweep", async () => {
    const email = await scheduleEmail(new Date(Date.now() - 1_000));

    await drizzleDb
      .update(schema.email)
      .set(withUpdatedAt({ scheduledAt: new Date(Date.now() + 60_000) }))
      .where(eq(schema.email.id, email.id));

    expect(await sweepDueScheduledEmails()).toBe(0);
  });

  it("never sweeps a cancelled email", async () => {
    const email = await scheduleEmail(new Date(Date.now() - 1_000));

    await drizzleDb
      .update(schema.email)
      .set(withUpdatedAt({ latestStatus: "CANCELLED" as const }))
      .where(eq(schema.email.id, email.id));

    expect(await sweepDueScheduledEmails()).toBe(0);
  });

  it("takes the most overdue first, up to its limit", async () => {
    const older = await scheduleEmail(new Date(Date.now() - 60_000));
    await scheduleEmail(new Date(Date.now() - 1_000));

    expect(await sweepDueScheduledEmails(1)).toBe(1);
    expect(sweptIds()).toEqual([older.id]);
  });
});
