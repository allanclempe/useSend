import { queryOptions } from "@tanstack/react-query";

import { emails, exportEmails, getEmail } from "~/server/functions/email";
import type { EmailStatus } from "~/types/db";

/**
 * Query keys and options for the email log (#9).
 *
 * Cancelling or rescheduling an email invalidates exactly one detail key, and
 * deliberately not the list: the list is paginated over every email the team
 * has ever sent, and the row the user is looking at has already been updated
 * optimistically by the dialog that changed it.
 */

export type EmailListFilters = {
  page?: number;
  status?: EmailStatus | null;
  domain?: number;
  search?: string | null;
  apiId?: number;
};

export type EmailExportFilters = Omit<EmailListFilters, "page">;

export const emailKeys = {
  all: ["email"] as const,
  lists: () => [...emailKeys.all, "list"] as const,
  list: (filters: EmailListFilters) => [...emailKeys.lists(), filters] as const,
  exports: () => [...emailKeys.all, "export"] as const,
  exportList: (filters: EmailExportFilters) =>
    [...emailKeys.exports(), filters] as const,
  details: () => [...emailKeys.all, "detail"] as const,
  detail: (id: string) => [...emailKeys.details(), id] as const,
};

export const emailQueries = {
  list: (filters: EmailListFilters = {}) =>
    queryOptions({
      queryKey: emailKeys.list(filters),
      queryFn: () => emails({ data: filters }),
    }),
  exportList: (filters: EmailExportFilters = {}) =>
    queryOptions({
      queryKey: emailKeys.exportList(filters),
      queryFn: () => exportEmails({ data: filters }),
    }),
  detail: (id: string) =>
    queryOptions({
      queryKey: emailKeys.detail(id),
      queryFn: () => getEmail({ data: { id } }),
    }),
};
