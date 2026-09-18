import { createFileRoute } from "@tanstack/react-router";

import { handleEmailPreviewRequest } from "~/server/email-templates/preview";

export const Route = createFileRoute("/api/dev/email-preview")({
  server: {
    handlers: {
      GET: ({ request }) => handleEmailPreviewRequest(request),
    },
  },
});
