import { getWorkerBindings } from "../worker-bindings";
import {
  idempotencyScope,
  type IdempotencyKeeperNamespace,
  type IdempotencyStore,
} from "./types";

const BINDING = "IDEMPOTENCY_KEEPER";

function stub(teamId: number, key: string) {
  const namespace = getWorkerBindings()?.[BINDING] as
    IdempotencyKeeperNamespace | undefined;

  if (!namespace) {
    throw new Error(
      `No ${BINDING} Durable Object binding. Bindings are only readable ` +
        "inside a handler, so this is either a call made outside " +
        "`withWorkerBindings` or a missing binding in wrangler.jsonc — " +
        "`binding-registry.unit.test.ts` covers the second case.",
    );
  }

  return namespace.get(namespace.idFromName(idempotencyScope(teamId, key)));
}

/**
 * One Durable Object per `teamId` + `Idempotency-Key`.
 *
 * Object ids are cheap and this is the right granularity: two different keys
 * never contend, and two callers of the *same* key are exactly the pair this
 * exists to serialise.
 *
 * The keys are client-supplied and therefore unbounded, which is why this is
 * the one Durable Object here that does clean up after itself — see the alarm
 * in `src/worker/idempotency-keeper.ts`.
 */
export const durableObjectIdempotencyStore: IdempotencyStore = {
  name: "durable-object",

  async begin(teamId, key, bodyHash) {
    return await stub(teamId, key).begin(bodyHash);
  },

  async complete(teamId, key, bodyHash, emailIds) {
    await stub(teamId, key).complete(bodyHash, emailIds);
  },

  async abandon(teamId, key) {
    await stub(teamId, key).abandon();
  },
};
