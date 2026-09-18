import { createFileRoute } from "@tanstack/react-router";

import { H1 } from "@usesend/ui";

import { apiKeyQueries } from "~/queries/api-key";
import AddApiKey from "./-add-api-key";
import ApiList from "./-api-list";

/**
 * `/dev-settings/api-keys`.
 *
 * The loader warms the list; the domain list the two dialogs need is not
 * warmed here, because it is only ever read after someone opens one.
 */
export const Route = createFileRoute("/_dashboard/dev-settings/api-keys")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(apiKeyQueries.list()),
  component: ApiKeysPage,
});

function ApiKeysPage() {
  return (
    <div>
      <div className="flex items-center justify-between">
        <H1>API Keys</H1>
        <AddApiKey />
      </div>
      <ApiList />
    </div>
  );
}
