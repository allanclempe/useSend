import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { motion } from "framer-motion";
import { useDebouncedCallback } from "use-debounce";

import { Input } from "@usesend/ui/src/input";

import { contactQueries } from "~/queries/contacts";
import DeleteContactBook from "./-delete-contact-book";
import EditContactBook from "./-edit-contact-book";

const route = getRouteApi("/_dashboard/contacts/");

export default function ContactBooksList() {
  const { search } = route.useSearch();
  const navigate = useNavigate();

  const contactBooksQuery = useQuery(contactQueries.bookList(search));

  // A keystroke is not a navigation. The debounce keeps one history entry per
  // pause in typing, and `replace` keeps even those out of the back button —
  // the same shape the `useUrlState` version had, now visible to the router.
  const debouncedSearch = useDebouncedCallback((value: string) => {
    void navigate({
      to: "/contacts",
      search: { search: value || undefined },
      replace: true,
    });
  }, 1000);

  return (
    <div className="mt-10">
      <Input
        placeholder="Search contact book"
        className="mb-4 mr-4 w-[300px]"
        defaultValue={search ?? ""}
        onChange={(e) => debouncedSearch(e.target.value)}
      />
      <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
        {contactBooksQuery.data?.map((contactBook) => (
          <motion.div
            key={contactBook.id}
            whileHover={{ scale: 1.02 }}
            transition={{ type: "spring", stiffness: 200, damping: 10 }}
            whileTap={{ scale: 0.99 }}
            className="rounded-xl border shadow hover:shadow-lg"
          >
            <div className="flex flex-col">
              <Link
                to="/contacts/$contactBookId"
                params={{ contactBookId: contactBook.id }}
              >
                <div className="mb-4 flex items-center justify-between p-4">
                  <div className="flex items-center gap-2">
                    <div>{contactBook.emoji}</div>
                    <div className="w-[180px] truncate overflow-ellipsis whitespace-nowrap font-semibold">
                      {contactBook.name}
                    </div>
                  </div>
                  <div className="text-sm">
                    <span className="font-mono">
                      {contactBook._count.contacts}
                    </span>{" "}
                    contacts
                  </div>
                </div>
              </Link>

              <div className="flex items-center justify-between border-t bg-muted/50">
                {/* The footer's "created at" is a second way into the book, so
                    it is a `Link` rather than an `onClick` push — middle click
                    and "open in new tab" work on it now. */}
                <Link
                  to="/contacts/$contactBookId"
                  params={{ contactBookId: contactBook.id }}
                  className="w-full py-3 pl-4 text-xs text-muted-foreground"
                >
                  {formatDistanceToNow(new Date(contactBook.createdAt), {
                    addSuffix: true,
                  })}
                </Link>
                <div className="flex gap-3 pr-4">
                  <EditContactBook contactBook={contactBook} />
                  <DeleteContactBook contactBook={contactBook} />
                </div>
              </div>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
