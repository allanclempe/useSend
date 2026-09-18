import { createFileRoute } from "@tanstack/react-router";

import { Spinner } from "@usesend/ui/src/spinner";

import { contactQueries } from "~/queries/contacts";
import { DoubleOptInEditor } from "./-double-opt-in-editor";

/**
 * `/contacts/$contactBookId/double-opt-in`.
 *
 * `ssr: false` for the same reason as the template editor: this is the same
 * TipTap editor, and TipTap's `useEditor` returns `null` outside a browser, so
 * server-rendering it costs the isolate a ProseMirror evaluation to produce an
 * empty frame.
 *
 * The loader still runs on the client before the component, so the editor
 * mounts with its content. A contact book that does not exist, or belongs to
 * another team, fails the loader with `NOT_FOUND` and reaches the catch
 * boundary -- the Next.js page rendered "Failed to load double opt-in
 * settings" in place instead.
 */
export const Route = createFileRoute(
  "/_dashboard/contacts/$contactBookId/double-opt-in",
)({
  ssr: false,
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(
      contactQueries.bookDetail(params.contactBookId),
    ),
  pendingComponent: () => (
    <div className="flex h-full items-center justify-center">
      <Spinner className="h-6 w-6" />
    </div>
  ),
  component: DoubleOptInPage,
});

function DoubleOptInPage() {
  const contactBook = Route.useLoaderData();

  return <DoubleOptInEditor contactBook={contactBook} />;
}
