import { WebhookCallStatus, WebhookStatus } from "~/types/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzleDb, schema } from "~/server/drizzle";
import { withUpdatedAt } from "~/server/drizzle/touch";
import { createTeam, createUser } from "~/test/factories/core";
import {
  closeIntegrationConnections,
  integrationEnabled,
  resetDatabase,
  pendingWebhookDeliveries,
  resetWorkerBindings,
} from "~/test/integration/helpers";

const { mockLimitService } = vi.hoisted(() => ({
  mockLimitService: { checkWebhookLimit: vi.fn() },
}));

vi.mock("~/server/service/limit-service", () => ({
  LimitService: mockLimitService,
}));

import {
  processWebhookCall,
  WebhookService,
} from "~/server/service/webhook-service";

const describeIntegration = integrationEnabled ? describe : describe.skip;

/**
 * One delivery attempt, called the way the dispatcher calls it.
 *
 * This used to capture the `webhook-dispatch` BullMQ worker's handler and
 * invoke that. There is no such queue any more (#12): `enqueueCall` hands the
 * call to a `WebhookDispatcher` Durable Object and the object's alarm calls
 * `processWebhookCall` with exactly this argument — see
 * `src/worker/webhook-dispatcher.ts`. Calling it directly runs the attempt
 * without waiting on an alarm, and `attemptsMade` is the object's retry count
 * rather than BullMQ's.
 */
async function runCall(callId: string, teamId: number, attemptsMade = 0) {
  return processWebhookCall({
    id: callId,
    name: callId,
    data: { callId, teamId },
    attemptsMade,
  });
}

