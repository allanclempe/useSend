import { beforeEach, describe, expect, it, vi } from "vitest";

import { createQueue, createWorker } from "./index";
import {
  getTraceContext,
  newTraceContext,
  withTraceContext,
} from "../logger/trace-context";
import type { JobHandler, QueueJob } from "./types";

const { mockEnqueue, mockEnqueueBulk, registered } = vi.hoisted(() => ({
  mockEnqueue: vi.fn(),
  mockEnqueueBulk: vi.fn(),
  registered: { handler: undefined as JobHandler<any> | undefined },
}));

// Mock the driver, not the queue module — the seam under test is the wrapper
// `server/queue/index.ts` puts around it.
vi.mock("./bullmq-driver", () => ({
  bullmqDriver: {
    createQueue: () => ({
      name: "test-queue",
      enqueue: mockEnqueue,
      enqueueBulk: mockEnqueueBulk,
      schedule: vi.fn(),
      getJob: vi.fn(),
      getStats: vi.fn(),
      close: vi.fn(),
    }),
    createWorker: (_name: string, handler: JobHandler<any>) => {
      registered.handler = handler;
      return { concurrency: 1, close: vi.fn() };
    },
  },
}));

function job(data: unknown): QueueJob<any> {
  return { id: "j_1", name: "test", data, attemptsMade: 0 };
}

describe("queue trace propagation", () => {
  beforeEach(() => {
    mockEnqueue.mockClear();
    mockEnqueueBulk.mockClear();
    registered.handler = undefined;
  });

  it("puts a traceparent on the message when enqueued inside a trace", async () => {
    const queue = createQueue<{ emailId: string }>("test-queue");
    const context = newTraceContext();

    await withTraceContext(context, () =>
      queue.enqueue("send", { emailId: "e_1" }),
    );

    const [, data] = mockEnqueue.mock.calls[0]!;
    expect(data.emailId).toBe("e_1");
    expect(data.__traceparent).toBe(
      `00-${context.traceId}-${context.spanId}-01`,
    );
  });

  it("leaves the message alone outside a trace", async () => {
    const queue = createQueue<{ emailId: string }>("test-queue");
    await queue.enqueue("send", { emailId: "e_1" });

    expect(mockEnqueue.mock.calls[0]![1]).toEqual({ emailId: "e_1" });
  });

  it("stamps every message of a bulk enqueue", async () => {
    const queue = createQueue<{ emailId: string }>("test-queue");

    await withTraceContext(newTraceContext(), () =>
      queue.enqueueBulk([
        { name: "send", data: { emailId: "e_1" } },
        { name: "send", data: { emailId: "e_2" } },
      ]),
    );

    const [jobs] = mockEnqueueBulk.mock.calls[0]!;
    expect(jobs).toHaveLength(2);
    for (const bulkJob of jobs) {
      expect(bulkJob.data.__traceparent).toMatch(/^00-[0-9a-f]{32}-/);
    }
  });

  it("continues the producer's trace in the consumer, under a new span", async () => {
    const seen: Array<{ data: unknown; traceId?: string; spanId?: string }> = [];
    createWorker<{ emailId: string }>("test-queue", async (received) => {
      const trace = getTraceContext();
      seen.push({
        data: received.data,
        traceId: trace?.traceId,
        spanId: trace?.spanId,
      });
    });

    const producer = newTraceContext();
    await registered.handler!(
      job({
        emailId: "e_1",
        __traceparent: `00-${producer.traceId}-${producer.spanId}-01`,
      }),
    );

    const first = seen[0]!;
    // Same trace, a different span — the consumer is its own unit of work.
    expect(first.traceId).toBe(producer.traceId);
    expect(first.spanId).not.toBe(producer.spanId);
    // And the carrier never reaches the handler.
    expect(first.data).toEqual({ emailId: "e_1" });
  });

  it("starts a trace for a message that arrived without one", async () => {
    let traceId: string | undefined;
    createWorker<{ emailId: string }>("test-queue", async () => {
      traceId = getTraceContext()?.traceId;
    });

    await registered.handler!(job({ emailId: "e_1" }));

    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});
