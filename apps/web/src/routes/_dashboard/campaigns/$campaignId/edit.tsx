import { createFileRoute } from "@tanstack/react-router";

import { Spinner } from "@usesend/ui/src/spinner";

import { campaignQueries } from "~/queries/campaign";
import { CampaignEditor } from "./-campaign-editor";

/**
 * `/campaigns/$campaignId/edit`.
 *
 * `ssr: false`, like the template and double opt-in editors, and for the same
 * reason: this is the same TipTap editor, and `useEditor` returns `null`
 * outside a browser.
 *
 * The loader runs on the client before the component, so the editor mounts
 * with its content. A campaign that does not exist, or belongs to another
 * team, fails the loader with `NOT_FOUND` and reaches the catch boundary --
 * the Next.js page rendered "Failed to load campaign" in place.
 */
export const Route = createFileRoute("/_dashboard/campaigns/$campaignId/edit")({
  ssr: false,
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(
      campaignQueries.detail(params.campaignId),
    ),
  pendingComponent: () => (
    <div className="flex h-full items-center justify-center">
      <Spinner className="h-6 w-6" />
    </div>
  ),
  component: EditCampaignPage,
});

function EditCampaignPage() {
  const campaign = Route.useLoaderData();

  return <CampaignEditor campaign={campaign} />;
}
