import { createHmac, timingSafeEqual } from "crypto";
import { env } from "~/env";

/**
 * Hashing for API keys.
 *
 * **Keyed HMAC-SHA256, not scrypt (issue #48).** scrypt is deliberately
 * expensive because it is built for *low-entropy* secrets — human-chosen
 * passwords, where suppressing an attacker's guess rate is the entire point. An
 * API key is not that. `addApiKey` mints it from `randomBytes(16)`, so there are
 * 128 bits of uniform randomness and nothing to brute-force: the work factor
 * buys no security and cost 18.7 CPU-ms on *every* public-API request,
 * synchronously, 97% of the CPU of a transactional send.
 *
 * It survives the platform move: ~14ms measured inside a real `workerd`
 * isolate, against a **10ms Free-tier CPU budget per request**. One hash
 * exceeded the whole request's allowance, at the authentication step, before any
 * work happened. Caching could not fix that — every cold isolate is a cache
 * miss, so the p99 stays over the ceiling however good the hit rate is. Only
 * changing the primitive removes the floor.
 *
 * HMAC-SHA256 over the token, keyed by `API_KEY_HMAC_SECRET`, is the right
 * primitive for a high-entropy token: a few microseconds, and an attacker who
 * steals the database still cannot derive a token without the server secret —
 * which is the property a bare SHA-256 would lose and scrypt's salt was standing
 * in for.
 *
 * There is deliberately no cache. A keyed hash is cheap enough not to need one,
 * and skipping it means **revocation is immediate**: every request still reads
 * the key row, so a deleted key fails on the very next request with no window.
 *
 * Two consequences worth knowing:
 *
 * - The hash is deterministic, so identical tokens produce identical stored
 *   hashes. Irrelevant at 128 bits of entropy — a collision means the same token
 *   was minted twice — and it is what would let a future lookup go straight to
 *   `tokenHash` instead of `clientId`.
 * - Rotating `API_KEY_HMAC_SECRET` invalidates every existing API key. That is
 *   the correct blast radius for a compromised server secret, but it is not a
 *   routine operation.
 *
 * Stored as `hmac-sha256:<hex>`. The scheme prefix makes the format
 * self-describing, so a future change can be told apart from this one rather
 * than being inferred from a length.
 */
const HASH_SCHEME = "hmac-sha256";

function digest(key: string): Buffer {
  return createHmac("sha256", env.API_KEY_HMAC_SECRET)
    .update(key, "utf8")
    .digest();
}

export const createSecureHash = async (key: string) => {
  return `${HASH_SCHEME}:${digest(key).toString("hex")}`;
};

export const verifySecureHash = async (key: string, hash: string) => {
  const [scheme, storedHex] = hash.split(":");

  if (scheme !== HASH_SCHEME || !storedHex) {
    return false;
  }

  const stored = Buffer.from(storedHex, "hex");
  const computed = digest(key);

  // `timingSafeEqual` throws on a length mismatch, and `Buffer.from(hex)`
  // silently truncates rather than throwing on malformed input, so the length
  // has to be checked first. It leaks only the stored hash's length, which is
  // fixed by the scheme.
  if (stored.length !== computed.length) {
    return false;
  }

  // Constant-time. The previous implementation compared hex *strings* with
  // `===`, which short-circuits on the first differing character — a timing
  // oracle that was only ever hidden by scrypt dominating the measurement.
  return timingSafeEqual(stored, computed);
};
