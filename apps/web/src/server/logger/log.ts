// lib/logging.ts
import { AsyncLocalStorage } from "node:async_hooks";

const isDev = process.env.NODE_ENV !== "production";

/**
 * Numeric levels and the `level` / `time` / `msg` field names are kept
 * identical to pino's JSON output so downstream log parsing keeps working.
 */
const LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const;

export type LogLevel = keyof typeof LEVELS;

type Bindings = Record<string, any>;

/* eslint-disable no-unused-vars -- parameter names in type signatures */
export type Logger = {
  [L in LogLevel]: (objOrMsg: object | string, msg?: string) => void;
} & {
  level: LogLevel;
  child: (bindings: Bindings) => Logger;
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
  return !!value && value in LEVELS;
}

/**
 * Errors are not enumerable, so JSON.stringify flattens them to `{}`. pino's
 * standard serializer handled this; the codebase leans on it heavily via
 * `logger.error({ err }, "...")`, so it has to be preserved here.
 */
type SerializedError = {
  type: string;
  message: string;
  stack?: string;
  cause?: SerializedError | unknown;
};

function serializeError(err: Error): SerializedError {
  return {
    type: err.name,
    message: err.message,
    stack: err.stack,
    ...(err.cause !== undefined
      ? { cause: err.cause instanceof Error ? serializeError(err.cause) : err.cause }
      : {}),
  };
}

function serialize(value: unknown): unknown {
  return value instanceof Error ? serializeError(value) : value;
}

function formatDevTime(date: Date) {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    `${pad(date.getMilliseconds(), 3)}`
  );
}

function write(level: LogLevel, bindings: Bindings, obj: Bindings, msg?: string) {
  const merged: Bindings = { ...bindings };
  for (const [key, value] of Object.entries(obj)) {
    merged[key] = serialize(value);
  }

  if (isDev) {
    // `service` is constant noise in dev; pino-pretty dropped pid/hostname the same way.
    const rest: Bindings = {};
    for (const [key, value] of Object.entries(merged)) {
      if (key !== "service") {
        rest[key] = value;
      }
    }
    const time = `\x1b[90m${formatDevTime(new Date())}\x1b[0m`;
    const tag = `${LEVEL_COLORS[level]}${level.toUpperCase()}\x1b[0m`;
    const detail = Object.keys(rest).length
      ? ` ${JSON.stringify(rest, null, 2)}`
      : "";
    // eslint-disable-next-line no-console
    console.log(`${time} ${tag}: ${msg ?? ""}${detail}`);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      level: LEVELS[level],
      time: Date.now(),
      ...merged,
      ...(msg !== undefined ? { msg } : {}),
    })
  );
}

function createLogger(bindings: Bindings, level: LogLevel): Logger {
  const threshold = LEVELS[level];

  const log =
    (target: LogLevel) => (objOrMsg: object | string, msg?: string) => {
      if (LEVELS[target] < threshold) {
        return;
      }
      if (typeof objOrMsg === "string") {
        write(target, bindings, {}, objOrMsg);
      } else {
        write(target, bindings, objOrMsg as Bindings, msg);
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
    child: (extra: Bindings) => createLogger({ ...bindings, ...extra }, level),
  };
}

type Store = { logger: Logger }; // what we stash per request
const loggerStore = new AsyncLocalStorage<Store>();

export const rootLogger = createLogger(
  { service: "next-app" },
  isLogLevel(process.env.LOG_LEVEL)
    ? process.env.LOG_LEVEL
    : isDev
      ? "debug"
      : "info"
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
  }
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
