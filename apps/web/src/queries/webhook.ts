import { queryOptions } from "@tanstack/react-query";

import { getById, getCall, list, listCalls } from "~/server/functions/webhook";
import type { WebhookCallStatus } from "~/types/db";

/**
 * Query keys and options for webhooks and their delivery log (#9).
 *
 * The call log is kept under its own `calls` prefix rather than nested under
 * the webhook it belongs to, because the webhook page filters it by status and
 * pages through it with a cursor, and a retry has to invalidate every one of
 * those pages without touching the endpoint's own settings.
 */

export type WebhookCallFilters = {
  webhookId?: string;
  status?: WebhookCallStatus;
  limit?: number;
  cursor?: string;
};

export const webhookKeys = {
  all: ["webhook"] as const,
  list: () => [...webhookKeys.all, "list"] as const,
  details: () => [...webhookKeys.all, "detail"] as const,
  detail: (id: string) => [...webhookKeys.details(), id] as const,
  calls: () => [...webhookKeys.all, "calls"] as const,
  callList: (filters: WebhookCallFilters) =>
    [...webhookKeys.calls(), "list", filters] as const,
  callDetails: () => [...webhookKeys.calls(), "detail"] as const,
  callDetail: (id: string) => [...webhookKeys.callDetails(), id] as const,
};

export const webhookQueries = {
  list: () =>
    queryOptions({
      queryKey: webhookKeys.list(),
      queryFn: () => list(),
    }),
  detail: (id: string) =>
    queryOptions({
      queryKey: webhookKeys.detail(id),
      queryFn: () => getById({ data: { id } }),
    }),
  callList: (filters: WebhookCallFilters = {}) =>
    queryOptions({
      queryKey: webhookKeys.callList(filters),
      queryFn: () => listCalls({ data: filters }),
    }),
  callDetail: (id: string) =>
    queryOptions({
      queryKey: webhookKeys.callDetail(id),
      queryFn: () => getCall({ data: { id } }),
    }),
};
