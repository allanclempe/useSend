import { queryOptions } from "@tanstack/react-query";

import {
  contacts,
  exportContacts,
  getContactBookDetails,
  getContactBooks,
} from "~/server/functions/contacts";

/**
 * Query keys and options for contact books and contacts (#9).
 *
 * Contacts are keyed under the book they belong to rather than in a flat list,
 * because that is the only invalidation the dashboard ever wants: adding a
 * contact should not refetch every other book's page. The book-level keys are
 * split into `bookDetails()` / `bookDetail(id)` for the same reason campaigns
 * are — the double-opt-in page invalidates one book, the bulk upload
 * invalidates all of them.
 */

export type ContactListFilters = {
  page?: number;
  subscribed?: boolean;
  search?: string;
};

export type ContactExportFilters = {
  subscribed?: boolean;
  search?: string;
};

export const contactKeys = {
  all: ["contacts"] as const,
  books: () => [...contactKeys.all, "books"] as const,
  bookList: (search?: string) => [...contactKeys.books(), { search }] as const,
  bookDetails: () => [...contactKeys.all, "bookDetail"] as const,
  bookDetail: (contactBookId: string) =>
    [...contactKeys.bookDetails(), contactBookId] as const,
  lists: () => [...contactKeys.all, "list"] as const,
  list: (contactBookId: string, filters: ContactListFilters) =>
    [...contactKeys.lists(), contactBookId, filters] as const,
  exports: () => [...contactKeys.all, "export"] as const,
  exportList: (contactBookId: string, filters: ContactExportFilters) =>
    [...contactKeys.exports(), contactBookId, filters] as const,
};

export const contactQueries = {
  bookList: (search?: string) =>
    queryOptions({
      queryKey: contactKeys.bookList(search),
      queryFn: () => getContactBooks({ data: { search } }),
    }),
  bookDetail: (contactBookId: string) =>
    queryOptions({
      queryKey: contactKeys.bookDetail(contactBookId),
      queryFn: () => getContactBookDetails({ data: { contactBookId } }),
    }),
  list: (contactBookId: string, filters: ContactListFilters = {}) =>
    queryOptions({
      queryKey: contactKeys.list(contactBookId, filters),
      queryFn: () => contacts({ data: { contactBookId, ...filters } }),
    }),
  exportList: (contactBookId: string, filters: ContactExportFilters = {}) =>
    queryOptions({
      queryKey: contactKeys.exportList(contactBookId, filters),
      queryFn: () => exportContacts({ data: { contactBookId, ...filters } }),
    }),
};
