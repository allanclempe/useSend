import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "~/env";
import { getWorkerBindings } from "~/server/worker-bindings";

/**
 * Object storage, on the native R2 binding.
 *
 * The S3 client and its presigner are gone (§7, decision 4). A presigned URL
 * only existed to let the browser PUT straight at the bucket without the
 * server's credentials; an R2 binding has no URL to presign, so the Worker
 * proxies the upload instead and this module issues a short-lived signed URL
 * pointing at that route. Same two-step flow the callers already use —
 * `generateImagePresignedUrl` still returns an upload URL and a public URL.
 *
 * Storage is therefore a Worker capability. Under Node there is no binding and
 * `isStorageConfigured()` is false, which the dashboard already handles: both
 * editors take `imageUploadSupported` and hide the file picker when it is off.
 */

export const STORAGE_PREFIX = "/storage/";

/** Long enough to pick a file and upload it, short enough to be uninteresting. */
const UPLOAD_URL_TTL_SECONDS = 3600;

export const isStorageConfigured = () => !!getWorkerBindings()?.STORAGE;

function requireBucket() {
  const bucket = getWorkerBindings()?.STORAGE;
  if (!bucket) {
    throw new Error(
      "R2 is not configured: the STORAGE binding is only available inside a Worker",
    );
  }
  return bucket;
}

/**
 * Unlike the unsubscribe hashes in `campaign-service.ts`, these signatures live
 * for an hour, so rotating `APP_SECRET` only costs in-flight uploads here. The
 * secret is shared, though, so rotation is still governed by those.
 */
function signingSecret() {
  if (!env.APP_SECRET) {
    throw new Error("APP_SECRET is required to sign upload URLs");
  }
  return env.APP_SECRET;
}

function sign(key: string, contentType: string, expiresAt: number) {
  return createHmac("sha256", signingSecret())
    .update(`${key}\n${contentType}\n${expiresAt}`)
    .digest("hex");
}

/**
 * The public origin objects are served from. The Worker serves both the API and
 * `/storage/*`, so this is the same origin the dashboard already talks to.
 */
function baseUrl() {
  return env.APP_URL.replace(/\/$/, "");
}

/** A one-shot URL the browser can `PUT` a file to. */
export const getDocumentUploadUrl = async (
  key: string,
  fileType: string,
): Promise<string> => {
  requireBucket();

  const expiresAt = Math.floor(Date.now() / 1000) + UPLOAD_URL_TTL_SECONDS;
  const params = new URLSearchParams({
    contentType: fileType,
    expires: String(expiresAt),
    signature: sign(key, fileType, expiresAt),
  });

  return `${baseUrl()}${STORAGE_PREFIX}${key}?${params.toString()}`;
};

/** Where the object will be readable once uploaded. */
export const getDocumentUrl = (key: string): string =>
  `${baseUrl()}${STORAGE_PREFIX}${key}`;

export type UploadAuthorization =
  | { ok: true }
  | { ok: false; status: 400 | 403; reason: string };

export function authorizeUpload(
  key: string,
  url: URL,
  now = Date.now(),
): UploadAuthorization {
  const contentType = url.searchParams.get("contentType");
  const expires = Number(url.searchParams.get("expires"));
  const signature = url.searchParams.get("signature");

  if (!contentType || !signature || !Number.isFinite(expires)) {
    return { ok: false, status: 400, reason: "Malformed upload URL" };
  }

  if (expires * 1000 < now) {
    return { ok: false, status: 403, reason: "Upload URL has expired" };
  }

  const expected = sign(key, contentType, expires);
  // Both are hex of the same length, so a length mismatch is already a failure
  // and `timingSafeEqual` would throw rather than return false.
  if (
    expected.length !== signature.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  ) {
    return { ok: false, status: 403, reason: "Invalid upload signature" };
  }

  return { ok: true };
}

export async function putDocument(
  key: string,
  body: ReadableStream | ArrayBuffer,
  contentType: string,
) {
  await requireBucket().put(key, body as ArrayBuffer, {
    httpMetadata: { contentType },
  });
}

export async function getDocument(key: string) {
  return requireBucket().get(key);
}
