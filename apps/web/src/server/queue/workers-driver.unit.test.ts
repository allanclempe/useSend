import { beforeEach, describe, expect, it, vi } from "vitest";

import { withWorkerBindings, type WorkerBindings } from "../worker-bindings";
import { workersDriver } from "./workers-driver";

/**
 * The driver is the one place that knows Cloudflare's shape — `send`,
 * `sendBatch`, `delaySeconds`, the 128 KB message cap. These tests are about
 * that translation, not about the queue interface, which
 * `trace-propagation.unit.test.ts` already covers.
 */

const send = vi.fn();
const sendBatch = vi.fn();

function withBindings<T>(fn: () => T): T {
  return withWorkerBindings(
    {
      QUEUE_SES_WEBHOOK: { send, sendBatch },
    } as unknown as WorkerBindings,
    fn,
  );
}

describe("workers queue driver", () => {
  beforeEach(() => {
    send.mockReset();
    sendBatch.mockReset();
  });

  it("sends an envelope carrying the job name and its source queue", async () => {
    const queue = workersDriver.createQueue<{ emailId: string }>("ses-webhook");

    await withBindings(() => queue.enqueue("event", { emailId: "e_1" }));

    expect(send).toHaveBeenCalledWith(
      { name: "event", queue: "ses-webhook", data: { emailId: "e_1" } },
      { contentType: "json" },
    );
  });

  it("converts a millisecond delay to whole seconds, rounding up", async () => {
    const queue = workersDriver.createQueue("ses-webhook");

    await withBindings(() => queue.enqueue("event", {}, { delay: 1500 }));

    expect(send.mock.calls[0]?.[1]).toEqual({
      contentType: "json",
      delaySeconds: 2,
    });
  });

  it("refuses a delay past Cloudflare's 12 hour maximum", async () => {
    const queue = workersDriver.createQueue("ses-webhook");

    await expect(
      withBindings(() =>
        queue.enqueue("event", {}, { delay: 13 * 60 * 60 * 1000 }),
      ),
    ).rejects.toThrow(/12 hour/);
  });

  it("refuses a message over the 128 KB limit", async () => {
    const queue = workersDriver.createQueue<{ body: string }>("ses-webhook");

    await expect(
      withBindings(() =>
        queue.enqueue("event", { body: "x".repeat(200_000) }),
      ),
    ).rejects.toThrow(/over Cloudflare's 131072 byte limit/);
    expect(send).not.toHaveBeenCalled();
  });

  it("splits a bulk enqueue into batches of 100", async () => {
    const queue = workersDriver.createQueue<{ n: number }>("ses-webhook");
    const jobs = Array.from({ length: 250 }, (_, n) => ({
      name: "event",
      data: { n },
    }));

    await withBindings(() => queue.enqueueBulk(jobs));

    expect(sendBatch).toHaveBeenCalledTimes(3);
    expect(sendBatch.mock.calls.map(([batch]) => batch.length)).toEqual([
      100, 100, 50,
    ]);
  });

  it("names the missing binding when a queue is not declared in wrangler.jsonc", async () => {
    const queue = workersDriver.createQueue("campaign-batch");

    await expect(withBindings(() => queue.enqueue("batch", {}))).rejects.toThrow(
      /QUEUE_CAMPAIGN_BATCH/,
    );
  });

  it("says a cron-only job is a Cron Trigger rather than a missing binding", async () => {
    const queue = workersDriver.createQueue("webhook-cleanup");

    await expect(withBindings(() => queue.enqueue("run", {}))).rejects.toThrow(
      /Cron Trigger/,
    );
  });

  it("refuses a sub-minute schedule, which no Cron Trigger can express", async () => {
    const queue = workersDriver.createQueue("campaign-scheduler");

    await expect(
      queue.schedule("campaign-scheduler", { every: 1500 }),
    ).rejects.toThrow(/Durable Object alarms/);
  });
});
