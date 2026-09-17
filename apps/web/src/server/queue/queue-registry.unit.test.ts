import { describe, expect, it } from "vitest";

import { readWranglerConfig } from "~/test/wrangler-config";
import {
  bindingNameFor,
  CRON_ONLY_QUEUES,
  DEAD_LETTER_QUEUE_NAME,
  maxRetriesFor,
  nonQueueDestination,
  QUEUES,
  queueNameFor,
  retryDelaySeconds,
} from "./queue-registry";
import {
  SEND_QUEUE_SUFFIXES,
  sendQueueName,
  SUPPORTED_SES_REGIONS,
} from "./ses-regions";

/**
 * The registry and `wrangler.jsonc` have to agree, and nothing else enforces
 * that.
 *
 * Cloudflare Queues are deploy-time configuration: a binding that is not in
 * `wrangler.jsonc` is simply absent from `env`, so a queue added to the
 * registry and forgotten in the config fails at runtime, on a send path, in
 * production. That is §4.1's whole hazard, and this test is what turns it into
 * a red suite instead.
 */

const config = readWranglerConfig();

const producers = config.queues?.producers ?? [];
const consumers = config.queues?.consumers ?? [];

describe("queue registry", () => {
  it("derives a Cloudflare queue name and an env binding from a logical name", () => {
    expect(queueNameFor("ses-webhook")).toBe("usesend-ses-webhook");
    expect(bindingNameFor("ses-webhook")).toBe("QUEUE_SES_WEBHOOK");
    expect(bindingNameFor("us-east-1-transaction")).toBe(
      "QUEUE_US_EAST_1_TRANSACTION",
    );
  });

  it("never names a cron-only job as a queue", () => {
    for (const name of CRON_ONLY_QUEUES) {
      expect(QUEUES.map((queue) => queue.name)).not.toContain(name);
    }
  });

  it("grows the retry delay with the attempt, capped at 12 hours", () => {
    const sesWebhook = QUEUES.find((queue) => queue.name === "ses-webhook")!;

    expect(retryDelaySeconds(sesWebhook, 0)).toBe(5);
    expect(retryDelaySeconds(sesWebhook, 1)).toBe(10);
    expect(retryDelaySeconds(sesWebhook, 4)).toBe(80);
    // A pathological attempt count must still be a legal delaySeconds.
    expect(retryDelaySeconds(sesWebhook, 40)).toBe(43_200);
  });

  it("counts retries as one fewer than attempts", () => {
    const sesWebhook = QUEUES.find((queue) => queue.name === "ses-webhook")!;

    expect(sesWebhook.maxAttempts).toBe(5);
    expect(maxRetriesFor(sesWebhook)).toBe(4);
  });

  it("says where a name that is not a queue actually went", () => {
    // `webhook-dispatch` is still a name the code uses -- it is the BullMQ
    // queue under Node -- and on Workers it is a Durable Object, not a queue.
    expect(nonQueueDestination("webhook-dispatch")).toMatch(/Durable Object/);
    expect(nonQueueDestination("domain-verification")).toMatch(/Cron Trigger/);
    expect(nonQueueDestination("ses-webhook")).toBeUndefined();
  });
});

describe("wrangler.jsonc agrees with the registry", () => {
  it("declares a producer binding for every registered queue", () => {
    expect(
      producers.map((producer) => ({
        queue: producer.queue,
        binding: producer.binding,
      })),
    ).toEqual(
      QUEUES.map((queue) => ({
        queue: queue.queueName,
        binding: queue.binding,
      })),
    );
  });

  it("declares a consumer with the registry's batch and retry settings", () => {
    for (const queue of QUEUES) {
      const consumer = consumers.find((c) => c.queue === queue.queueName);

      expect(consumer, `no consumer declared for ${queue.queueName}`).toBeDefined();
      expect(consumer!.max_batch_size).toBe(queue.maxBatchSize);
      expect(consumer!.max_batch_timeout).toBe(queue.maxBatchTimeout);
      expect(consumer!.max_retries).toBe(maxRetriesFor(queue));
      expect(consumer!.max_concurrency).toBe(queue.maxConcurrency ?? undefined);
      expect(consumer!.dead_letter_queue).toBe(DEAD_LETTER_QUEUE_NAME);
    }
  });

  it("consumes its own dead letter queue, and does not retry from it", () => {
    const deadLetter = consumers.find((c) => c.queue === DEAD_LETTER_QUEUE_NAME);

    expect(deadLetter).toBeDefined();
    expect(deadLetter!.max_retries).toBe(0);
    expect(deadLetter!.dead_letter_queue).toBeUndefined();
  });

  it("pre-declares a queue pair for every supported SES region", () => {
    // §4.1: the set is fixed at deploy time, so adding a region is a deploy.
    for (const region of SUPPORTED_SES_REGIONS) {
      for (const suffix of SEND_QUEUE_SUFFIXES) {
        const name = sendQueueName(region, suffix);
        expect(
          QUEUES.find((queue) => queue.name === name),
          `no queue for ${name}`,
        ).toBeDefined();
      }
    }

    expect(QUEUES.filter((q) => q.maxConcurrency !== null).length).toBe(
      SUPPORTED_SES_REGIONS.length * SEND_QUEUE_SUFFIXES.length + 1,
    );
  });

  it("declares no consumer for a queue that is not in the registry", () => {
    const known = new Set([
      ...QUEUES.map((queue) => queue.queueName),
      DEAD_LETTER_QUEUE_NAME,
    ]);

    expect(consumers.filter((c) => !known.has(c.queue))).toEqual([]);
  });
});
