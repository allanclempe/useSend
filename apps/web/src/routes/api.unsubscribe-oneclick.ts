import { createFileRoute } from "@tanstack/react-router";

import { handleOneClickUnsubscribe } from "~/server/editor-routes";

/**
 * The RFC 8058 one-click endpoint named in `List-Unsubscribe-Post` on every
 * campaign already delivered. The URL cannot move.
 */
export const Route = createFileRoute("/api/unsubscribe-oneclick")({
  server: {
    handlers: {
      POST: ({ request }) => handleOneClickUnsubscribe(request),
    },
  },
});
