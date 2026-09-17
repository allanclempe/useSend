import { AsyncLocalStorage } from "node:async_hooks";

/**
 * W3C Trace Context, carried per request and per job.
 *
 * This is deliberately *not* a tracer. Nothing here starts, ends or exports a
 * span — it only carries the ids a log record needs so the lines emitted by an
 * API request, the queue message it produced and the consumer that ran it all
 * share one `trace_id`. That is the difference between debugging a failed send
 * and doing archaeology (#18).
 *
 * When a real tracer arrives with the Workers foundation (#7), it replaces the
 * id generation below and keeps this module's shape: `getTraceContext()` is the
 * seam the logger reads, and `traceparent` is the wire format both sides speak.
 *
 * https://www.w3.org/TR/trace-context/
 */

export type TraceContext = {
  /** 32 lowercase hex characters, never all zeroes. */
  traceId: string;
  /** 16 lowercase hex characters, never all zeroes. */
  spanId: string;
  /** Two hex characters; bit 0 is "sampled". */
  traceFlags: string;
};

export const TRACEPARENT_HEADER = "traceparent";

/** `00-<32 hex>-<16 hex>-<2 hex>`, version 00 only. */
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

const INVALID_TRACE_ID = "0".repeat(32);
const INVALID_SPAN_ID = "0".repeat(16);

const traceStore = new AsyncLocalStorage<TraceContext>();

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const byte of buf) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/** A fresh, sampled root context. */
export function newTraceContext(): TraceContext {
  return { traceId: randomHex(16), spanId: randomHex(8), traceFlags: "01" };
}

export function parseTraceparent(
  header: string | null | undefined,
): TraceContext | undefined {
  const match = header?.trim().match(TRACEPARENT);
  if (!match) {
    return undefined;
  }
  const [, traceId, spanId, traceFlags] = match as unknown as [
    string,
    string,
    string,
    string,
  ];
  if (traceId === INVALID_TRACE_ID || spanId === INVALID_SPAN_ID) {
    return undefined;
  }
  return { traceId, spanId, traceFlags };
}

export function formatTraceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.traceFlags}`;
}

/**
 * Begin work at an entry point — an HTTP request, a queue message, an alarm.
 *
 * A valid incoming `traceparent` continues that trace under a new span id;
 * anything else starts a new trace. Both cases return a usable context, so
 * callers never have to branch.
 */
export function startTrace(carrier?: string | null): TraceContext {
  const parent = parseTraceparent(carrier);
  if (!parent) {
    return newTraceContext();
  }
  return { ...parent, spanId: randomHex(8) };
}

export function withTraceContext<T>(
  context: TraceContext,
  fn: () => Promise<T> | T,
) {
  return traceStore.run(context, fn);
}

export function getTraceContext(): TraceContext | undefined {
  return traceStore.getStore();
}

/** The header value to hand to whatever runs next, if we are in a trace. */
export function currentTraceparent(): string | undefined {
  const context = getTraceContext();
  return context ? formatTraceparent(context) : undefined;
}
