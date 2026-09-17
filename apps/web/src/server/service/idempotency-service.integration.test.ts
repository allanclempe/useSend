import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { idempotencyStore } from "~/server/idempotency";
import {
  IDEMPOTENCY_CONSTANTS,
  IdempotencyService,
} from "~/server/service/idempotency-service";
import { UnsendApiError } from "~/server/public-api/api-error";
import {
  closeIntegrationConnections,
  integrationEnabled,
  resetRedis,
} from "~/test/integration/helpers";

const describeIntegration = integrationEnabled ? describe : describe.skip;

/**
 * Against real Redis, which is the Node driver.
 *
 * The Durable Object driver is checked in a real `workerd` isolate instead
 * (`pnpm --filter=web bindings:check`) — including the case these cannot cover,
 * two identical requests arriving at once. What these assert is that both
 * drivers answer `begin` the same four ways, because the service above them
 * switches on exactly that.
 */
describeIntegration("idempotency store integration", () => {
  beforeEach(async () => {
    await resetRedis();
  });

  afterAll(async () => {
    await closeIntegrationConnections();
  });

  it("claims a key once, and reports the second caller as in progress", async () => {
    const teamId = 99;
    const key = "lock-test";

    await expect(
      idempotencyStore.begin(teamId, key, "hash-a"),
    ).resolves.toEqual({ status: "acquired" });
    await expect(
      idempotencyStore.begin(teamId, key, "hash-a"),
    ).resolves.toEqual({ status: "in-progress" });

    await idempotencyStore.abandon(teamId, key);

    await expect(
      idempotencyStore.begin(teamId, key, "hash-a"),
    ).resolves.toEqual({ status: "acquired" });
  });

  it("reports a different payload under the same key as a conflict", async () => {
    const teamId = 98;
    const key = "conflict-test";

    await idempotencyStore.begin(teamId, key, "hash-a");

    // While the first is still running...
    await expect(
      idempotencyStore.begin(teamId, key, "hash-b"),
    ).resolves.toEqual({ status: "conflict" });

    await idempotencyStore.complete(teamId, key, "hash-a", ["em_1"]);

    // ...and after it finished.
    await expect(
      idempotencyStore.begin(teamId, key, "hash-b"),
    ).resolves.toEqual({ status: "conflict" });
  });

  it("replays a completed result", async () => {
    const teamId = 1;
    const key = "idem-1";

    await idempotencyStore.begin(teamId, key, "hash-123");
    await idempotencyStore.complete(teamId, key, "hash-123", ["em_1"]);

    await expect(
      idempotencyStore.begin(teamId, key, "hash-123"),
    ).resolves.toEqual({ status: "hit", emailIds: ["em_1"] });
  });

  it("never deletes a completed record when a claim is abandoned", async () => {
    const teamId = 97;
    const key = "abandon-after-complete";

    await idempotencyStore.begin(teamId, key, "hash-a");
    await idempotencyStore.complete(teamId, key, "hash-a", ["em_1"]);
    await idempotencyStore.abandon(teamId, key);

    await expect(
      idempotencyStore.begin(teamId, key, "hash-a"),
    ).resolves.toEqual({ status: "hit", emailIds: ["em_1"] });
  });

  it("returns the cached response for a repeated payload", async () => {
    const operation = vi.fn(async () => ({ id: "first", emailIds: ["em_1"] }));

    const options = {
      teamId: 25,
      idemKey: "request-1",
      payload: { to: "a@b.com", subject: "hello" },
      operation,
      extractEmailIds: (result: { emailIds: string[] }) => result.emailIds,
      formatCachedResponse: (emailIds: string[]) => ({
        id: "cached",
        emailIds,
      }),
      logContext: "integration-test",
    };

    const first = await IdempotencyService.withIdempotency(options);
    const second = await IdempotencyService.withIdempotency(options);

    expect(first).toEqual({ id: "first", emailIds: ["em_1"] });
    expect(second).toEqual({ id: "cached", emailIds: ["em_1"] });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(IDEMPOTENCY_CONSTANTS.RESULT_TTL_SECONDS).toBe(24 * 60 * 60);
  });

  it("releases the key when the operation throws, so a retry is not blocked", async () => {
    const options = {
      teamId: 26,
      idemKey: "request-fails",
      payload: { to: "a@b.com" },
      operation: vi.fn(async () => {
        throw new Error("send failed");
      }),
      extractEmailIds: () => [],
      formatCachedResponse: () => ({ emailIds: [] }),
      logContext: "integration-test",
    };

    await expect(IdempotencyService.withIdempotency(options)).rejects.toThrow(
      "send failed",
    );

    // Not "in progress": the failed attempt gave the key back.
    const retry = vi.fn(async () => ({ emailIds: ["em_9"] }));
    await expect(
      IdempotencyService.withIdempotency({ ...options, operation: retry }),
    ).resolves.toEqual({ emailIds: ["em_9"] });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("rejects a second payload under a used key with NOT_UNIQUE", async () => {
    const base = {
      teamId: 27,
      idemKey: "request-conflict",
      extractEmailIds: (result: { emailIds: string[] }) => result.emailIds,
      formatCachedResponse: (emailIds: string[]) => ({ emailIds }),
      logContext: "integration-test",
    };

    await IdempotencyService.withIdempotency({
      ...base,
      payload: { to: "a@b.com" },
      operation: async () => ({ emailIds: ["em_1"] }),
    });

    await expect(
      IdempotencyService.withIdempotency({
        ...base,
        payload: { to: "someone-else@b.com" },
        operation: async () => ({ emailIds: ["em_2"] }),
      }),
    ).rejects.toBeInstanceOf(UnsendApiError);
  });
});
