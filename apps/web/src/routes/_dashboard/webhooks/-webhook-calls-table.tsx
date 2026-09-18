import { formatDistanceToNow } from "date-fns";

import { Button } from "@usesend/ui/src/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usesend/ui/src/select";
import Spinner from "@usesend/ui/src/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@usesend/ui/src/table";

import type { listCalls } from "~/server/functions/webhook";
import { WebhookCallStatus } from "~/types/db";
import { WebhookCallStatusBadge } from "./-webhook-call-status-badge";

// `~/types/db` has no row type for a webhook call, and the server function is
// the better source anyway: it is what the component is actually handed.
type WebhookCall = Awaited<ReturnType<typeof listCalls>>["items"][number];

/**
 * The delivery log.
 *
 * It owns no state: the filter, the page and the selected row all come from
 * the URL, so this is a pure rendering of what the route decided.
 */
export function WebhookCallsTable({
  calls,
  isLoading,
  status,
  selectedCallId,
  hasPreviousPage,
  hasNextPage,
  onSelectCall,
  onStatusChange,
  onPreviousPage,
  onNextPage,
}: {
  calls: WebhookCall[];
  isLoading: boolean;
  status: WebhookCallStatus | "ALL";
  selectedCallId: string | null;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  // `no-unused-vars` here is the base ESLint rule, not the TypeScript one:
  // it reads the parameter name in a function *type* as a declaration. The
  // config fix belongs in #87, not in every file that declares a callback.
  // eslint-disable-next-line no-unused-vars
  onSelectCall: (callId: string) => void;
  // eslint-disable-next-line no-unused-vars
  onStatusChange: (status: WebhookCallStatus | "ALL") => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="mb-4 flex flex-row items-center justify-between">
        <h2 className="text-base font-medium">Delivery Logs</h2>
        <Select
          value={status}
          onValueChange={(value) =>
            onStatusChange(value as WebhookCallStatus | "ALL")
          }
        >
          <SelectTrigger className="h-8 w-[150px] text-xs">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All</SelectItem>
            <SelectItem value={WebhookCallStatus.DELIVERED}>
              Delivered
            </SelectItem>
            <SelectItem value={WebhookCallStatus.FAILED}>Failed</SelectItem>
            <SelectItem value={WebhookCallStatus.PENDING}>Pending</SelectItem>
            <SelectItem value={WebhookCallStatus.IN_PROGRESS}>
              In Progress
            </SelectItem>
            <SelectItem value={WebhookCallStatus.DISCARDED}>
              Discarded
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-1 flex-col overflow-hidden rounded-xl border shadow">
        <Table>
          <TableHeader className="sticky top-0 z-10">
            <TableRow className="bg-muted dark:bg-muted/70">
              <TableHead className="h-9 rounded-tl-xl">Status</TableHead>
              <TableHead className="h-9">Event Type</TableHead>
              <TableHead className="h-9 rounded-tr-xl">Time</TableHead>
            </TableRow>
          </TableHeader>
        </Table>
        <div className="no-scrollbar flex-1 overflow-auto">
          <Table>
            <TableBody>
              {isLoading ? (
                <TableRow className="h-32 hover:bg-transparent">
                  <TableCell colSpan={3} className="py-4 text-center">
                    <Spinner
                      className="mx-auto h-6 w-6"
                      innerSvgClass="stroke-primary"
                    />
                  </TableCell>
                </TableRow>
              ) : calls.length === 0 ? (
                <TableRow className="h-32 hover:bg-transparent">
                  <TableCell colSpan={3} className="py-4 text-center">
                    <p className="text-sm text-muted-foreground">
                      No webhook calls yet
                    </p>
                  </TableCell>
                </TableRow>
              ) : (
                calls.map((call) => (
                  <TableRow
                    key={call.id}
                    className={`cursor-pointer transition-colors ${
                      selectedCallId === call.id
                        ? "bg-accent/50 text-accent-foreground"
                        : "hover:bg-muted/50"
                    }`}
                    onClick={() => onSelectCall(call.id)}
                  >
                    <TableCell className="py-2">
                      <div className="origin-left scale-90">
                        <WebhookCallStatusBadge status={call.status} />
                      </div>
                    </TableCell>
                    <TableCell className="py-2 font-mono text-xs">
                      {call.type}
                    </TableCell>
                    <TableCell className="py-2 text-xs text-muted-foreground">
                      {formatDistanceToNow(call.createdAt, {
                        addSuffix: true,
                      })}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-4">
        <Button size="sm" onClick={onPreviousPage} disabled={!hasPreviousPage}>
          Previous
        </Button>
        <Button size="sm" onClick={onNextPage} disabled={!hasNextPage}>
          Next
        </Button>
      </div>
    </div>
  );
}

export default WebhookCallsTable;
