import { createFileRoute } from "@tanstack/react-router";

import { H1 } from "@usesend/ui";

import { suppressionQueries } from "~/queries/suppression";
import AddSuppression from "./suppressions/-add-suppression";
import BulkAddSuppressions from "./suppressions/-bulk-add-suppressions";
import {
  listFilters,
  suppressionSearchSchema,
} from "./suppressions/-suppression-filters";
import SuppressionList from "./suppressions/-suppression-list";
import SuppressionStats from "./suppressions/-suppression-stats";

/**
 * `/suppressions`.
 *
 * The filters live in the URL, as they did, but they are the route's typed
 * search now rather than three `useUrlState` hooks reading `window.location`.
 * That is what lets the loader warm the *right* page of the list: `loaderDeps`
 * turns the search into the same filters object the table's query key is built
 * from, so a bookmarked `?search=…&page=3` arrives already fetched instead of
 * rendering a spinner and then asking.
 *
 * The stats are a separate query on purpose — see `queries/suppression.ts`.
 */
export const Route = createFileRoute("/_dashboard/suppressions")({
  validateSearch: suppressionSearchSchema,
  loaderDeps: ({ search }) => listFilters(search),
  loader: ({ context, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(suppressionQueries.list(deps)),
      context.queryClient.ensureQueryData(suppressionQueries.stats()),
    ]),
  component: SuppressionsPage,
});

function SuppressionsPage() {
  return (
    <div>
      <div className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <H1>Suppression List</H1>
        <div className="flex gap-2">
          <BulkAddSuppressions />
          <AddSuppression />
        </div>
      </div>

      <SuppressionStats />

      <SuppressionList />
    </div>
  );
}
