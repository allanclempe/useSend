import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDate } from "date-fns";
import { RefreshCw } from "lucide-react";

import { Button } from "@usesend/ui/src/button";
import { toast } from "@usesend/ui/src/toaster";
import { WEBHOOK_EVENT_VERSION } from "@usesend/lib/src/webhook/webhook-events";

import { CodeDisplay } from "~/components/code-display";
import { webhookKeys, webhookQueries } from "~/queries/webhook";
import { retryCall } from "~/server/functions/webhook";
import { WebhookCallStatus } from "~/types/db";
import { WebhookCallStatusBadge } from "./-webhook-call-status-badge";

export function WebhookCallDetails({ callId }: { callId: string }) {
  const callQuery = useQuery(webhookQueries.callDetail(callId));
  const queryClient = useQueryClient();

  const retry = useMutation({
    mutationFn: retryCall,
    onSuccess: async () => {
      // A retry writes a new attempt and moves this call's status, so every
      // page of the log and this call's own record are both stale.
      await queryClient.invalidateQueries({ queryKey: webhookKeys.calls() });
      toast.success("Webhook call queued for retry");
    },
    onError: (error) => toast.error(error.message),
  });

  const call = callQuery.data;

  if (!call) {
    return (
      <div className="flex h-full flex-col">
        <div className="mb-4 flex flex-row items-center justify-between">
          <h2 className="text-base font-medium">Call Details</h2>
        </div>
        <div className="flex flex-1 items-center justify-center rounded-xl border p-6 shadow">
          <p className="text-sm text-muted-foreground">
            Loading call details...
          </p>
        </div>
      </div>
    );
  }

  // The stored payload is only the `data` member of what went over the wire;
  // the envelope around it is rebuilt here so the panel shows the request the
  // endpoint actually received.
  let data: unknown;
  try {
    data = JSON.parse(call.payload);
  } catch {
    data = call.payload;
  }

  const fullPayload = {
    id: call.id,
    type: call.type,
    version: call.webhook?.apiVersion ?? WEBHOOK_EVENT_VERSION,
    createdAt: new Date(call.createdAt).toISOString(),
    teamId: call.teamId,
    data,
    attempt: call.attempt,
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="mb-4 flex flex-row items-center justify-between">
        <h2 className="text-base font-medium">Call Details</h2>
        {call.status === WebhookCallStatus.FAILED && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => retry.mutate({ data: { id: call.id } })}
            disabled={retry.isPending}
            className="h-8"
          >
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            Retry
          </Button>
        )}
      </div>
      <div className="no-scrollbar flex-1 space-y-8 overflow-auto rounded-xl border p-6 shadow">
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Status
            </span>
            <div>
              <WebhookCallStatusBadge status={call.status} />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Event Type
            </span>
            <span className="font-mono text-sm">{call.type}</span>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Timestamp
            </span>
            <span className="font-mono text-sm">
              {formatDate(call.createdAt, "MMM dd, yyyy HH:mm:ss")}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Attempt
            </span>
            <span className="font-mono text-sm">{call.attempt}</span>
          </div>

          {call.responseStatus && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Response Status
              </span>
              <span className="font-mono text-sm">{call.responseStatus}</span>
            </div>
          )}

          {call.responseTimeMs != null && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Duration
              </span>
              <span className="font-mono text-sm">{call.responseTimeMs}ms</span>
            </div>
          )}
        </div>

        {call.lastError && (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-wider text-red-500">
              Error
            </span>
            <div className="rounded-md border border-red-500/20 bg-red-500/10 p-3 font-mono text-xs text-red-600 dark:text-red-400">
              {call.lastError}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-3">
          <h4 className="text-sm font-medium">Request Payload</h4>
          <CodeDisplay
            code={JSON.stringify(fullPayload, null, 2)}
            language="json"
          />
        </div>

        {call.responseText && (
          <div className="flex flex-col gap-3">
            <h4 className="text-sm font-medium">Response Body</h4>
            <CodeDisplay code={call.responseText} />
          </div>
        )}
      </div>
    </div>
  );
}

export default WebhookCallDetails;
