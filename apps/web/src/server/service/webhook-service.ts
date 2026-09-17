import { WebhookCallStatus, WebhookStatus } from "~/types/db";
import { createHmac, randomBytes } from "crypto";
import {
  WebhookEventData,
  WebhookPayloadData,
  WEBHOOK_EVENT_VERSION,
  type WebhookEvent,
  type WebhookEventPayloadMap,
  type WebhookEventType,
} from "@usesend/lib/src/webhook/webhook-events";
import {
  and,
  arrayContains,
  desc,
  eq,
  inArray,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { drizzleDb, schema } from "../drizzle";
import { createId } from "../drizzle/id";
import { withUpdatedAt } from "../drizzle/touch";
import { currentTraceparent } from "../logger/trace-context";
import {
  createQueue,
  createWorker,
  createWorkerHandler,
  WEBHOOK_DISPATCH_QUEUE,
  type TeamJob,
} from "../queue";
import { isWorkersRuntime } from "../runtime";
import { getWorkerBindings } from "../worker-bindings";
import { logger } from "../logger/log";
import { LimitService } from "./limit-service";
import { UnsendApiError } from "../public-api/api-error";

/**
 * One delivery at a time, and the reason is ordering rather than load.
 *
 * A webhook endpoint is told about events in the order they happened, which
 * used to be enforced by a Redis `SET NX PX` lock per `webhookId` plus a Lua
 * release and a retry path for losing the race. On Workers that lock is
 * replaced by a Durable Object per `webhookId`, which is single-threaded by
 * construction (§3). Under Node the same property comes from running the
 * dispatch worker at concurrency 1 — a stronger guarantee than the lock gave,
 * since it serialises globally, and a slower one, which is the trade. Node is
 * on its way out and the lock is not worth keeping alive for it.
 */
const WEBHOOK_DISPATCH_CONCURRENCY = 1;
export const WEBHOOK_MAX_ATTEMPTS = 6;
const WEBHOOK_BASE_BACKOFF_MS = 5_000;
const WEBHOOK_AUTO_DISABLE_THRESHOLD = 30;
const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000;
const WEBHOOK_RESPONSE_TEXT_LIMIT = 4_096;

type WebhookCallJobData = {
  callId: string;
  teamId?: number;
};

type WebhookCallJob = TeamJob<WebhookCallJobData>;

type WebhookEventInput<TType extends WebhookEventType> =
  WebhookPayloadData<TType>;

/**
 * The BullMQ half. Absent inside a Worker, where dispatch is a Durable Object
 * and there is no `webhook-dispatch` queue to create or consume.
 */
const dispatchQueue = isWorkersRuntime()
  ? undefined
  : createQueue<WebhookCallJobData>(WEBHOOK_DISPATCH_QUEUE, {
      attempts: WEBHOOK_MAX_ATTEMPTS,
      backoff: {
        type: "exponential",
        delay: WEBHOOK_BASE_BACKOFF_MS,
      },
    });

if (dispatchQueue) {
  createWorker(WEBHOOK_DISPATCH_QUEUE, createWorkerHandler(processWebhookCall), {
    concurrency: WEBHOOK_DISPATCH_CONCURRENCY,
    onError: (error) => {
      logger.error({ error }, "[WebhookQueueService]: Worker error");
    },
  });
}

export class WebhookQueueService {
  /**
   * Hands a call to whatever delivers webhooks in this runtime.
   *
   * `webhookId` is new in the signature and is the whole point: it is the
   * Durable Object's name, so every call for one webhook lands on one object
   * and is delivered in order. Every caller already had it — `emit` from the
   * webhook row it just matched, `retryCall` from the call row it just read.
   */
  public static async enqueueCall(
    callId: string,
    webhookId: string,
    teamId: number,
  ) {
    const dispatcher = getWorkerBindings()?.WEBHOOK_DISPATCHER as
      | WebhookDispatcherNamespace
      | undefined;

    if (dispatcher) {
      const stub = dispatcher.get(dispatcher.idFromName(webhookId));
      // The trace does not ride on a message body here — there is no message —
      // so it is passed explicitly, the way the queue seam does it implicitly.
      await stub.deliver(callId, teamId, currentTraceparent() ?? null);
      return;
    }

    if (!dispatchQueue) {
      throw new Error(
        "Webhook dispatch has nowhere to go: no WEBHOOK_DISPATCHER binding and no BullMQ queue. " +
          "Declare the Durable Object in wrangler.jsonc.",
      );
    }

    await dispatchQueue.enqueue(callId, { callId, teamId });
  }
}

/**
 * The Durable Object binding, typed structurally.
 *
 * The class itself lives in `src/worker/webhook-dispatcher.ts` and extends
 * `DurableObject` from `cloudflare:workers`, which must never reach a module
 * Next.js bundles — and this one is imported all over the dashboard. A
 * structural type needs no import and describes exactly what is called.
 */
/* eslint-disable no-unused-vars -- parameter names in a type signature */
type WebhookDispatcherNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): {
    deliver(
      callId: string,
      teamId: number,
      traceparent: string | null,
    ): Promise<void>;
  };
};
/* eslint-enable no-unused-vars */

