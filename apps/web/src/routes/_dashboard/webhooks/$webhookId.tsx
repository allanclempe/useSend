import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Edit3, Key, MoreVertical, Pause, Play, TestTube } from "lucide-react";
import { useState } from "react";
import { z } from "zod";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@usesend/ui/src/breadcrumb";
import { Button } from "@usesend/ui/src/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@usesend/ui/src/popover";
import { toast } from "@usesend/ui/src/toaster";

import {
  webhookKeys,
  webhookQueries,
  type WebhookCallFilters,
} from "~/queries/webhook";
import { setStatus, test, update } from "~/server/functions/webhook";
import { WebhookCallStatus, WebhookStatus, type Webhook } from "~/types/db";
import DeleteWebhook from "./-delete-webhook";
import WebhookCallDetails from "./-webhook-call-details";
import WebhookCallsTable from "./-webhook-calls-table";
import WebhookInfo from "./-webhook-info";
import EditWebhookDialog from "./-webhook-update-dialog";

const PAGE_SIZE = 20;

/**
 * Which page of the delivery log you are on, and which attempt you are
 * reading, are now in the URL rather than in `useState`.
 *
 * `cursors` is the whole stack of page cursors, not just the current one,
 * because "Previous" is otherwise unanswerable: the list is keyset-paginated,
 * so a cursor takes you forward and there is no inverse. Keeping the stack
 * makes the link to page three genuinely a link to page three — shareable, and
 * survives a reload — where the tRPC version dropped you back to page one.
 *
 * `call` replaces the effect that auto-selected the first row: with no `call`
 * the component falls back to the first row of the page, which is the same
 * behaviour without the extra render.
 */
const searchSchema = z.object({
  status: z.nativeEnum(WebhookCallStatus).optional().catch(undefined),
  cursors: z.array(z.string()).catch([]),
  call: z.string().optional().catch(undefined),
});

type WebhookSearch = z.infer<typeof searchSchema>;

function callFilters(
  webhookId: string,
  search: WebhookSearch,
): WebhookCallFilters {
  return {
    webhookId,
    status: search.status,
    limit: PAGE_SIZE,
    cursor: search.cursors[search.cursors.length - 1],
  };
}

export const Route = createFileRoute("/_dashboard/webhooks/$webhookId")({
  validateSearch: searchSchema,
  // The log query depends on the filter and the page, so the loader has to be
  // told when they change or it would warm the cache for the wrong page.
  loaderDeps: ({ search }) => search,
  loader: ({ context, params, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(
        webhookQueries.detail(params.webhookId),
      ),
      context.queryClient.ensureQueryData(
        webhookQueries.callList(callFilters(params.webhookId, deps)),
      ),
    ]),
  component: WebhookDetailPage,
});

