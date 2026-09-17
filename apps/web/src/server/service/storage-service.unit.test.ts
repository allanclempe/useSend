import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorizeUpload } from "./storage-service";

/**
 * The signature in an upload URL is what the S3 presigned URL used to be: the
 * only thing standing between the public internet and a write into the bucket.
 */

const KEY = "42/logo.png";
const CONTENT_TYPE = "image/png";
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

function signedUrl(
  overrides: {
    key?: string;
    contentType?: string;
    expires?: number;
    signature?: string;
  } = {},
) {
  const key = overrides.key ?? KEY;
  const contentType = overrides.contentType ?? CONTENT_TYPE;
  const expires = overrides.expires ?? Math.floor(NOW / 1000) + 3600;
  const signature =
    overrides.signature ??
    createHmac("sha256", "test-secret")
      .update(`${key}\n${contentType}\n${expires}`)
      .digest("hex");

  const params = new URLSearchParams({
    contentType,
    expires: String(expires),
    signature,
  });
  return new URL(`https://example.com/storage/${key}?${params.toString()}`);
}

describe("authorizeUpload", () => {
  it("accepts a URL signed for this key", () => {
    expect(authorizeUpload(KEY, signedUrl(), NOW)).toEqual({ ok: true });
  });

  it("rejects a signature that has expired", () => {
    const expires = Math.floor(NOW / 1000) - 1;

    expect(authorizeUpload(KEY, signedUrl({ expires }), NOW)).toEqual({
      ok: false,
      status: 403,
      reason: "Upload URL has expired",
    });
  });

  it("rejects a forged signature", () => {
    const url = signedUrl({ signature: "0".repeat(64) });

    expect(authorizeUpload(KEY, url, NOW)).toEqual({
      ok: false,
      status: 403,
      reason: "Invalid upload signature",
    });
  });

  it("rejects a signature of the wrong length without throwing", () => {
    // `timingSafeEqual` throws on a length mismatch rather than returning false.
    const url = signedUrl({ signature: "abc" });

    expect(authorizeUpload(KEY, url, NOW)).toEqual({
      ok: false,
      status: 403,
      reason: "Invalid upload signature",
    });
  });

  it("rejects a signature issued for a different key", () => {
    const url = signedUrl({ key: "99/other.png" });

    expect(authorizeUpload(KEY, url, NOW)).toEqual({
      ok: false,
      status: 403,
      reason: "Invalid upload signature",
    });
  });

  it("rejects a signature issued for a different content type", () => {
    // The content type is written into R2's metadata, so it is signed too:
    // otherwise a URL for a PNG could upload text/html to the same key.
    const url = signedUrl({ contentType: "text/html" });
    url.searchParams.set("contentType", CONTENT_TYPE);

    expect(authorizeUpload(KEY, url, NOW)).toEqual({
      ok: false,
      status: 403,
      reason: "Invalid upload signature",
    });
  });

  it("rejects a URL with no signature at all", () => {
    const url = new URL(`https://example.com/storage/${KEY}`);

    expect(authorizeUpload(KEY, url, NOW)).toEqual({
      ok: false,
      status: 400,
      reason: "Malformed upload URL",
    });
  });
});
