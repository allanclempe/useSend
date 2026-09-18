import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { Edit3, MoreVertical, Pause, Play } from "lucide-react";
import { useState } from "react";

import { Button } from "@usesend/ui/src/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@usesend/ui/src/popover";
import Spinner from "@usesend/ui/src/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@usesend/ui/src/table";
import { toast } from "@usesend/ui/src/toaster";

import { webhookKeys, webhookQueries } from "~/queries/webhook";
import { setStatus } from "~/server/functions/webhook";
import { WebhookStatus, type Webhook } from "~/types/db";
import DeleteWebhook from "./-delete-webhook";
import { WebhookStatusBadge } from "./-webhook-status-badge";
import EditWebhookDialog from "./-webhook-update-dialog";

export function WebhookList() {
  const webhooksQuery = useQuery(webhookQueries.list());
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [editingId, setEditingId] = useState<string | null>(null);

  const webhooks = webhooksQuery.data ?? [];

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

  function handleToggleStatus(webhook: Webhook) {
    changeStatus.mutate({
      data: {
        id: webhook.id,
        status:
          webhook.status === WebhookStatus.ACTIVE
            ? WebhookStatus.PAUSED
            : WebhookStatus.ACTIVE,
      },
    });
  }

  return (
    <div className="mt-10">
      <div className="rounded-xl border shadow">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30">
              <TableHead className="rounded-tl-xl">URL</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last success</TableHead>
              <TableHead>Last failure</TableHead>
              <TableHead className="rounded-tr-xl text-right">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {webhooksQuery.isLoading ? (
              <TableRow className="h-32">
                <TableCell colSpan={5} className="py-4 text-center">
                  <Spinner
                    className="mx-auto h-6 w-6"
                    innerSvgClass="stroke-primary"
                  />
                </TableCell>
              </TableRow>
            ) : webhooks.length === 0 ? (
              <TableRow className="h-32">
                <TableCell colSpan={5} className="py-4 text-center">
                  <p>No webhooks configured</p>
                </TableCell>
              </TableRow>
            ) : (
              webhooks.map((webhook) => (
                <TableRow
                  key={webhook.id}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() =>
                    navigate({
                      to: "/webhooks/$webhookId",
                      params: { webhookId: webhook.id },
                    })
                  }
                >
                  <TableCell className="max-w-xs truncate">
                    {webhook.url}
                  </TableCell>
                  <TableCell>
                    <WebhookStatusBadge status={webhook.status} />
                  </TableCell>
                  <TableCell className="text-sm">
                    {webhook.lastSuccessAt
                      ? formatDistanceToNow(webhook.lastSuccessAt, {
                          addSuffix: true,
                        })
                      : "Never"}
                  </TableCell>
                  <TableCell className="text-sm">
                    {webhook.lastFailureAt
                      ? formatDistanceToNow(webhook.lastFailureAt, {
                          addSuffix: true,
                        })
                      : "Never"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div
                      className="flex items-center justify-end"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <WebhookActions
                        webhook={webhook}
                        onEdit={() => setEditingId(webhook.id)}
                        onToggleStatus={() => handleToggleStatus(webhook)}
                        isToggling={changeStatus.isPending}
                      />
                    </div>
                    {editingId === webhook.id ? (
                      <EditWebhookDialog
                        webhook={webhook}
                        open
                        onOpenChange={(open) =>
                          setEditingId(open ? webhook.id : null)
                        }
                      />
                    ) : null}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function WebhookActions({
  webhook,
  onEdit,
  onToggleStatus,
  isToggling,
}: {
  webhook: Webhook;
  onEdit: () => void;
  onToggleStatus: () => void;
  isToggling: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isAutoDisabled = webhook.status === WebhookStatus.AUTO_DISABLED;
  const canActivate = webhook.status === WebhookStatus.PAUSED || isAutoDisabled;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm">
          <MoreVertical className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-48 rounded-xl p-1" align="end">
        <div className="flex flex-col">
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
          <DeleteWebhook webhook={webhook} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default WebhookList;
