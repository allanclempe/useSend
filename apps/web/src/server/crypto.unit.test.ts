import { describe, expect, it } from "vitest";
import { createHmac } from "crypto";
import { createSecureHash, verifySecureHash } from "~/server/crypto";

const TOKEN = "3f0c4b4e1d2a4e6f9a8b7c6d5e4f3a2b";

describe("crypto", () => {
  it("round-trips a token", async () => {
    const hash = await createSecureHash(TOKEN);

    expect(await verifySecureHash(TOKEN, hash)).toBe(true);
  });

  it("rejects a token that does not match", async () => {
    const hash = await createSecureHash(TOKEN);

    expect(await verifySecureHash("not-the-token", hash)).toBe(false);
  });

  it("rejects a token differing only in the last character", async () => {
    const hash = await createSecureHash(TOKEN);

    expect(await verifySecureHash(`${TOKEN.slice(0, -1)}c`, hash)).toBe(false);
  });

  it("is deterministic, so no salt has to be stored", async () => {
    expect(await createSecureHash(TOKEN)).toBe(await createSecureHash(TOKEN));
  });

  it("tags the stored hash with its scheme", async () => {
    const hash = await createSecureHash(TOKEN);

    // Self-describing on purpose: a future scheme has to be distinguishable
    // from this one rather than inferred from a length.
    expect(hash.startsWith("hmac-sha256:")).toBe(true);
    expect(hash.split(":")[1]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is keyed by the server secret, not a bare digest of the token", async () => {
    const hash = await createSecureHash(TOKEN);
    const unkeyed = createHmac("sha256", "").update(TOKEN, "utf8").digest("hex");

    // An attacker holding the database still needs API_KEY_HMAC_SECRET.
    expect(hash.split(":")[1]).not.toBe(unkeyed);
  });

  it("rejects a hash stored under a different scheme", async () => {
    const hex = (await createSecureHash(TOKEN)).split(":")[1]!;

    expect(await verifySecureHash(TOKEN, `scrypt:${hex}`)).toBe(false);
  });

  it("rejects a malformed hash rather than throwing", async () => {
    // `timingSafeEqual` throws on a length mismatch, and `Buffer.from(hex)`
    // truncates malformed input silently, so both have to be handled.
    for (const hash of [
      "",
      "hmac-sha256:",
      "hmac-sha256:zzzz",
      "hmac-sha256:ab",
      "no-colon-at-all",
    ]) {
      await expect(verifySecureHash(TOKEN, hash)).resolves.toBe(false);
    }
  });
});
