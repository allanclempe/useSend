import {
  STORAGE_PREFIX,
  authorizeUpload,
  getDocument,
  putDocument,
} from "~/server/service/storage-service";

/**
 * `/storage/*` — the upload and download proxy for the R2 binding.
 *
 * Deliberately outside the Hono app: `server/public-api` is the external
 * contract and its route table and OpenAPI document should not grow a
 * dashboard-only concern that is not authenticated by API key.
 *
 * `PUT` is authorized by the signature in the URL that `getDocumentUploadUrl`
 * issued — that signature is what the S3 presigned URL used to be. `GET` is
 * public, matching the public bucket these images were served from before.
 */
export function isStorageRequest(url: URL): boolean {
  return url.pathname.startsWith(STORAGE_PREFIX);
}

export async function handleStorageRequest(
  request: Request,
  url: URL,
): Promise<Response> {
  const key = decodeURIComponent(url.pathname.slice(STORAGE_PREFIX.length));

  if (!key || key.includes("..")) {
    return new Response("Invalid key", { status: 400 });
  }

  if (request.method === "PUT") {
    const auth = authorizeUpload(key, url);
    if (!auth.ok) {
      return new Response(auth.reason, { status: auth.status });
    }

    const contentType = url.searchParams.get("contentType")!;
    await putDocument(key, await request.arrayBuffer(), contentType);

    return new Response(null, { status: 200 });
  }

  if (request.method === "GET" || request.method === "HEAD") {
    const object = await getDocument(key);
    if (!object) {
      return new Response("Not found", { status: 404 });
    }

    const headers = new Headers({
      etag: object.httpEtag,
      "cache-control": "public, max-age=31536000, immutable",
    });
    const contentType = object.httpMetadata?.contentType;
    if (contentType) {
      headers.set("content-type", contentType);
    }

    return new Response(
      request.method === "HEAD" ? null : (object.body as unknown as BodyInit),
      { headers },
    );
  }

  return new Response("Method not allowed", { status: 405 });
}
