import type { KVNamespace } from "@cloudflare/workers-types";

import { getWorkerBindings } from "../worker-bindings";
import { CACHE_BINDING } from "../binding-registry";
import type { CacheStore } from "./types";

/**
 * Workers KV's floor for `expirationTtl`. Anything shorter is rejected by the
 * API, so the driver raises it rather than letting a 30-second cache become a
 * runtime error a long way from the call site.
 *
 * Which is also the honest answer to "how fresh is this cache": KV cannot
 * express anything tighter than a minute, and reads are served from a colo edge
 * cache whose own TTL defaults to the same 60 seconds. A caller asking for 30
 * gets 60, and a caller asking for 120 gets somewhere between 120 and 180.
 */
const KV_MIN_EXPIRATION_TTL_SECONDS = 60;

function namespace(): KVNamespace {
  const bindings = getWorkerBindings();
  const kv = bindings?.[CACHE_BINDING] as KVNamespace | undefined;

  if (!kv) {
    throw new Error(
      `No ${CACHE_BINDING} KV binding. Bindings are only readable inside a ` +
        "handler, so this is either a call made outside `withWorkerBindings` " +
        `or a missing \`kv_namespaces\` entry in wrangler.jsonc — ` +
        "`binding-registry.unit.test.ts` covers the second case.",
    );
  }

  return kv;
}

function expirationTtl(ttlSeconds: number | undefined) {
  if (ttlSeconds === undefined) {
    return undefined;
  }
  return Math.max(KV_MIN_EXPIRATION_TTL_SECONDS, Math.ceil(ttlSeconds));
}

/**
 * The Workers KV cache driver.
 *
 * Two behaviours differ from Redis and neither is a bug to be fixed later:
 *
 * - **Deletes are eventually consistent too.** `TeamService.invalidateTeamCache`
 *   used to make the next read miss; on KV it makes the next read miss *within
 *   about a minute*. The window is bounded by the same 60 seconds as everything
 *   else here, and it is shorter than the 120-second TTL the entry would have
 *   expired under anyway.
 * - **Negative lookups are cached.** A `get` that misses can keep missing for up
 *   to 60 seconds after a `put` of the same key. `add` is approximate for
 *   exactly this reason — see `CacheStore.add`.
 */
export const kvCacheStore: CacheStore = {
  name: "workers-kv",

  async get(key) {
    return await namespace().get(key, "text");
  },

  async put(key, value, options) {
    const ttl = expirationTtl(options?.ttlSeconds);
    await namespace().put(key, value, ttl ? { expirationTtl: ttl } : undefined);
  },

  async add(key, value, options) {
    const kv = namespace();
    const existing = await kv.get(key, "text");

    if (existing !== null) {
      return false;
    }

    await kv.put(key, value, {
      expirationTtl: expirationTtl(options.ttlSeconds)!,
    });
    return true;
  },

  async delete(...keys) {
    const kv = namespace();
    // KV has no multi-delete. These are one or three keys at a call site, not a
    // page, so the subrequest cost is bounded and known.
    await Promise.all(keys.map((key) => kv.delete(key)));
  },
};
