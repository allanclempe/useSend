import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * These lock in the OpenTelemetry Logs Data Model shape: `severity_text` /
 * `severity_number`, an RFC 3339 `timestamp`, the human-readable `body`,
 * nested `attributes`, semantic-convention `resource` attributes, and
 * `exception.*` for errors.
 */
async function loadLogger(
  env: {
    NODE_ENV?: string;
    LOG_LEVEL?: string;
    OTEL_SERVICE_NAME?: string;
    OTEL_SERVICE_VERSION?: string;
  } = {},
) {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", env.NODE_ENV ?? "production");
  if (env.LOG_LEVEL) {
    vi.stubEnv("LOG_LEVEL", env.LOG_LEVEL);
  }
  if (env.OTEL_SERVICE_NAME) {
    vi.stubEnv("OTEL_SERVICE_NAME", env.OTEL_SERVICE_NAME);
  }
  if (env.OTEL_SERVICE_VERSION) {
    vi.stubEnv("OTEL_SERVICE_VERSION", env.OTEL_SERVICE_VERSION);
  }
  return import("./log");
}

function lastJson(spy: ReturnType<typeof vi.spyOn>) {
  const call = spy.mock.calls.at(-1);
  return JSON.parse(call?.[0] as string);
}

describe("logger", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    spy.mockRestore();
  });

  it("emits an OTel log record for a bare message", async () => {
    const { logger } = await loadLogger();
    logger.info("hello");

    const out = lastJson(spy);
    expect(out.severity_text).toBe("INFO");
    expect(out.severity_number).toBe(9);
    expect(out.body).toBe("hello");
    expect(Date.parse(out.timestamp)).not.toBeNaN();
    expect(out.timestamp).toBe(new Date(out.timestamp).toISOString());
    // No pino left anywhere in the record.
    expect(out.level).toBeUndefined();
    expect(out.time).toBeUndefined();
    expect(out.msg).toBeUndefined();
  });

  it("maps every level onto its OTel severity number", async () => {
    const { logger } = await loadLogger({ LOG_LEVEL: "trace" });

    const expected = [
      ["trace", "TRACE", 1],
      ["debug", "DEBUG", 5],
      ["info", "INFO", 9],
      ["warn", "WARN", 13],
      ["error", "ERROR", 17],
      ["fatal", "FATAL", 21],
    ] as const;

    for (const [level, text, number] of expected) {
      logger[level]("x");
      const out = lastJson(spy);
      expect(out.severity_text).toBe(text);
      expect(out.severity_number).toBe(number);
    }
  });

  it("carries resource attributes under the semantic convention names", async () => {
    const { logger } = await loadLogger({
      OTEL_SERVICE_NAME: "usesend-api",
      OTEL_SERVICE_VERSION: "1.4.0",
    });
    logger.info("hello");

    const out = lastJson(spy);
    expect(out.resource).toEqual({
      "service.name": "usesend-api",
      "service.version": "1.4.0",
      "deployment.environment.name": "production",
    });
    // The old flat `service` binding is gone.
    expect(out.service).toBeUndefined();
  });

  it("defaults the service name and omits an unknown version", async () => {
    const { logger } = await loadLogger();
    logger.info("hello");

    const out = lastJson(spy);
    expect(out.resource["service.name"]).toBe("usesend");
    expect(out.resource).not.toHaveProperty("service.version");
  });

  it("nests the object argument under attributes", async () => {
    const { logger } = await loadLogger();
    logger.warn({ teamId: 7, queueId: "abc" }, "queued");

    const out = lastJson(spy);
    expect(out.body).toBe("queued");
    expect(out.attributes).toEqual({ teamId: 7, queueId: "abc" });
    expect(out.teamId).toBeUndefined();
  });

  it("omits attributes entirely when there are none", async () => {
    const { logger } = await loadLogger();
    logger.info("hello");
    expect(lastJson(spy)).not.toHaveProperty("attributes");
  });

  it("drops undefined attributes rather than emitting empty keys", async () => {
    const { logger, getChildLogger, withLogger } = await loadLogger();

    await withLogger(getChildLogger({ teamId: undefined }), async () => {
      logger.info("hello");
    });
    expect(lastJson(spy)).not.toHaveProperty("attributes");
  });

  it("maps an Error onto the exception attributes", async () => {
    const { logger } = await loadLogger();
    logger.error({ err: new Error("boom") }, "failed");

    const out = lastJson(spy);
    expect(out.severity_number).toBe(17);
    expect(out.attributes["exception.type"]).toBe("Error");
    expect(out.attributes["exception.message"]).toBe("boom");
    expect(out.attributes["exception.stacktrace"]).toContain("boom");
    // The call site's key is replaced by the convention, not kept alongside it.
    expect(out.attributes.err).toBeUndefined();
  });

  it("maps an Error under any key, not just `err`", async () => {
    const { logger } = await loadLogger();
    logger.error({ error: new TypeError("nope"), emailId: "e_1" }, "failed");

    const out = lastJson(spy);
    expect(out.attributes["exception.type"]).toBe("TypeError");
    expect(out.attributes.emailId).toBe("e_1");
    expect(out.attributes.error).toBeUndefined();
  });

  it("accepts an Error as the whole record", async () => {
    const { logger } = await loadLogger();
    logger.error(new Error("bare"));

    expect(lastJson(spy).attributes["exception.message"]).toBe("bare");
  });

  it("appends the cause chain to the stacktrace", async () => {
    const { logger } = await loadLogger();
    logger.error(
      { err: new Error("outer", { cause: new Error("inner") }) },
      "failed",
    );

    const stack = lastJson(spy).attributes["exception.stacktrace"];
    expect(stack).toContain("outer");
    expect(stack).toContain("Caused by:");
    expect(stack).toContain("inner");
  });

  it("keeps a non-Error value as a plain attribute", async () => {
    const { logger } = await loadLogger();
    logger.error({ err: "just a string" }, "failed");

    const out = lastJson(spy);
    expect(out.attributes.err).toBe("just a string");
    expect(out.attributes).not.toHaveProperty("exception.type");
  });

  it("respects the level threshold", async () => {
    const { logger } = await loadLogger({ LOG_LEVEL: "warn" });
    logger.info("dropped");
    expect(spy).not.toHaveBeenCalled();

    logger.error("kept");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("defaults to debug in development and info in production", async () => {
    const dev = await loadLogger({ NODE_ENV: "development" });
    expect(dev.rootLogger.level).toBe("debug");

    const prod = await loadLogger({ NODE_ENV: "production" });
    expect(prod.rootLogger.level).toBe("info");
  });

  it("scopes child bindings to withLogger", async () => {
    const { logger, getChildLogger, withLogger } = await loadLogger();

    await withLogger(getChildLogger({ teamId: 42 }), async () => {
      logger.info("inside");
    });
    expect(lastJson(spy).attributes.teamId).toBe(42);

    logger.info("outside");
    expect(lastJson(spy)).not.toHaveProperty("attributes");
  });

  it("applies setBindings to the rest of the context", async () => {
    const { logger, getChildLogger, withLogger } = await loadLogger();

    await withLogger(getChildLogger({ teamId: 1 }), async () => {
      logger.info("before");
      expect(lastJson(spy).attributes.emailId).toBeUndefined();

      logger.setBindings({ emailId: "e_1" });
      logger.info("after");

      const out = lastJson(spy);
      expect(out.attributes.emailId).toBe("e_1");
      expect(out.attributes.teamId).toBe(1);
    });
  });

  it("ignores setBindings outside a context", async () => {
    const { logger } = await loadLogger();
    expect(() => logger.setBindings({ teamId: 1 })).not.toThrow();
  });

  it("stamps the trace context when there is one", async () => {
    const { logger } = await loadLogger();
    const { withTraceContext } = await import("./trace-context");

    const context = {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: "01",
    };

    await withTraceContext(context, async () => {
      logger.info("inside a trace");
    });

    const out = lastJson(spy);
    expect(out.trace_id).toBe(context.traceId);
    expect(out.span_id).toBe(context.spanId);
    expect(out.trace_flags).toBe("01");
  });

  it("omits the trace fields outside a trace", async () => {
    const { logger } = await loadLogger();
    logger.info("no trace");

    const out = lastJson(spy);
    expect(out).not.toHaveProperty("trace_id");
    expect(out).not.toHaveProperty("span_id");
  });

  it("prints human-readable output in development", async () => {
    const { logger } = await loadLogger({ NODE_ENV: "development" });
    logger.info({ teamId: 3 }, "pretty");

    const line = spy.mock.calls.at(-1)?.[0] as string;
    expect(line).toContain("INFO");
    expect(line).toContain("pretty");
    expect(line).toContain("teamId");
    expect(() => JSON.parse(line)).toThrow();
  });
});