export class WebhookService {
  public static async emit<TType extends WebhookEventType>(
    teamId: number,
    type: TType,
    payload: WebhookEventInput<TType>,
    options?: { domainId?: number | null },
  ) {
    // Prisma's array operators: `has` is `@>` on a one-element array, and
    // `isEmpty` has no Drizzle helper, so it is cardinality().
    const domainFilter =
      options?.domainId == null
        ? undefined
        : or(
            sql`cardinality(${schema.webhook.domainIds}) = 0`,
            arrayContains(schema.webhook.domainIds, [options.domainId]),
          );

    const activeWebhooks = await drizzleDb
      .select()
      .from(schema.webhook)
      .where(
        and(
          eq(schema.webhook.teamId, teamId),
          eq(schema.webhook.status, WebhookStatus.ACTIVE),
          or(
            arrayContains(schema.webhook.eventTypes, [type]),
            sql`cardinality(${schema.webhook.eventTypes}) = 0`,
          ),
          domainFilter,
        ),
      );

    if (activeWebhooks.length === 0) {
      logger.debug(
        { teamId, type },
        "[WebhookService]: No active webhooks for event type",
      );
      return;
    }

    const payloadString = stringifyPayload(payload);

    for (const webhook of activeWebhooks) {
      const [call] = await drizzleDb
        .insert(schema.webhookCall)
        .values(
          withUpdatedAt({
            id: createId(),
            webhookId: webhook.id,
            teamId: webhook.teamId,
            type: type,
            payload: payloadString,
            status: WebhookCallStatus.PENDING,
            attempt: 0,
          }),
        )
        .returning();

      if (!call) {
        throw new Error("Failed to create webhook call");
      }

      await WebhookQueueService.enqueueCall(call.id, webhook.id, webhook.teamId);
    }
  }

  public static async retryCall(params: { callId: string; teamId: number }) {
    const [call] = await drizzleDb
      .select()
      .from(schema.webhookCall)
      .where(
        and(
          eq(schema.webhookCall.id, params.callId),
          eq(schema.webhookCall.teamId, params.teamId),
        ),
      )
      .limit(1);

    if (!call) {
      throw new Error("Webhook call not found");
    }

    await drizzleDb
      .update(schema.webhookCall)
      .set(
        withUpdatedAt({
          status: WebhookCallStatus.PENDING,
          attempt: 0,
          nextAttemptAt: null,
          lastError: null,
          responseStatus: null,
          responseTimeMs: null,
          responseText: null,
        }),
      )
      .where(eq(schema.webhookCall.id, call.id));

    await WebhookQueueService.enqueueCall(call.id, call.webhookId, params.teamId);

    return call.id;
  }

