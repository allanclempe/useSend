import { createFileRoute } from "@tanstack/react-router";

import {
  handleToHtmlPreflight,
  handleToHtmlRequest,
} from "~/server/editor-routes";

export const Route = createFileRoute("/api/to-html")({
  server: {
    handlers: {
      POST: ({ request }) => handleToHtmlRequest(request),
      OPTIONS: () => handleToHtmlPreflight(),
    },
  },
});
