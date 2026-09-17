import { queryOptions } from "@tanstack/react-query";

import { getTemplate, getTemplates } from "~/server/functions/template";

/**
 * Query keys and options for email templates (#9).
 *
 * The editor invalidates `details()` rather than one template's key after a
 * save, because the route it navigates back to may be showing a different
 * template than the one it just wrote.
 */

export const templateKeys = {
  all: ["template"] as const,
  lists: () => [...templateKeys.all, "list"] as const,
  list: (page?: number) => [...templateKeys.lists(), { page }] as const,
  details: () => [...templateKeys.all, "detail"] as const,
  detail: (templateId: string) =>
    [...templateKeys.details(), templateId] as const,
};

export const templateQueries = {
  list: (page?: number) =>
    queryOptions({
      queryKey: templateKeys.list(page),
      queryFn: () => getTemplates({ data: { page } }),
    }),
  detail: (templateId: string) =>
    queryOptions({
      queryKey: templateKeys.detail(templateId),
      queryFn: () => getTemplate({ data: { templateId } }),
    }),
};