  public static async testWebhook(params: {
    webhookId: string;
    teamId: number;
  }) {
    const [webhook] = await drizzleDb
      .select()
      .from(schema.webhook)
      .where(
        and(
          eq(schema.webhook.id, params.webhookId),
          eq(schema.webhook.teamId, params.teamId),
        ),
      )
      .limit(1);

    if (!webhook) {
      throw new Error("Webhook not found");
    }

    const payload = {
      test: true,
      webhookId: webhook.id,
      sentAt: new Date().toISOString(),
    };

    const [call] = await drizzleDb
      .insert(schema.webhookCall)
      .values(
        withUpdatedAt({
          id: createId(),
          webhookId: webhook.id,
          teamId: webhook.teamId,
          type: "webhook.test",
          payload: stringifyPayload(payload),
          status: WebhookCallStatus.PENDING,
          attempt: 0,
        }),
      )
      .returning();

    if (!call) {
      throw new Error("Failed to create webhook call");
    }

    await WebhookQueueService.enqueueCall(call.id, webhook.id, webhook.teamId);

    return call.id;
  }

  public static generateSecret() {
    return `whsec_${randomBytes(32).toString("hex")}`;
  }

  public static async listWebhooks(teamId: number) {
    const rows = await drizzleDb
      .select()
      .from(schema.webhook)
      .where(eq(schema.webhook.teamId, teamId))
      .orderBy(desc(schema.webhook.createdAt));

    return rows;
  }

  public static async getWebhook(params: { id: string; teamId: number }) {
    const [webhook] = await drizzleDb
      .select()
      .from(schema.webhook)
      .where(
        and(
          eq(schema.webhook.id, params.id),
          eq(schema.webhook.teamId, params.teamId),
        ),
      )
      .limit(1);

    if (!webhook) {
      throw new UnsendApiError({
        code: "NOT_FOUND",
        message: "Webhook not found",
      });
    }

    return webhook;
  }

