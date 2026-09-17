import { describe, expect, it } from "vitest";

import {
  formatTraceparent,
  getTraceContext,
  newTraceContext,
  parseTraceparent,
  currentTraceparent,
  startTrace,
  withTraceContext,
} from "./trace-context";

const VALID = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

describe("trace context", () => {
  it("generates ids of the right shape", () => {
    const context = newTraceContext();
    expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(context.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(context.traceFlags).toBe("01");
  });

  it("generates a different trace each time", () => {
    expect(newTraceContext().traceId).not.toBe(newTraceContext().traceId);
  });

  it("round-trips a traceparent header", () => {
    const parsed = parseTraceparent(VALID);
    expect(parsed).toEqual({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: "01",
    });
    expect(formatTraceparent(parsed!)).toBe(VALID);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["a future version", "01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"],
    ["the wrong length", "00-0af765-b7ad6b7169203331-01"],
    ["uppercase hex", "00-0AF7651916CD43DD8448EB211C80319C-b7ad6b7169203331-01"],
    ["an all-zero trace id", `00-${"0".repeat(32)}-b7ad6b7169203331-01`],
    ["an all-zero span id", `00-0af7651916cd43dd8448eb211c80319c-${"0".repeat(16)}-01`],
  ])("rejects %s", (_name, header) => {
    expect(parseTraceparent(header)).toBeUndefined();
  });

  it("continues an inbound trace under a new span", () => {
    const context = startTrace(VALID);
    expect(context.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(context.spanId).not.toBe("b7ad6b7169203331");
    expect(context.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("starts a new trace when the header is unusable", () => {
    const context = startTrace("nonsense");
    expect(context.traceId).not.toBe("0af7651916cd43dd8448eb211c80319c");
    expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("scopes the context to withTraceContext", async () => {
    expect(getTraceContext()).toBeUndefined();

    const context = newTraceContext();
    await withTraceContext(context, async () => {
      expect(getTraceContext()).toEqual(context);
      expect(currentTraceparent()).toBe(formatTraceparent(context));

      // Async boundaries keep it.
      await Promise.resolve();
      expect(getTraceContext()).toEqual(context);
    });

    expect(getTraceContext()).toBeUndefined();
    expect(currentTraceparent()).toBeUndefined();
  });
});
