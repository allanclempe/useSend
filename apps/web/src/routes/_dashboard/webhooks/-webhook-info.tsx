import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Copy, Eye, EyeOff } from "lucide-react";
import { useState } from "react";

import { Badge } from "@usesend/ui/src/badge";
import { Button } from "@usesend/ui/src/button";
import { toast } from "@usesend/ui/src/toaster";

import { domainQueries } from "~/queries/domain";
import type { Webhook } from "~/types/db";
import { WebhookStatusBadge } from "./-webhook-status-badge";

/**
 * The header strip on a webhook's page: what it subscribes to, and its secret.
 *
 * The tRPC version also fetched the last fifty delivery attempts here and
 * counted the delivered, failed and pending ones — and then rendered none of
 * the three. That query is gone; the delivery log below already shows them.
 */
export function WebhookInfo({ webhook }: { webhook: Webhook }) {
  const [showSecret, setShowSecret] = useState(false);

  const domainsQuery = useQuery(domainQueries.list());

  const domainNameById = new Map(
    (domainsQuery.data ?? []).map((domain) => [domain.id, domain.name]),
  );

  // A domain can be deleted while a webhook still names it, so the id is the
  // fallback rather than an empty chip.
  const selectedDomainLabels = webhook.domainIds.map(
    (domainId) => domainNameById.get(domainId) ?? `Domain #${domainId}`,
  );

  function handleCopySecret() {
    navigator.clipboard.writeText(webhook.secret);
    toast.success("Secret copied to clipboard");
  }

  return (
    <div className="mb-10 mt-5 flex items-start justify-between gap-6">
      <div className="flex flex-col gap-1">
        <span className="text-sm text-muted-foreground">Events</span>
        <div className="flex flex-wrap items-center gap-1 font-mono text-sm">
          {webhook.eventTypes.length === 0 ? (
            <span className="text-sm">All events</span>
          ) : (
            <>
              {webhook.eventTypes.slice(0, 2).map((event) => (
                <Badge key={event} variant="outline">
                  {event}
                </Badge>
              ))}
              {webhook.eventTypes.length > 2 && (
                <span className="text-xs text-muted-foreground">
                  +{webhook.eventTypes.length - 2} more
                </span>
              )}
            </>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-sm text-muted-foreground">Domains</span>
        <div className="flex flex-wrap items-center gap-1 text-sm">
          {webhook.domainIds.length === 0 ? (
            <span className="text-sm">All domains</span>
          ) : (
            <>
              {selectedDomainLabels.slice(0, 2).map((domainName, index) => (
                <Badge key={`${domainName}-${index}`} variant="outline">
                  {domainName}
                </Badge>
              ))}
              {webhook.domainIds.length > 2 && (
                <span className="text-xs text-muted-foreground">
                  +{webhook.domainIds.length - 2} more
                </span>
              )}
            </>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-sm text-muted-foreground">Status</span>
        <div className="flex items-center">
          <WebhookStatusBadge status={webhook.status} />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-sm text-muted-foreground">Created</span>
        <span className="text-sm">
          {formatDistanceToNow(webhook.createdAt, { addSuffix: true })}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Signing Secret</span>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setShowSecret(!showSecret)}
              className="h-5 w-5 text-muted-foreground hover:text-foreground"
            >
              {showSecret ? (
                <EyeOff className="h-3 w-3" />
              ) : (
                <Eye className="h-3 w-3" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleCopySecret}
              className="h-5 w-5 text-muted-foreground hover:text-foreground"
            >
              <Copy className="h-3 w-3" />
            </Button>
          </div>
        </div>
        <code className="inline-block w-[240px] truncate rounded bg-muted px-2 py-1 font-mono text-xs">
          {showSecret ? webhook.secret : "whsec_••••••••••••••••••••••••"}
        </code>
      </div>
    </div>
  );
}

export default WebhookInfo;
