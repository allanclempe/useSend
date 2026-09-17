import { AsyncLocalStorage } from "node:async_hooks";
import { getTraceContext } from "./trace-context";

const isDev = process.env.NODE_ENV !== "production";

/**
 * Log records follow the OpenTelemetry Logs Data Model, not pino's wire format.
 *
 * One JSON object per line on stdout:
 *
 * ```json
 * {
 *   "timestamp": "2026-09-17T11:03:19.123Z",
 *   "severity_text": "INFO",
 *   "severity_number": 9,
 *   "body": "queued",
 *   "trace_id": "0af7651916cd43dd8448eb211c80319c",
 *   "span_id": "b7ad6b7169203331",
 *   "trace_flags": "01",
 *   "resource": { "service.name": "usesend", "deployment.environment.name": "production" },
 *   "attributes": { "teamId": 7, "queueId": "abc" }
 * }
 * ```
 *
 * Three decisions worth knowing (#18):
 *
 * - **Field names are the data model's, snake_cased.** OTLP/JSON spells the
 *   same fields `severityText` / `timeUnixNano` / `traceId`, but that is a
 *   transport encoding produced by an exporter, not something an application
 *   writes by hand. Translating snake_case stdout into OTLP is mechanical and
 *   belongs in whatever does the exporting.
 * - **`timestamp` is RFC 3339, not Unix nanoseconds.** The clock behind it is
 *   `Date.now()`, so nanosecond precision would be three digits of fiction, and
 *   on Workers these lines are read by humans and by Workers Logs long before
 *   they are read by a collector.
 * - **Attributes are nested, not flat.** It keeps a binding called `body` or
 *   `timestamp` from colliding with the envelope, and it means a consumer can
 *   tell "the app said this" from "the emitter said this" without a field list.
 *
 * Export path: structured stdout. `wrangler.jsonc` sets
 * `observability.enabled`, so Cloudflare Workers Logs ingests and indexes these
 * records with no export code in the request path — a Worker that POSTs to an
 * OTLP endpoint pays for that subrequest on every log line. If OTLP is wanted
 * later it belongs in a tail worker, off the hot path, reading exactly these
 * records. See references/serverless-migration.md §11.
 */

/** OTel `SeverityNumber`. Not pino's scale — info is 9, not 30. */
const SEVERITY_NUMBERS = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
} as const;

export type LogLevel = keyof typeof SEVERITY_NUMBERS;

type Attributes = Record<string, any>;

/* eslint-disable no-unused-vars -- parameter names in type signatures */
export type Logger = {
  [L in LogLevel]: (objOrMsg: object | string, msg?: string) => void;
} & {
  level: LogLevel;
  child: (bindings: Attributes) => Logger;
};
/* eslint-enable no-unused-vars */

const LEVEL_COLORS: Record<LogLevel, string> = {
  trace: "\x1b[90m",
  debug: "\x1b[34m",
  info: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  fatal: "\x1b[35m",
};

function isLogLevel(value: string | undefined): value is LogLevel {
  return !!value && value in SEVERITY_NUMBERS;
}

/**
 * Resource attributes — what produced the record, as opposed to what happened.
 *
 * `service.name` and `deployment.environment.name` are the semantic convention
 * names; the old flat `service: "next-app"` was neither. Read from `process.env`
 * rather than `~/env` so the logger stays importable from anywhere, including
 * modules that run before env validation.
 */
function buildResource(): Record<string, string> {
  const version = process.env.OTEL_SERVICE_VERSION;
  return {
    "service.name": process.env.OTEL_SERVICE_NAME ?? "usesend",
    ...(version ? { "service.version": version } : {}),
    "deployment.environment.name": process.env.NODE_ENV ?? "development",
  };
}

const resource = buildResource();

/**
 * `exception.stacktrace` is one string, so a `cause` chain is appended to it
 * the way a JVM or the OTel JS SDK renders it. The alternative — a nested
 * `cause` object — has no semantic convention and no consumer.
 */
function stacktraceOf(err: Error): string {
  const render = (e: Error) => e.stack ?? `${e.name}: ${e.message}`;
  let out = render(err);
  const seen = new Set<unknown>([err]);
  let cause: unknown = err.cause;

  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    out += `\nCaused by: ${render(cause)}`;
    cause = cause.cause;
  }
  if (cause !== undefined && !(cause instanceof Error)) {
    out += `\nCaused by: ${String(cause)}`;
  }
  return out;
}

/**
 * Errors are not enumerable, so `JSON.stringify` flattens them to `{}`. The
 * codebase leans on `logger.error({ err }, "...")` in ~40 places, so the first
 * Error in a record becomes the `exception.*` attributes and loses its own key:
 * `exception.type` / `exception.message` / `exception.stacktrace` are what a
 * backend groups and alerts on, and `err.type` is not.
 */
