import { isWorkersRuntime } from "../runtime";
import { durableObjectIdempotencyStore } from "./durable-object-driver";
import { redisIdempotencyStore } from "./redis-driver";
import type { IdempotencyStore } from "./types";

export * from "./types";

/**
 * The active idempotency store: a Durable Object inside a Worker, Redis under
 * Node. Phase 10 (#12) deletes the Redis half.
 */
export const idempotencyStore: IdempotencyStore = isWorkersRuntime()
  ? durableObjectIdempotencyStore
  : redisIdempotencyStore;