describeIntegration("webhook-service", () => {
  let teamId: number;
  let userId: number;

  beforeEach(async () => {
    await resetDatabase();
    await resetWorkerBindings();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mockLimitService.checkWebhookLimit.mockResolvedValue({
      isLimitReached: false,
    });

    const team = await createTeam({ name: "wh-team" });
    teamId = team.id;

    // createdByUserId has a real foreign key, which the mocked tests never hit.
    const user = await createUser({ email: "wh@example.com", name: "wh" });
    userId = user.id;
  });

  afterAll(async () => {
    await closeIntegrationConnections();
  });

  async function makeWebhook(overrides: Record<string, unknown> = {}) {
    const [webhook] = await drizzleDb
      .insert(schema.webhook)
      .values(
        withUpdatedAt({
          id: `wh_${Math.random().toString(36).slice(2, 10)}`,
          teamId,
          url: "https://example.com/webhook",
          secret: "whsec_test",
          eventTypes: ["email.delivered"],
          status: WebhookStatus.ACTIVE,
          ...overrides,
        }),
      )
      .returning();

    return webhook!;
  }

  async function makeCall(webhookId: string) {
    const [call] = await drizzleDb
      .insert(schema.webhookCall)
      .values(
        withUpdatedAt({
          id: `call_${Math.random().toString(36).slice(2, 10)}`,
          webhookId,
          teamId,
          type: "email.delivered",
          payload: JSON.stringify({ id: "email_123" }),
          status: WebhookCallStatus.PENDING,
          attempt: 0,
        }),
      )
      .returning();

    return call!;
  }

  function mockFetchOk() {
    return vi.spyOn(global, "fetch").mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }

  describe("delivery headers", () => {
    it("sends the documented headers with retry=false on the first attempt", async () => {
      const webhook = await makeWebhook();
      const call = await makeCall(webhook.id);
      const fetchSpy = mockFetchOk();

      await expect(runCall(call.id, teamId, 0)).resolves.toBeUndefined();

      const [, request] = fetchSpy.mock.calls[0]!;
      const headers = request!.headers as Record<string, string>;
      expect(headers["X-UseSend-Event"]).toBe("email.delivered");
      expect(headers["X-UseSend-Call"]).toBe(call.id);
      expect(headers["X-UseSend-Signature"]).toMatch(/^v1=/);
      expect(headers["X-UseSend-Timestamp"]).toBeTypeOf("string");
      expect(headers["X-UseSend-Retry"]).toBe("false");
    });

    it("sets retry=true on retry attempts", async () => {
      const webhook = await makeWebhook();
      const call = await makeCall(webhook.id);
      const fetchSpy = mockFetchOk();

      await runCall(call.id, teamId, 1);

      const [, request] = fetchSpy.mock.calls[0]!;
      expect((request!.headers as Record<string, string>)["X-UseSend-Retry"]).toBe(
        "true",
      );
    });

    it("marks the call delivered and clears the failure counter", async () => {
      const webhook = await makeWebhook({ consecutiveFailures: 4 });
      const call = await makeCall(webhook.id);
      mockFetchOk();

      await runCall(call.id, teamId, 0);

      const [stored] = await drizzleDb
        .select()
        .from(schema.webhookCall)
        .where(eq(schema.webhookCall.id, call.id))
        .limit(1);
      expect(stored?.status).toBe(WebhookCallStatus.DELIVERED);
      expect(stored?.responseStatus).toBe(200);

      const [storedWebhook] = await drizzleDb
        .select()
        .from(schema.webhook)
        .where(eq(schema.webhook.id, webhook.id))
        .limit(1);
      expect(storedWebhook?.consecutiveFailures).toBe(0);
      expect(storedWebhook?.lastSuccessAt).toBeInstanceOf(Date);
    });
  });

  describe("failure handling", () => {
    it("marks the call FAILED on the sixth attempt", async () => {
      const webhook = await makeWebhook();
      const call = await makeCall(webhook.id);
      vi.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));

      await expect(runCall(call.id, teamId, 5)).rejects.toThrow("network down");

      const [stored] = await drizzleDb
        .select()
        .from(schema.webhookCall)
        .where(eq(schema.webhookCall.id, call.id))
        .limit(1);
      expect(stored?.status).toBe(WebhookCallStatus.FAILED);
      expect(stored?.attempt).toBe(6);
      expect(stored?.nextAttemptAt).toBeNull();
    });

    it("does not increment the failure counter before the final attempt", async () => {
      const webhook = await makeWebhook();
      const call = await makeCall(webhook.id);
      vi.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));

      await expect(runCall(call.id, teamId, 0)).rejects.toThrow("network down");

      const [storedWebhook] = await drizzleDb
        .select()
        .from(schema.webhook)
        .where(eq(schema.webhook.id, webhook.id))
        .limit(1);
      expect(storedWebhook?.consecutiveFailures).toBe(0);
      expect(storedWebhook?.lastFailureAt).toBeInstanceOf(Date);

      const [stored] = await drizzleDb
        .select()
        .from(schema.webhookCall)
        .where(eq(schema.webhookCall.id, call.id))
        .limit(1);
      expect(stored?.status).toBe(WebhookCallStatus.PENDING);
      expect(stored?.attempt).toBe(1);
      expect(stored?.nextAttemptAt).toBeInstanceOf(Date);
    });

    it("increments the failure counter on the final attempt", async () => {
      const webhook = await makeWebhook({ consecutiveFailures: 3 });
      const call = await makeCall(webhook.id);
      vi.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));

      await expect(runCall(call.id, teamId, 5)).rejects.toThrow("network down");

      const [storedWebhook] = await drizzleDb
        .select()
        .from(schema.webhook)
        .where(eq(schema.webhook.id, webhook.id))
        .limit(1);
      expect(storedWebhook?.consecutiveFailures).toBe(4);
      expect(storedWebhook?.status).toBe(WebhookStatus.ACTIVE);
    });

    it("auto-disables once the persisted failure count reaches the threshold", async () => {
      const webhook = await makeWebhook({ consecutiveFailures: 29 });
      const call = await makeCall(webhook.id);
      vi.spyOn(global, "fetch").mockRejectedValue(new Error("endpoint 500"));

      // Auto-disabled calls stop throwing — there is nothing left to retry.
      await expect(runCall(call.id, teamId, 5)).resolves.toBeUndefined();

      const [storedWebhook] = await drizzleDb
        .select()
        .from(schema.webhook)
        .where(eq(schema.webhook.id, webhook.id))
        .limit(1);
      expect(storedWebhook?.consecutiveFailures).toBe(30);
      expect(storedWebhook?.status).toBe(WebhookStatus.AUTO_DISABLED);
    });

    it("does not auto-disable one failure short of the threshold", async () => {
      const webhook = await makeWebhook({ consecutiveFailures: 28 });
      const call = await makeCall(webhook.id);
      vi.spyOn(global, "fetch").mockRejectedValue(new Error("endpoint 500"));

      await expect(runCall(call.id, teamId, 5)).rejects.toThrow("endpoint 500");

      const [storedWebhook] = await drizzleDb
        .select()
        .from(schema.webhook)
        .where(eq(schema.webhook.id, webhook.id))
        .limit(1);
      expect(storedWebhook?.consecutiveFailures).toBe(29);
      expect(storedWebhook?.status).toBe(WebhookStatus.ACTIVE);
    });

    it("discards calls for a webhook that is not active", async () => {
      const webhook = await makeWebhook({ status: WebhookStatus.PAUSED });
      const call = await makeCall(webhook.id);
      const fetchSpy = mockFetchOk();

      await runCall(call.id, teamId, 0);

      const [stored] = await drizzleDb
        .select()
        .from(schema.webhookCall)
        .where(eq(schema.webhookCall.id, call.id))
        .limit(1);
      expect(stored?.status).toBe(WebhookCallStatus.DISCARDED);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("resets the failure counter when re-enabling a webhook", async () => {
      const webhook = await makeWebhook({
        consecutiveFailures: 12,
        status: WebhookStatus.AUTO_DISABLED,
      });

      const updated = await WebhookService.setWebhookStatus({
        id: webhook.id,
        teamId,
        status: WebhookStatus.ACTIVE,
      });

      expect(updated.status).toBe(WebhookStatus.ACTIVE);
      expect(updated.consecutiveFailures).toBe(0);
    });

    it("leaves the failure counter alone when pausing", async () => {
      const webhook = await makeWebhook({ consecutiveFailures: 12 });

      const updated = await WebhookService.setWebhookStatus({
        id: webhook.id,
        teamId,
        status: WebhookStatus.PAUSED,
      });

      expect(updated.consecutiveFailures).toBe(12);
    });
  });

  describe("domainIds validation", () => {
    async function makeDomain(name: string, ownerTeamId = teamId) {
      const [domain] = await drizzleDb
        .insert(schema.domain)
        .values(
          withUpdatedAt({
            name,
            teamId: ownerTeamId,
            publicKey: "pk",
            region: "us-east-1",
            dkimSelector: "usesend",
          }),
        )
        .returning();

      return domain!;
    }

    it("dedupes domainIds on creation", async () => {
      const a = await makeDomain("a.example.com");
      const b = await makeDomain("b.example.com");

      const created = await WebhookService.createWebhook({
        teamId,
        userId,
        url: "https://example.com/webhook",
        eventTypes: ["email.sent"],
        domainIds: [a.id, a.id, b.id],
        secret: "whsec_create",
      });

      expect(created.domainIds.sort()).toEqual([a.id, b.id].sort());
      expect(created.status).toBe(WebhookStatus.ACTIVE);
      expect(created.createdByUserId).toBe(userId);
    });

    it("rejects creation when a domain belongs to another team", async () => {
      const mine = await makeDomain("mine.example.com");
      const otherTeam = await createTeam({ name: "other" });
      const theirs = await makeDomain("theirs.example.com", otherTeam.id);

      await expect(
        WebhookService.createWebhook({
          teamId,
          userId,
          url: "https://example.com/webhook",
          eventTypes: ["email.sent"],
          domainIds: [mine.id, theirs.id],
          secret: "whsec_create",
        }),
      ).rejects.toThrow("One or more domains were not found");

      expect(await drizzleDb.$count(schema.webhook, eq(schema.webhook.teamId, teamId))).toBe(
        0,
      );
    });

    it("preserves existing domainIds when omitted on update", async () => {
      const a = await makeDomain("keep.example.com");
      const webhook = await makeWebhook({ domainIds: [a.id] });

      const updated = await WebhookService.updateWebhook({
        id: webhook.id,
        teamId,
        url: "https://new.example.com/webhook",
      });

      expect(updated.url).toBe("https://new.example.com/webhook");
      expect(updated.domainIds).toEqual([a.id]);
    });

    it("rejects an update naming another team's domain", async () => {
      const webhook = await makeWebhook();
      const otherTeam = await createTeam({ name: "other2" });
      const theirs = await makeDomain("nope.example.com", otherTeam.id);

      await expect(
        WebhookService.updateWebhook({
          id: webhook.id,
          teamId,
          domainIds: [theirs.id],
        }),
      ).rejects.toThrow("One or more domains were not found");
    });
  });

  describe("emit filtering", () => {
    const payload = {
      id: "email_1",
      status: "delivered",
      from: "from@example.com",
      to: ["to@example.com"],
      occurredAt: new Date().toISOString(),
      subject: "Hello",
      metadata: {},
    };

    it("delivers to webhooks subscribed to the event and to catch-alls", async () => {
      const subscribed = await makeWebhook({
        eventTypes: ["email.delivered"],
      });
      const catchAll = await makeWebhook({ eventTypes: [] });
      const unrelated = await makeWebhook({ eventTypes: ["email.bounced"] });

      await WebhookService.emit(teamId, "email.delivered", payload as never);

      const calls = await drizzleDb
        .select()
        .from(schema.webhookCall)
        .where(eq(schema.webhookCall.teamId, teamId));
      const targets = calls.map((c) => c.webhookId).sort();
      expect(targets).toEqual([subscribed.id, catchAll.id].sort());
      expect(targets).not.toContain(unrelated.id);
      // Two webhooks matched, so two dispatchers were handed a call. The
      // delivery itself is the object's alarm, which does not run here.
      await expect(pendingWebhookDeliveries()).resolves.toBe(2);
    });

    it("filters by domain when the event carries one", async () => {
      const global_ = await makeWebhook({ domainIds: [] });
      const scopedMatch = await makeWebhook({ domainIds: [42] });
      const scopedOther = await makeWebhook({ domainIds: [99] });

      await WebhookService.emit(teamId, "email.delivered", payload as never, {
        domainId: 42,
      });

      const calls = await drizzleDb
        .select()
        .from(schema.webhookCall)
        .where(eq(schema.webhookCall.teamId, teamId));
      const targets = calls.map((c) => c.webhookId).sort();
      expect(targets).toEqual([global_.id, scopedMatch.id].sort());
      expect(targets).not.toContain(scopedOther.id);
    });

    it("ignores domain scoping when the event has no domain", async () => {
      const global_ = await makeWebhook({ domainIds: [] });
      const scoped = await makeWebhook({ domainIds: [42] });

      await WebhookService.emit(teamId, "email.delivered", payload as never, {
        domainId: null,
      });

      const calls = await drizzleDb
        .select()
        .from(schema.webhookCall)
        .where(eq(schema.webhookCall.teamId, teamId));
      expect(calls.map((c) => c.webhookId).sort()).toEqual(
        [global_.id, scoped.id].sort(),
      );
    });

    it("skips webhooks that are not active", async () => {
      await makeWebhook({ status: WebhookStatus.PAUSED });
      await makeWebhook({ status: WebhookStatus.AUTO_DISABLED });
      const active = await makeWebhook();

      await WebhookService.emit(teamId, "email.delivered", payload as never);

      const calls = await drizzleDb
        .select()
        .from(schema.webhookCall)
        .where(eq(schema.webhookCall.teamId, teamId));
      expect(calls.map((c) => c.webhookId)).toEqual([active.id]);
    });

    it("does not deliver to another team's webhooks", async () => {
      const mine = await makeWebhook();
      const otherTeam = await createTeam({ name: "other3" });
      await drizzleDb.insert(schema.webhook).values(
        withUpdatedAt({
          id: "wh_other",
          teamId: otherTeam.id,
          url: "https://other.example.com/webhook",
          secret: "s",
          eventTypes: ["email.delivered"],
          status: WebhookStatus.ACTIVE,
        }),
      );

      await WebhookService.emit(teamId, "email.delivered", payload as never);

      const calls = await drizzleDb.select().from(schema.webhookCall);
      expect(calls.map((c) => c.webhookId)).toEqual([mine.id]);
    });
  });

  describe("call listing", () => {
    it("paginates by cursor without repeating or dropping rows", async () => {
      const webhook = await makeWebhook();
      const base = Date.now();
      for (let i = 0; i < 5; i++) {
        await drizzleDb.insert(schema.webhookCall).values(
          withUpdatedAt({
            id: `call_page_${i}`,
            webhookId: webhook.id,
            teamId,
            type: "email.delivered",
            payload: "{}",
            status: WebhookCallStatus.PENDING,
            attempt: 0,
            // Identical timestamps, so the tie-break has to carry ordering.
            createdAt: new Date(base),
          }),
        );
      }

      const first = await WebhookService.listWebhookCalls({ teamId, limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).toBeTruthy();

      const second = await WebhookService.listWebhookCalls({
        teamId,
        limit: 2,
        cursor: first.nextCursor!,
      });

      const seen = [...first.items, ...second.items].map((c) => c.id);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it("returns a call with its webhook apiVersion attached", async () => {
      const webhook = await makeWebhook({ apiVersion: "2026-01-01" });
      const call = await makeCall(webhook.id);

      const found = await WebhookService.getWebhookCall({
        id: call.id,
        teamId,
      });

      expect(found.id).toBe(call.id);
      expect(found.webhook.apiVersion).toBe("2026-01-01");
    });

    it("will not return another team's call", async () => {
      const webhook = await makeWebhook();
      const call = await makeCall(webhook.id);
      const otherTeam = await createTeam({ name: "other4" });

      await expect(
        WebhookService.getWebhookCall({ id: call.id, teamId: otherTeam.id }),
      ).rejects.toThrow("Webhook call not found");
    });
  });
});
