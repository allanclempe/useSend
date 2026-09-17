import { createFileRoute } from "@tanstack/react-router";

import { handleAuthRequest } from "~/server/auth-route";

/**
 * `/api/auth/*` — better-auth's endpoints, on the Worker.
 *
 * `$` is a splat, because better-auth routes the rest of the path itself. The
 * handler and its OTP rate limit live in `~/server/auth-route`, shared with
 * the Next.js route that serves the same path until `src/app` goes (#9).
 */
export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => handleAuthRequest(request),
      POST: ({ request }) => handleAuthRequest(request),
    },
  },
});
