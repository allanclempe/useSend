import { createFileRoute } from "@tanstack/react-router";

import { H1 } from "@usesend/ui";

import { webhookQueries } from "~/queries/webhook";
import AddWebhook from "./-add-webhook";
import WebhookList from "./-webhook-list";

/**
 * `/webhooks`.
 *
 * The loader warms the endpoint list, which is the only thing this page always
 * needs. The plan limit behind "Add webhook" is deliberately left out: it is
 * asked for when the dialog opens, and a page that cannot open the dialog has
 * no use for the answer.
 */
export const Route = createFileRoute("/_dashboard/webhooks/")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(webhookQueries.list()),
  component: WebhooksPage,
});

function WebhooksPage() {
  return (
    <div>
      <div className="flex items-center justify-between">
        <H1>Webhooks</H1>
        <AddWebhook />
      </div>
      <WebhookList />
    </div>
  );
}
