import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * These lock in the pino-compatible output shape after the pino removal:
 * numeric `level`, `time`, `msg`, merged bindings, and serialized errors.
 */
async function loadLogger(env: { NODE_ENV?: string; LOG_LEVEL?: string } = {}) {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", env.NODE_ENV ?? "production");
  if (env.LOG_LEVEL) {
    vi.stubEnv("LOG_LEVEL", env.LOG_LEVEL);
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

  it("emits pino-compatible JSON for a bare message", async () => {
    const { logger } = await loadLogger();
    logger.info("hello");

    const out = lastJson(spy);
    expect(out.level).toBe(30);
    expect(out.msg).toBe("hello");
    expect(out.service).toBe("next-app");
    expect(typeof out.time).toBe("number");
  });

  it("merges an object argument alongside the message", async () => {
    const { logger } = await loadLogger();
    logger.warn({ teamId: 7, queueId: "abc" }, "queued");

    const out = lastJson(spy);
    expect(out.level).toBe(40);
    expect(out.msg).toBe("queued");
    expect(out.teamId).toBe(7);
    expect(out.queueId).toBe("abc");
  });

  it("serializes Error values instead of flattening them to {}", async () => {
    const { logger } = await loadLogger();
    logger.error({ err: new Error("boom") }, "failed");

    const out = lastJson(spy);
    expect(out.level).toBe(50);
    expect(out.err.type).toBe("Error");
    expect(out.err.message).toBe("boom");
    expect(out.err.stack).toContain("boom");
  });

  it("serializes a nested cause", async () => {
    const { logger } = await loadLogger();
    logger.error({ err: new Error("outer", { cause: new Error("inner") }) }, "failed");

    expect(lastJson(spy).err.cause.message).toBe("inner");
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
    expect(lastJson(spy).teamId).toBe(42);

    logger.info("outside");
    expect(lastJson(spy).teamId).toBeUndefined();
  });

  it("applies setBindings to the rest of the context", async () => {
    const { logger, getChildLogger, withLogger } = await loadLogger();

    await withLogger(getChildLogger({ teamId: 1 }), async () => {
      logger.info("before");
      expect(lastJson(spy).emailId).toBeUndefined();

      logger.setBindings({ emailId: "e_1" });
      logger.info("after");

      const out = lastJson(spy);
      expect(out.emailId).toBe("e_1");
      expect(out.teamId).toBe(1);
    });
  });

  it("ignores setBindings outside a context", async () => {
    const { logger } = await loadLogger();
    expect(() => logger.setBindings({ teamId: 1 })).not.toThrow();
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