function WebhookDetailPage() {
  const { webhookId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();

  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);

  const webhookQuery = useQuery(webhookQueries.detail(webhookId));
  const callsQuery = useQuery(
    webhookQueries.callList(callFilters(webhookId, search)),
  );

  const calls = callsQuery.data?.items ?? [];
  const nextCursor = callsQuery.data?.nextCursor;
  const selectedCallId = search.call ?? calls[0]?.id ?? null;

  const changeStatus = useMutation({
    mutationFn: setStatus,
    onSuccess: async (_result, variables) => {
      await queryClient.invalidateQueries({ queryKey: webhookKeys.all });
      toast.success(
        `Webhook ${
          variables.data.status === WebhookStatus.ACTIVE ? "resumed" : "paused"
        }`,
      );
    },
    onError: (error) => toast.error(error.message),
  });

  const rotateSecret = useMutation({
    mutationFn: update,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: webhookKeys.all });
      toast.success("Secret rotated successfully");
    },
    onError: (error) => toast.error(error.message),
  });

  const sendTest = useMutation({
    mutationFn: test,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: webhookKeys.calls() });
      toast.success("Test webhook enqueued");
    },
    onError: (error) => toast.error(error.message),
  });

  const webhook = webhookQuery.data;

  if (webhookQuery.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading webhook...</p>
      </div>
    );
  }

  if (!webhook) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-muted-foreground">Webhook not found</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to="/webhooks" className="text-lg">
                  Webhooks
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="text-lg" />
            <BreadcrumbItem>
              <BreadcrumbPage className="max-w-[500px] truncate text-lg">
                {webhook.url}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        <WebhookDetailActions
          webhook={webhook}
          onTest={() => sendTest.mutate({ data: { id: webhookId } })}
          onEdit={() => setIsEditDialogOpen(true)}
          onToggleStatus={() =>
            changeStatus.mutate({
              data: {
                id: webhookId,
                status:
                  webhook.status === WebhookStatus.ACTIVE
                    ? WebhookStatus.PAUSED
                    : WebhookStatus.ACTIVE,
              },
            })
          }
          onRotateSecret={() =>
            rotateSecret.mutate({ data: { id: webhookId, rotateSecret: true } })
          }
          isTestPending={sendTest.isPending}
          isToggling={changeStatus.isPending}
          isRotating={rotateSecret.isPending}
        />
      </div>

      <WebhookInfo webhook={webhook} />

      <div className="flex h-[calc(100vh-280px)] min-h-[600px] gap-6">
        <div className="flex w-1/2 flex-col">
          <WebhookCallsTable
            calls={calls}
            isLoading={callsQuery.isLoading}
            status={search.status ?? "ALL"}
            selectedCallId={selectedCallId}
            hasPreviousPage={search.cursors.length > 0}
            hasNextPage={Boolean(nextCursor)}
            onSelectCall={(callId) =>
              navigate({ search: (prev) => ({ ...prev, call: callId }) })
            }
            // A different filter is a different list, so the page stack and the
            // selected row both have to go with it.
            onStatusChange={(status) =>
              navigate({
                search: {
                  status: status === "ALL" ? undefined : status,
                  cursors: [],
                },
              })
            }
            onPreviousPage={() =>
              navigate({
                search: (prev) => ({
                  ...prev,
                  cursors: prev.cursors.slice(0, -1),
                  call: undefined,
                }),
              })
            }
            onNextPage={() =>
              navigate({
                search: (prev) => ({
                  ...prev,
                  cursors: nextCursor
                    ? [...prev.cursors, nextCursor]
                    : prev.cursors,
                  call: undefined,
                }),
              })
            }
          />
        </div>

        <div className="w-1/2 overflow-auto">
          {selectedCallId ? (
            <WebhookCallDetails callId={selectedCallId} />
          ) : (
            <div className="flex h-full items-center justify-center rounded-xl border border-dashed bg-muted/10 text-muted-foreground">
              Select a webhook call to view details
            </div>
          )}
        </div>
      </div>

      {isEditDialogOpen && (
        <EditWebhookDialog
          webhook={webhook}
          open={isEditDialogOpen}
          onOpenChange={setIsEditDialogOpen}
        />
      )}
    </div>
  );
}

function WebhookDetailActions({
  webhook,
  onTest,
  onEdit,
  onToggleStatus,
  onRotateSecret,
  isTestPending,
  isToggling,
  isRotating,
}: {
  webhook: Webhook;
  onTest: () => void;
  onEdit: () => void;
  onToggleStatus: () => void;
  onRotateSecret: () => void;
  isTestPending: boolean;
  isToggling: boolean;
  isRotating: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isAutoDisabled = webhook.status === WebhookStatus.AUTO_DISABLED;
  const canActivate = webhook.status === WebhookStatus.PAUSED || isAutoDisabled;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="default" className="gap-1">
          <MoreVertical className="-ml-2 h-4" />
          Actions
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-52 rounded-xl p-1" align="end">
        <div className="flex flex-col">
          <Button
            variant="ghost"
            size="sm"
            className="justify-start rounded-lg hover:bg-accent"
            onClick={() => {
              onTest();
              setOpen(false);
            }}
            disabled={isTestPending}
          >
            <TestTube className="mr-2 h-4 w-4" />
            Test webhook
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="justify-start rounded-lg hover:bg-accent"
            onClick={() => {
              onEdit();
              setOpen(false);
            }}
          >
            <Edit3 className="mr-2 h-4 w-4" />
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="justify-start rounded-lg hover:bg-accent"
            onClick={() => {
              onToggleStatus();
              setOpen(false);
            }}
            disabled={isToggling}
          >
            {canActivate ? (
              <>
                <Play className="mr-2 h-4 w-4" />
                {isAutoDisabled ? "Re-enable" : "Resume"}
              </>
            ) : (
              <>
                <Pause className="mr-2 h-4 w-4" />
                Pause
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="justify-start rounded-lg hover:bg-accent"
            onClick={() => {
              onRotateSecret();
              setOpen(false);
            }}
            disabled={isRotating}
          >
            <Key className="mr-2 h-4 w-4" />
            Rotate secret
          </Button>
          <DeleteWebhook webhook={webhook} />
        </div>
      </PopoverContent>
    </Popover>
  );
}
