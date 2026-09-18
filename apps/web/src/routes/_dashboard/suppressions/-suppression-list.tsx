import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { Download, Trash2 } from "lucide-react";
import { useState } from "react";
import { useDebouncedCallback } from "use-debounce";

import { Button } from "@usesend/ui/src/button";
import { Input } from "@usesend/ui/src/input";
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
import { toast } from "@usesend/ui/src/toaster";

import { suppressionKeys, suppressionQueries } from "~/queries/suppression";
import { removeSuppression } from "~/server/functions/suppression";
import { SuppressionReason } from "~/types/db";
import RemoveSuppressionDialog from "./-remove-suppression";
import { listFilters } from "./-suppression-filters";

const reasonLabels: Record<SuppressionReason, string> = {
  HARD_BOUNCE: "Hard Bounce",
  COMPLAINT: "Complaint",
  MANUAL: "Manual",
};

export default function SuppressionList() {
  const search = useSearch({ from: "/_dashboard/suppressions" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [emailToRemove, setEmailToRemove] = useState<string | null>(null);

  const filters = listFilters(search);
  const suppressionsQuery = useQuery(suppressionQueries.list(filters));

  // The export is the same read with the pagination taken off, so it shares
  // the page's filters but not its cache entry, and only runs when asked.
  const exportQuery = useQuery({
    ...suppressionQueries.exportList({
      search: filters.search,
      reason: filters.reason,
    }),
    enabled: false,
  });

  const remove = useMutation({
    mutationFn: removeSuppression,
    onSuccess: async () => {
      // One invalidation for the table and the counters above it: both keys
      // hang off `suppressionKeys.all`.
      await queryClient.invalidateQueries({ queryKey: suppressionKeys.all });
      setEmailToRemove(null);
    },
    onError: (error) => toast.error(error.message),
  });

  // Typing is a filter change, so it replaces the history entry rather than
  // leaving one per keystroke behind for the back button.
  const debouncedSearch = useDebouncedCallback((value: string) => {
    void navigate({
      to: "/suppressions",
      search: (prev) => ({ ...prev, search: value || undefined, page: 1 }),
      replace: true,
    });
  }, 1000);

  function handleReasonFilter(value: string) {
    void navigate({
      to: "/suppressions",
      search: (prev) => ({
        ...prev,
        reason: value === "all" ? undefined : (value as SuppressionReason),
        page: 1,
      }),
      replace: true,
    });
  }

  // Paging, unlike filtering, is a place you can want to go back to.
  function goToPage(page: number) {
    void navigate({
      to: "/suppressions",
      search: (prev) => ({ ...prev, page }),
    });
  }

  async function handleExport() {
    const resp = await exportQuery.refetch();

    if (!resp.data) {
      return;
    }

    const csv = [
      "Email,Reason,Created At",
      ...resp.data.map(
        (suppression) =>
          `${suppression.email},${suppression.reason},${suppression.createdAt}`,
      ),
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `suppressions-${new Date().toISOString().split("T")[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  }

  return (
    <div className="mt-10 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-4">
          <Input
            placeholder="Search by email address..."
            className="max-w-sm"
            defaultValue={search.search ?? ""}
            onChange={(e) => debouncedSearch(e.target.value)}
          />
          <Select
            value={search.reason ?? "all"}
            onValueChange={handleReasonFilter}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Filter by reason" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Reasons</SelectItem>
              <SelectItem value={SuppressionReason.HARD_BOUNCE}>
                Hard Bounce
              </SelectItem>
              <SelectItem value={SuppressionReason.COMPLAINT}>
                Complaint
              </SelectItem>
              <SelectItem value={SuppressionReason.MANUAL}>Manual</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          variant="outline"
          onClick={handleExport}
          disabled={exportQuery.isFetching}
        >
          <Download className="mr-2 h-4 w-4" />
          Export
        </Button>
      </div>

      <div className="flex flex-col rounded-xl border shadow">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30">
              <TableHead className="rounded-tl-xl">Email</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Added</TableHead>
              <TableHead className="rounded-tr-xl">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {suppressionsQuery.isLoading ? (
              <TableRow className="h-32">
                <TableCell colSpan={4} className="py-4 text-center">
                  <Spinner
                    className="mx-auto h-6 w-6"
                    innerSvgClass="stroke-primary"
                  />
                </TableCell>
              </TableRow>
            ) : suppressionsQuery.data?.suppressions.length === 0 ? (
              <TableRow className="h-32">
                <TableCell colSpan={4} className="py-4 text-center">
                  No suppressed emails found
                </TableCell>
              </TableRow>
            ) : (
              suppressionsQuery.data?.suppressions.map((suppression) => (
                <TableRow key={suppression.id}>
                  <TableCell className="font-medium">
                    {suppression.email}
                  </TableCell>
                  <TableCell>
                    <div
                      className={`w-[130px] rounded py-1 text-center text-xs capitalize ${
                        suppression.reason === SuppressionReason.HARD_BOUNCE
                          ? "border border-red/20 bg-red/15 text-red"
                          : suppression.reason === SuppressionReason.COMPLAINT
                            ? "border border-yellow/20 bg-yellow/15 text-yellow"
                            : "border border-blue/20 bg-blue/15 text-blue"
                      }`}
                    >
                      {reasonLabels[suppression.reason]}
                    </div>
                  </TableCell>

                  <TableCell className="text-muted-foreground">
                    {formatDistanceToNow(new Date(suppression.createdAt), {
                      addSuffix: true,
                    })}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEmailToRemove(suppression.email)}
                      disabled={remove.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex justify-end gap-4">
        <Button
          size="sm"
          onClick={() => goToPage(search.page - 1)}
          disabled={search.page === 1}
        >
          Previous
        </Button>
        <Button
          size="sm"
          onClick={() => goToPage(search.page + 1)}
          disabled={!suppressionsQuery.data?.pagination.hasNext}
        >
          Next
        </Button>
      </div>

      <RemoveSuppressionDialog
        email={emailToRemove}
        open={Boolean(emailToRemove)}
        onOpenChange={(open) => !open && setEmailToRemove(null)}
        onConfirm={() =>
          emailToRemove
            ? remove.mutate({ data: { email: emailToRemove } })
            : undefined
        }
        isLoading={remove.isPending}
      />
    </div>
  );
}
