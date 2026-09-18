import { createFileRoute } from "@tanstack/react-router";

import { H1 } from "@usesend/ui";

import { apiKeyQueries } from "~/queries/api-key";
import { domainQueries } from "~/queries/domain";
import { emailQueries } from "~/queries/email";
import { emailListFilters, emailSearchSchema } from "./-email-filters";
import EmailList from "./-email-list";

/**
 * `/emails`.
 *
 * The loader warms the page the URL asks for, keyed on the filters, so a
 * bookmarked filtered link arrives with its rows already rendered. The two
 * dropdowns are warmed with it because both of them show a *name* for the id
 * in the URL — without them a filtered link renders "All domains" for a second
 * and then corrects itself.
 *
 * The export query is deliberately not warmed: it is up to ten thousand rows
 * and nobody pays for it until they press the button.
 */
export const Route = createFileRoute("/_dashboard/emails/")({
  validateSearch: emailSearchSchema,
  loaderDeps: ({ search }) => emailListFilters(search),
  loader: ({ context, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(emailQueries.list(deps)),
      context.queryClient.ensureQueryData(domainQueries.list()),
      context.queryClient.ensureQueryData(apiKeyQueries.list()),
    ]),
  component: EmailsPage,
});

function EmailsPage() {
  return (
    <div>
      <div className="flex items-center justify-between">
        <H1>Emails</H1>
      </div>
      <EmailList />
    </div>
  );
}
