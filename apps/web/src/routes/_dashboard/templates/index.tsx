import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { H1 } from "@usesend/ui";

import { templateQueries } from "~/queries/template";
import CreateTemplate from "./-create-template";
import TemplateList from "./-template-list";

/**
 * `/templates`.
 *
 * `?page=` is the one piece of state the list has, and it belongs in the URL:
 * the Next.js version kept it in `useState` and mirrored it into the address
 * bar with `history.replaceState`, so reloading page 3 showed page 1. An
 * unparseable page falls back to the first rather than erroring — the value
 * comes from a URL bar.
 */
const searchSchema = z.object({
  page: z.coerce.number().int().positive().catch(1),
});

export const Route = createFileRoute("/_dashboard/templates/")({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => ({ page: search.page }),
  loader: ({ context, deps }) =>
    context.queryClient.ensureQueryData(templateQueries.list(deps.page)),
  component: TemplatesPage,
});

function TemplatesPage() {
  return (
    <div>
      <div className="flex items-center justify-between">
        <H1>Templates</H1>
        <CreateTemplate />
      </div>
      <TemplateList />
    </div>
  );
}
