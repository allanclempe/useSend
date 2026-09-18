import { createFileRoute } from "@tanstack/react-router";

import { Spinner } from "@usesend/ui/src/spinner";

import { templateQueries } from "~/queries/template";
import TemplateEditor from "./-template-editor";

/**
 * `/templates/$templateId/edit`.
 *
 * **This route does not server-render.** `@usesend/email-editor` is TipTap, and
 * TipTap refuses to build an editor outside a browser — `useEditor` detects SSR
 * and returns `null` — so the server could only ever emit an empty frame, after
 * paying to evaluate ProseMirror, tippy.js and a drag-handle plugin that reach
 * for `document` inside the Worker isolate. `ssr: false` says that once, here,
 * where the next person reading the route can see it; the alternative is an
 * `isMounted` flag in the component, which hides the same fact in a place that
 * looks like a rendering bug.
 *
 * The loader still runs — on the client, before the component — so the editor
 * mounts with its content already in hand rather than flashing an empty
 * document. A template that does not exist throws from the loader and reaches
 * the error boundary, instead of the "Failed to load template" line the
 * Next.js page rendered in place.
 */
export const Route = createFileRoute("/_dashboard/templates/$templateId/edit")({
  ssr: false,
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(
      templateQueries.detail(params.templateId),
    ),
  pendingComponent: () => (
    <div className="flex h-full items-center justify-center">
      <Spinner className="h-6 w-6" />
    </div>
  ),
  component: EditTemplatePage,
});

function EditTemplatePage() {
  const { templateId } = Route.useParams();

  return <TemplateEditor templateId={templateId} />;
}