  public static async createWebhook(params: {
    teamId: number;
    userId: number;
    url: string;
    description?: string;
    eventTypes: string[];
    domainIds?: number[];
    secret?: string;
  }) {
    const { isLimitReached, reason } = await LimitService.checkWebhookLimit(
      params.teamId,
    );

    if (isLimitReached) {
      throw new UnsendApiError({
        code: "FORBIDDEN",
        message: reason ?? "Webhook limit reached",
      });
    }

    const normalizedDomainIds = WebhookService.normalizeDomainIds(
      params.domainIds,
    );

    if (normalizedDomainIds.length > 0) {
      await WebhookService.assertDomainsBelongToTeam(
        normalizedDomainIds,
        params.teamId,
      );
    }

    const secret = params.secret ?? WebhookService.generateSecret();

    const [created] = await drizzleDb
      .insert(schema.webhook)
      .values(
        withUpdatedAt({
          id: createId(),
          teamId: params.teamId,
          domainIds: normalizedDomainIds,
          url: params.url,
          description: params.description,
          secret,
          eventTypes: params.eventTypes,
          status: WebhookStatus.ACTIVE,
          createdByUserId: params.userId,
        }),
      )
      .returning();

    if (!created) {
      throw new UnsendApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to create webhook",
      });
    }

    return created;
  }

  public static async updateWebhook(params: {
    id: string;
    teamId: number;
    url?: string;
    description?: string | null;
    eventTypes?: string[];
    domainIds?: number[];
    rotateSecret?: boolean;
    secret?: string;
  }) {
    const [webhook] = await drizzleDb
      .select()
      .from(schema.webhook)
      .where(
        and(
          eq(schema.webhook.id, params.id),
          eq(schema.webhook.teamId, params.teamId),
        ),
      )
      .limit(1);

    if (!webhook) {
      throw new UnsendApiError({
        code: "NOT_FOUND",
        message: "Webhook not found",
      });
    }

    const secret =
      params.rotateSecret === true
        ? WebhookService.generateSecret()
        : params.secret;

    const normalizedDomainIds =
      params.domainIds === undefined
        ? undefined
        : WebhookService.normalizeDomainIds(params.domainIds);

    if (normalizedDomainIds && normalizedDomainIds.length > 0) {
      await WebhookService.assertDomainsBelongToTeam(
        normalizedDomainIds,
        params.teamId,
      );
    }

    const [updated] = await drizzleDb
      .update(schema.webhook)
      .set(
        withUpdatedAt({
          url: params.url ?? webhook.url,
          description:
            params.description === undefined
              ? webhook.description
              : (params.description ?? null),
          eventTypes: params.eventTypes ?? webhook.eventTypes,
          domainIds: normalizedDomainIds ?? webhook.domainIds,
          secret: secret ?? webhook.secret,
        }),
      )
      .where(eq(schema.webhook.id, webhook.id))
      .returning();

    if (!updated) {
      throw new UnsendApiError({
        code: "NOT_FOUND",
        message: "Webhook not found",
      });
    }

    return updated;
  }

  private static normalizeDomainIds(domainIds?: number[]) {
    if (!domainIds) {
      return [];
    }

    return Array.from(new Set(domainIds));
  }

  private static async assertDomainsBelongToTeam(
    domainIds: number[],
    teamId: number,
  ) {
    const matchingDomains = await drizzleDb
      .select({ id: schema.domain.id })
      .from(schema.domain)
      .where(
        and(
          inArray(schema.domain.id, domainIds),
          eq(schema.domain.teamId, teamId),
        ),
      );

    if (matchingDomains.length !== domainIds.length) {
      throw new UnsendApiError({
        code: "NOT_FOUND",
        message: "One or more domains were not found",
      });
    }
  }

  public static async setWebhookStatus(params: {
    id: string;
    teamId: number;
    status: WebhookStatus;
  }) {
    const [webhook] = await drizzleDb
      .select()
      .from(schema.webhook)
      .where(
        and(
          eq(schema.webhook.id, params.id),
          eq(schema.webhook.teamId, params.teamId),
        ),
      )
      .limit(1);

    if (!webhook) {
      throw new UnsendApiError({
        code: "NOT_FOUND",
        message: "Webhook not found",
      });
    }

    const [updated] = await drizzleDb
      .update(schema.webhook)
      .set(
        withUpdatedAt({
          status: params.status,
          consecutiveFailures:
            params.status === WebhookStatus.ACTIVE
              ? 0
              : webhook.consecutiveFailures,
        }),
      )
      .where(eq(schema.webhook.id, webhook.id))
      .returning();

    if (!updated) {
      throw new UnsendApiError({
        code: "NOT_FOUND",
        message: "Webhook not found",
      });
    }

    return updated;
  }

  public static async deleteWebhook(params: { id: string; teamId: number }) {
    const [webhook] = await drizzleDb
      .select()
      .from(schema.webhook)
      .where(
        and(
          eq(schema.webhook.id, params.id),
          eq(schema.webhook.teamId, params.teamId),
        ),
      )
      .limit(1);

    if (!webhook) {
      throw new UnsendApiError({
        code: "NOT_FOUND",
        message: "Webhook not found",
      });
    }

    const [deleted] = await drizzleDb
      .delete(schema.webhook)
      .where(eq(schema.webhook.id, webhook.id))
      .returning();

    if (!deleted) {
      throw new UnsendApiError({
        code: "NOT_FOUND",
        message: "Webhook not found",
      });
    }

    return deleted;
  }

  public static async listWebhookCalls(params: {
    teamId: number;
    webhookId?: string;
    status?: WebhookCallStatus;
    limit: number;
    cursor?: string;
  }) {
    // Prisma's positional `cursor` has no Drizzle equivalent, so this becomes a
    // keyset predicate. It needs the cursor row's createdAt, hence the extra
    // read.
    //
    // Ordering is now (createdAt desc, id desc) rather than createdAt alone.
    // createdAt is not unique, and under a tie the previous ordering was
    // arbitrary — which meant a page boundary landing mid-tie could repeat or
    // skip rows. The compound order is a total order, so it cannot.
    const [cursorRow] = params.cursor
      ? await drizzleDb
          .select({
            id: schema.webhookCall.id,
            createdAt: schema.webhookCall.createdAt,
          })
          .from(schema.webhookCall)
          .where(eq(schema.webhookCall.id, params.cursor))
          .limit(1)
      : [];

    const calls = await drizzleDb
      .select()
      .from(schema.webhookCall)
      .where(
        and(
          eq(schema.webhookCall.teamId, params.teamId),
          params.webhookId
            ? eq(schema.webhookCall.webhookId, params.webhookId)
            : undefined,
          params.status
            ? eq(schema.webhookCall.status, params.status)
            : undefined,
          // Inclusive of the cursor row, matching Prisma without `skip`.
          cursorRow
            ? or(
                lt(schema.webhookCall.createdAt, cursorRow.createdAt),
                and(
                  eq(schema.webhookCall.createdAt, cursorRow.createdAt),
                  sql`${schema.webhookCall.id} <= ${cursorRow.id}`,
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.webhookCall.createdAt), desc(schema.webhookCall.id))
      .limit(params.limit + 1);

    let nextCursor: string | null = null;
    if (calls.length > params.limit) {
      const next = calls.pop();
      nextCursor = next?.id ?? null;
    }

    return {
      items: calls,
      nextCursor,
    };
  }

  public static async getWebhookCall(params: { id: string; teamId: number }) {
    const [row] = await drizzleDb
      .select({
        call: schema.webhookCall,
        apiVersion: schema.webhook.apiVersion,
      })
      .from(schema.webhookCall)
      .innerJoin(
        schema.webhook,
        eq(schema.webhook.id, schema.webhookCall.webhookId),
      )
      .where(
        and(
          eq(schema.webhookCall.id, params.id),
          eq(schema.webhookCall.teamId, params.teamId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new UnsendApiError({
        code: "NOT_FOUND",
        message: "Webhook call not found",
      });
    }

    // Reshaped to Prisma's nested include so callers are unchanged.
    return { ...row.call, webhook: { apiVersion: row.apiVersion } };
  }
}

function stringifyPayload(payload: unknown) {
  if (typeof payload === "string") {
    return payload;
  }

  try {
    return JSON.stringify(payload);
  } catch (error) {
    logger.error(
      { error },
      "[WebhookService]: Failed to stringify payload, falling back to empty object",
    );
    return "{}";
  }
}

export async function processWebhookCall(job: WebhookCallJob) {
  const attempt = job.attemptsMade + 1;
  const [row] = await drizzleDb
    .select({ call: schema.webhookCall, webhook: schema.webhook })
    .from(schema.webhookCall)
    .innerJoin(
      schema.webhook,
      eq(schema.webhook.id, schema.webhookCall.webhookId),
    )
    .where(eq(schema.webhookCall.id, job.data.callId))
    .limit(1);

  const call = row ? { ...row.call, webhook: row.webhook } : undefined;

  if (!call) {
    logger.warn(
      { callId: job.data.callId },
      "[WebhookQueueService]: Call not found",
    );
    return;
  }

  if (call.webhook.status !== WebhookStatus.ACTIVE) {
    await drizzleDb
      .update(schema.webhookCall)
      .set(withUpdatedAt({ status: WebhookCallStatus.DISCARDED, attempt }))
      .where(eq(schema.webhookCall.id, call.id));
    logger.info(
      { callId: call.id, webhookId: call.webhookId },
      "[WebhookQueueService]: Discarded call because webhook is not active",
    );
    return;
  }

  await drizzleDb
    .update(schema.webhookCall)
    .set(withUpdatedAt({ status: WebhookCallStatus.IN_PROGRESS, attempt }))
    .where(eq(schema.webhookCall.id, call.id));

  // No lock. Ordering per webhook is a property of where this runs, not
  // something to acquire: on Workers a Durable Object per `webhookId` is
  // single-threaded by construction, and under Node the dispatch worker runs at
  // concurrency 1. The Redis `SET NX PX`, its Lua release and the
  // lock-not-acquired retry path are gone (§3).
  try {
    const body = buildPayload(call, attempt);
    const { responseStatus, responseTimeMs, responseText } = await postWebhook({
      url: call.webhook.url,
      secret: call.webhook.secret,
      type: call.type,
      callId: call.id,
      body,
    });

    logger.info(
      `Webhook call ${call.id} completed successfully, response status: ${responseStatus}, response time: ${responseTimeMs}ms, `,
    );

    await drizzleDb.transaction(async (tx) => {
      await tx
        .update(schema.webhookCall)
        .set(
          withUpdatedAt({
            status: WebhookCallStatus.DELIVERED,
            attempt,
            responseStatus,
            responseTimeMs,
            lastError: null,
            nextAttemptAt: null,
            responseText,
          }),
        )
        .where(eq(schema.webhookCall.id, call.id));

      await tx
        .update(schema.webhook)
        .set(
          withUpdatedAt({
            consecutiveFailures: 0,
            lastSuccessAt: new Date(),
          }),
        )
        .where(eq(schema.webhook.id, call.webhookId));
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown webhook error";
    const responseStatus =
      error instanceof WebhookHttpError ? error.statusCode : null;
    const responseTimeMs =
      error instanceof WebhookHttpError ? error.responseTimeMs : null;
    const responseText =
      error instanceof WebhookHttpError ? error.responseText : null;

    const nextAttemptAt =
      attempt < WEBHOOK_MAX_ATTEMPTS
        ? new Date(Date.now() + computeBackoff(attempt))
        : null;

    const isFinalAttempt = attempt >= WEBHOOK_MAX_ATTEMPTS;

    const updatedWebhook = await drizzleDb.transaction(async (tx) => {
      const [webhookAfterFailure] = await tx
        .update(schema.webhook)
        .set(
          withUpdatedAt({
            lastFailureAt: new Date(),
            // Prisma's `{ increment: 1 }`. Done in SQL rather than read-then-write
            // so concurrent failures on the same webhook cannot lose a count.
            ...(isFinalAttempt
              ? {
                  consecutiveFailures: sql`${schema.webhook.consecutiveFailures} + 1`,
                }
              : {}),
          }),
        )
        .where(eq(schema.webhook.id, call.webhookId))
        .returning();

      if (!webhookAfterFailure) {
        throw new Error("Webhook not found");
      }

      if (
        isFinalAttempt &&
        webhookAfterFailure.status === WebhookStatus.ACTIVE &&
        webhookAfterFailure.consecutiveFailures >=
          WEBHOOK_AUTO_DISABLE_THRESHOLD
      ) {
        const [disabled] = await tx
          .update(schema.webhook)
          .set(withUpdatedAt({ status: WebhookStatus.AUTO_DISABLED }))
          .where(eq(schema.webhook.id, call.webhookId))
          .returning();

        return disabled ?? webhookAfterFailure;
      }

      return webhookAfterFailure;
    });

    await drizzleDb
      .update(schema.webhookCall)
      .set(
        withUpdatedAt({
          status:
            attempt >= WEBHOOK_MAX_ATTEMPTS
              ? WebhookCallStatus.FAILED
              : WebhookCallStatus.PENDING,
          attempt,
          nextAttemptAt,
          lastError: errorMessage,
          // Prisma read `undefined` as "leave this column alone", which is how
          // a non-HTTP failure keeps the response fields from an earlier
          // attempt. Spread conditionally rather than passing undefined.
          ...(responseStatus !== null ? { responseStatus } : {}),
          ...(responseTimeMs !== null ? { responseTimeMs } : {}),
          ...(responseText !== null ? { responseText } : {}),
        }),
      )
      .where(eq(schema.webhookCall.id, call.id));

    const statusLabel =
      updatedWebhook.status === WebhookStatus.AUTO_DISABLED
        ? "auto-disabled"
        : "failed";

    logger.warn(
      {
        callId: call.id,
        webhookId: call.webhookId,
        statusLabel,
        attempt,
        responseStatus,
        nextAttemptAt,
        error: errorMessage,
      },
      "[WebhookQueueService]: Webhook call failure",
    );

    if (updatedWebhook.status === WebhookStatus.AUTO_DISABLED) {
      return;
    }

    throw error;
  }
}

/**
 * Backoff for the next attempt, in milliseconds.
 *
 * Exported because on Workers the retry is scheduled by a Durable Object alarm
 * rather than by a queue: the delivery loop asks for the delay and re-arms.
 */
export function computeBackoff(attempt: number) {
  const base = WEBHOOK_BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
  const jitter = base * 0.3 * Math.random();
  return base + jitter;
}

type WebhookPayload = {
  id: string;
  type: string;
  version: string | null;
  createdAt: string;
  teamId: number;
  data: unknown;
  attempt: number;
};

function buildPayload(
  call: {
    id: string;
    webhookId: string;
    teamId: number;
    type: string;
    payload: string;
    createdAt: Date;
    webhook: { apiVersion: string | null };
  },
  attempt: number,
): WebhookPayload {
  let parsed: unknown = call.payload;
  try {
    parsed = JSON.parse(call.payload);
  } catch {
    // keep string payload as-is
  }

  return {
    id: call.id,
    type: call.type,
    version: call.webhook.apiVersion ?? WEBHOOK_EVENT_VERSION,
    createdAt: call.createdAt.toISOString(),
    teamId: call.teamId,
    data: parsed,
    attempt,
  };
}

class WebhookHttpError extends Error {
  public statusCode: number | null;
  public responseTimeMs: number | null;
  public responseText: string | null;

  constructor(
    message: string,
    statusCode: number | null,
    responseTimeMs: number | null,
    responseText: string | null,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.responseTimeMs = responseTimeMs;
    this.responseText = responseText;
  }
}

async function postWebhook(params: {
  url: string;
  secret: string;
  type: string;
  callId: string;
  body: WebhookPayload;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    WEBHOOK_REQUEST_TIMEOUT_MS,
  );

  const stringBody = JSON.stringify(params.body);
  const timestamp = Date.now().toString();
  const signature = signBody(params.secret, timestamp, stringBody);

  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "UseSend-Webhook/1.0",
    "X-UseSend-Event": params.type,
    "X-UseSend-Call": params.callId,
    "X-UseSend-Timestamp": timestamp,
    "X-UseSend-Signature": signature,
    "X-UseSend-Retry": params.body.attempt > 1 ? "true" : "false",
  };

  const start = Date.now();

  try {
    const response = await fetch(params.url, {
      method: "POST",
      headers,
      body: stringBody,
      redirect: "manual",
      signal: controller.signal,
    });

    const responseTimeMs = Date.now() - start;
    const responseText = await captureResponseText(response);
    if (response.ok) {
      return {
        responseStatus: response.status,
        responseTimeMs,
        responseText,
      };
    }

    throw new WebhookHttpError(
      `Non-2xx response: ${response.status}`,
      response.status,
      responseTimeMs,
      responseText,
    );
  } catch (error) {
    const responseTimeMs = Date.now() - start;
    if (error instanceof WebhookHttpError) {
      throw error;
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new WebhookHttpError(
        "Webhook request timed out",
        null,
        responseTimeMs,
        null,
      );
    }
    throw new WebhookHttpError(
      error instanceof Error ? error.message : "Unknown fetch error",
      null,
      responseTimeMs,
      null,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function signBody(secret: string, timestamp: string, body: string) {
  const hmac = createHmac("sha256", secret);
  hmac.update(`${timestamp}.${body}`);
  return `v1=${hmac.digest("hex")}`;
}

async function captureResponseText(response: Response) {
  const contentType = response.headers.get("content-type");
  const isText =
    contentType?.startsWith("text/") ||
    contentType?.includes("application/json") ||
    contentType?.includes("application/xml");

  if (!isText) {
    return null;
  }

  const contentLengthHeader = response.headers.get("content-length");
  const contentLength = contentLengthHeader
    ? Number.parseInt(contentLengthHeader, 10)
    : null;

  if (contentLength && Number.isFinite(contentLength)) {
    if (contentLength <= 0) {
      return "";
    }
    if (contentLength > WEBHOOK_RESPONSE_TEXT_LIMIT * 2) {
      return `<omitted: content-length ${contentLength} exceeds limit ${WEBHOOK_RESPONSE_TEXT_LIMIT}>`;
    }
  }

  const body = response.body;

  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let chunks = "";
    let truncated = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (value) {
        const decoded = decoder.decode(value, { stream: true });
        received += decoded.length;
        if (received > WEBHOOK_RESPONSE_TEXT_LIMIT) {
          const sliceRemaining =
            WEBHOOK_RESPONSE_TEXT_LIMIT - (received - decoded.length);
          chunks += decoded.slice(0, Math.max(0, sliceRemaining));
          truncated = true;
          await reader.cancel();
          break;
        } else {
          chunks += decoded;
        }
      }
    }

    if (truncated) {
      return `${chunks}...<truncated>`;
    }

    return chunks;
  }

  const text = await response.text();
  if (text.length > WEBHOOK_RESPONSE_TEXT_LIMIT) {
    return `${text.slice(0, WEBHOOK_RESPONSE_TEXT_LIMIT)}...<truncated>`;
  }

  return text;
}
