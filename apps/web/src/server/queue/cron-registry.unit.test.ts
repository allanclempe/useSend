import { describe, expect, it } from "vitest";

import { readWranglerConfig } from "~/test/wrangler-config";
import {
  CRON_EXPRESSIONS,
  CRON_TRIGGERS,
  cronJobFor,
  isDeclaredCron,
  SCHEDULER_KEEPALIVE_CRON,
} from "./cron-registry";
import { CRON_ONLY_QUEUES, QUEUES } from "./queue-registry";

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

  it("covers exactly the queues that carry a schedule and no messages", () => {
    expect([...CRON_ONLY_QUEUES].sort()).toEqual(
      Object.keys(CRON_TRIGGERS).sort(),
    );
    for (const name of Object.keys(CRON_TRIGGERS)) {
      expect(QUEUES.map((queue) => queue.name)).not.toContain(name);
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
