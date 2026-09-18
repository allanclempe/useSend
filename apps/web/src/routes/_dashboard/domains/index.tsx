import { createFileRoute } from "@tanstack/react-router";

import { H1 } from "@usesend/ui";

import { domainQueries } from "~/queries/domain";
import AddDomain from "./-add-domain";
import DomainsList from "./-domain-list";

/**
 * `/domains`.
 *
 * The loader warms the list and the region options so the first paint has
 * them, instead of the two spinners the tRPC version showed on every visit.
 * `ensureQueryData` writes into the same cache `useQuery` reads, so the
 * components below are unchanged by it.
 */
export const Route = createFileRoute("/_dashboard/domains/")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(domainQueries.list()),
      context.queryClient.ensureQueryData(domainQueries.regions()),
    ]),
  component: DomainsPage,
});

function DomainsPage() {
  return (
    <div>
      <div className="flex items-center justify-between">
        <H1>Domains</H1>
        <AddDomain />
      </div>
      <DomainsList />
    </div>
  );
}
