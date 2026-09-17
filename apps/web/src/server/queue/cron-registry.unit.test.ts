import { describe, expect, it } from "vitest";

import { readWranglerConfig } from "~/test/wrangler-config";
import {
  CRON_EXPRESSIONS,
  CRON_TRIGGERS,
  cronJobFor,
  isDeclaredCron,
  SCHEDULER_KEEPALIVE_CRON,
} from "./cron-registry";
import {
  CRON_CONTINUED_QUEUES,
  CRON_ONLY_QUEUES,
  QUEUES,
} from "./queue-registry";

/**
 * A Cron Trigger that is declared in one place and not the other fails
 * silently: the job simply stops running, and nothing says so. That is a worse
 * failure than a missing queue binding, which at least throws.
 */

const config = readWranglerConfig();

describe("cron registry", () => {
  it("maps a firing cron expression back to its job", () => {
    expect(cronJobFor("0 * * * *")).toBe("domain-verification");
    expect(cronJobFor("30 0 * * *")).toBe("email-event-cleanup");
    expect(cronJobFor("*/5 * * * *")).toBeUndefined();
  });

  it("gives every job a distinct expression", () => {
    // `scheduled()` is handed the expression and nothing else, so two jobs on
    // the same cron would be indistinguishable. The keepalive is the one
    // trigger that runs no job, hence the +1.
    expect(CRON_EXPRESSIONS.length).toBe(
      Object.keys(CRON_TRIGGERS).length + 1,
    );
    expect(CRON_EXPRESSIONS).toContain(SCHEDULER_KEEPALIVE_CRON);
    expect(cronJobFor(SCHEDULER_KEEPALIVE_CRON)).toBeUndefined();
  });

  it("separates schedule-only jobs from ones a queue continues", () => {
    // Most cron jobs carry a schedule and never a message, so they have no
    // queue at all. The exceptions are listed, not inferred: a cron starts the
    // work and a queue carries the rest of its pages (§4.3).
    expect([...CRON_ONLY_QUEUES, ...CRON_CONTINUED_QUEUES].sort()).toEqual(
      Object.keys(CRON_TRIGGERS).sort(),
    );

    const queueNames = QUEUES.map((queue) => queue.name);
    for (const name of CRON_ONLY_QUEUES) {
      expect(queueNames).not.toContain(name);
    }
    for (const name of CRON_CONTINUED_QUEUES) {
      expect(queueNames).toContain(name);
    }
  });

  it("declares every registered cron in wrangler.jsonc, and nothing else", () => {
    expect([...(config.triggers?.crons ?? [])].sort()).toEqual(
      [...CRON_EXPRESSIONS].sort(),
    );
  });

  it("recognises a declared expression and rejects an undeclared one", () => {
    expect(isDeclaredCron("0 3 * * *")).toBe(true);
    expect(isDeclaredCron("0 4 * * *")).toBe(false);
  });
});