function exceptionAttributes(err: Error): Attributes {
  return {
    "exception.type": err.name,
    "exception.message": err.message,
    "exception.stacktrace": stacktraceOf(err),
  };
}

function toAttributes(bindings: Attributes, obj: Attributes): Attributes {
  const attributes: Attributes = {};
  let exception: Error | undefined;

  for (const [key, value] of [
    ...Object.entries(bindings),
    ...Object.entries(obj),
  ]) {
    if (value === undefined) {
      continue;
    }
    if (value instanceof Error) {
      if (!exception) {
        exception = value;
        continue;
      }
      // A second Error keeps its key; only one record can have an exception.
      attributes[key] = exceptionAttributes(value);
      continue;
    }
    attributes[key] = value;
  }

  return exception
    ? { ...attributes, ...exceptionAttributes(exception) }
    : attributes;
}

function formatDevTime(date: Date) {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    `${pad(date.getMilliseconds(), 3)}`
  );
}

function write(
  level: LogLevel,
  bindings: Attributes,
  obj: Attributes,
  body?: string,
) {
  const attributes = toAttributes(bindings, obj);
  const trace = getTraceContext();

  if (isDev) {
    const detail = Object.keys(attributes).length
      ? ` ${JSON.stringify(attributes, null, 2)}`
      : "";
    const time = `\x1b[90m${formatDevTime(new Date())}\x1b[0m`;
    const tag = `${LEVEL_COLORS[level]}${level.toUpperCase()}\x1b[0m`;
    // The first 8 characters are enough to spot two lines sharing a trace.
    const span = trace ? ` \x1b[90m[${trace.traceId.slice(0, 8)}]\x1b[0m` : "";
    // eslint-disable-next-line no-console
    console.log(`${time} ${tag}${span}: ${body ?? ""}${detail}`);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      severity_text: level.toUpperCase(),
      severity_number: SEVERITY_NUMBERS[level],
      ...(body !== undefined ? { body } : {}),
      ...(trace
        ? {
            trace_id: trace.traceId,
            span_id: trace.spanId,
            trace_flags: trace.traceFlags,
          }
        : {}),
      resource,
      ...(Object.keys(attributes).length ? { attributes } : {}),
    }),
  );
}

function createLogger(bindings: Attributes, level: LogLevel): Logger {
  const threshold = SEVERITY_NUMBERS[level];

  const log =
    (target: LogLevel) => (objOrMsg: object | string, msg?: string) => {
      if (SEVERITY_NUMBERS[target] < threshold) {
        return;
      }
      if (typeof objOrMsg === "string") {
        write(target, bindings, {}, objOrMsg);
      } else if (objOrMsg instanceof Error) {
        // `logger.error(err)` — the Error is the record, not an attribute bag.
        write(target, bindings, { err: objOrMsg }, msg);
      } else {
        write(target, bindings, objOrMsg as Attributes, msg);
      }
    };

  return {
    trace: log("trace"),
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    fatal: log("fatal"),
    level,
    child: (extra: Attributes) => createLogger({ ...bindings, ...extra }, level),
  };
}

type Store = { logger: Logger }; // what we stash per request
const loggerStore = new AsyncLocalStorage<Store>();

export const rootLogger = createLogger(
  {},
  isLogLevel(process.env.LOG_LEVEL)
    ? process.env.LOG_LEVEL
    : isDev
      ? "debug"
      : "info",
);

// Helper function to get the current logger
function getCurrentLogger(): Logger {
  return loggerStore.getStore()?.logger ?? rootLogger;
}

// Create a proxy that delegates all property access to the current logger
export const logger = new Proxy(
  {} as Logger & { setBindings: (bindings: Record<string, any>) => void },
  {
    get(target, prop, receiver) {
      // Handle the special setBindings method
      if (prop === "setBindings") {
        return (bindings: Record<string, any>) => {
          const store = loggerStore.getStore();
          if (!store) {
            // If not in a context, just update the root logger (though this won't persist)
            return;
          }

          // Create a new child logger with the merged bindings
          const currentLogger = store.logger;
          const newLogger = currentLogger.child(bindings);

          // Update the store with the new logger
          store.logger = newLogger;
        };
      }

      const currentLogger = getCurrentLogger();
      const value = currentLogger[prop as keyof Logger];

      if (typeof value === "function") {
        return value.bind(currentLogger);
      }

      return value;
    },
  },
);

export function withLogger<T>(child: Logger, fn: () => Promise<T> | T) {
  return loggerStore.run({ logger: child }, fn);
}

export function getChildLogger({
  teamId,
  requestId,
  ...rest
}: {
  teamId?: number;
  requestId?: string;
} & Record<string, any>) {
  return logger.child({ teamId, requestId, ...rest });
}
