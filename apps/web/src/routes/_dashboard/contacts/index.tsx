import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { H1 } from "@usesend/ui";

import { contactQueries } from "~/queries/contacts";
import AddContactBook from "./-add-contact-book";
import ContactBooksList from "./-contact-books-list";

/**
 * `/contacts`.
 *
 * `search` is a route search param rather than component state, because it is
 * what the list query is keyed on and people link to a filtered list. The
 * Next.js page kept it in `useUrlState`, which wrote the URL with
 * `history.replaceState` behind the router's back: the URL and the state
 * agreed only until something else navigated.
 *
 * The loader warms the same query the list reads, so the first paint has the
 * books instead of a spinner. It depends on `search`, hence `loaderDeps` —
 * without it the router would reuse the first search's loader result forever.
 */
export const Route = createFileRoute("/_dashboard/contacts/")({
  validateSearch: z.object({ search: z.string().optional() }),
  loaderDeps: ({ search }) => ({ search: search.search }),
  loader: ({ context, deps }) =>
    context.queryClient.ensureQueryData(contactQueries.bookList(deps.search)),
  component: ContactsPage,
});

function ContactsPage() {
  return (
    <div>
      <div className="flex items-center justify-between">
        <H1>Contact books</H1>
        <AddContactBook />
      </div>
      <ContactBooksList />
    </div>
  );
}
