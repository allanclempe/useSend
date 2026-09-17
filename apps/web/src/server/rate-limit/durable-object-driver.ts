import { getWorkerBindings } from "../worker-bindings";
import type { RateLimiter, RateLimiterNamespace } from "./types";

const BINDING = "RATE_LIMITER";

/**
 * One Durable Object per bucket. The object id *is* the bucket name, so a
 * team's counter and an IP's counter are different objects and cannot contend.
 *
 * Cloudflare places an object near whichever colo first asked for it and leaves
 * it there, which is the right default: a team's traffic mostly comes from one
 * place, and the object follows the traffic that created it.
 */
export const durableObjectRateLimiter: RateLimiter = {
  name: "durable-object",

  async consume(bucket, window) {
    const namespace = getWorkerBindings()?.[BINDING] as
      RateLimiterNamespace | undefined;

    if (!namespace) {
      throw new Error(
        `No ${BINDING} Durable Object binding. Bindings are only readable ` +
          "inside a handler, so this is either a call made outside " +
          "`withWorkerBindings` or a missing binding in wrangler.jsonc — " +
          "`binding-registry.unit.test.ts` covers the second case.",
      );
    }

    const stub = namespace.get(namespace.idFromName(bucket));
    return await stub.consume(window.limit, window.windowSeconds);
  },
};
