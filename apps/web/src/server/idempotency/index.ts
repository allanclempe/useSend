import { durableObjectIdempotencyStore } from "./durable-object-driver";
import type { IdempotencyStore } from "./types";

export * from "./types";

/**
 * The idempotency store: one Durable Object per `teamId` + key. Redis is gone
 * (#12).
 */
export const idempotencyStore: IdempotencyStore = durableObjectIdempotencyStore;
