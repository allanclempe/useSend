import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { Download } from "lucide-react";
import { useState } from "react";
import { useDebouncedCallback } from "use-debounce";

import { Button } from "@usesend/ui/src/button";
import { Input } from "@usesend/ui/src/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@usesend/ui/src/tooltip";
import { toast } from "@usesend/ui/src/toaster";

import { getContactPropertyValue } from "~/lib/contact-properties";
import { contactQueries } from "~/queries/contacts";
import { UnsubscribeReason } from "~/types/db";
import DeleteContact from "./-delete-contact";
import EditContact from "./-edit-contact";
import { ResendDoubleOptInConfirmation } from "./-resend-double-opt-in-confirmation";
import { subscribedFromStatus } from "./index";

const route = getRouteApi("/_dashboard/contacts/$contactBookId/");

function sanitizeFilename(
  name: string | undefined,
  fallback = "contacts",
): string {
  if (!name) return fallback;

  // Remove or replace unsafe characters:
  // - Path separators: / \
  // - Reserved characters: : * ? " < > |
  // - Control characters (0x00-0x1F, 0x7F)
  // - Single quotes and backticks
  // The control characters are the point: they are what has to come out of a
  // filename, so `no-control-regex` has nothing useful to say here.
  // eslint-disable-next-line no-control-regex
  const sanitized = name.replace(/[/\\:*?"<>|'\x00-\x1F\x7F]/g, "-").trim();

  // Limit length to prevent excessively long filenames (max 100 chars)
  const limited = sanitized.slice(0, 100).trim();

  // Return fallback if result is empty after sanitization
  return limited || fallback;
}

function getUnsubscribeReason(reason: UnsubscribeReason) {
  switch (reason) {
    case UnsubscribeReason.BOUNCED:
      return "Email bounced";
    case UnsubscribeReason.COMPLAINED:
      return "User complained";
    case UnsubscribeReason.UNSUBSCRIBED:
      return "User unsubscribed";
    default:
      return "User unsubscribed";
  }
}

const escapeCell = (str: string): string => {
  // Wrap in quotes if contains comma, newline, or quote
  if (str.includes(",") || str.includes("\n") || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

export default function ContactList({
  contactBookId,
  contactBookName,
  doubleOptInEnabled,
  contactBookVariables,
}: {
  contactBookId: string;
  contactBookName?: string;
  doubleOptInEnabled?: boolean;
  contactBookVariables?: string[];
}) {
  const { page, status, search } = route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const pageNumber = page ?? 1;
  const subscribed = subscribedFromStatus(status);

  const contactsQuery = useQuery(
    contactQueries.list(contactBookId, {
      page: pageNumber,
      search,
      subscribed,
    }),
  );

  /**
   * Every filter writes the URL, and every filter that changes what is on page
   * one also clears the page. Leaving `page=4` while narrowing the results to
   * two was how the Next.js list showed an empty table with a live Previous
   * button.
   */
  const setSearchParams = (
    next: Partial<{ page?: number; status?: typeof status; search?: string }>,
  ) =>
    navigate({
      to: "/contacts/$contactBookId",
      params: { contactBookId },
      search: (prev) => ({ ...prev, ...next }),
      replace: true,
    });

  const debouncedSearch = useDebouncedCallback(
    (value: string) =>
      void setSearchParams({ search: value || undefined, page: undefined }),
    1000,
  );

  /**
   * The export is a one-shot read, not something the page keeps up to date, so
   * it is fetched imperatively rather than held as a disabled `useQuery` the
   * Next.js version had to `refetch()`. It still goes through the area's
   * `queryOptions` factory, so the key matches everything else.
   */
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    setIsExporting(true);

    try {
      const rows = await queryClient.fetchQuery(
        contactQueries.exportList(contactBookId, { search, subscribed }),
      );

      const headers = [
        "Email",
        "First Name",
        "Last Name",
        "Subscribed",
        "Unsubscribe Reason",
        "Created At",
        ...(contactBookVariables ?? []),
      ];

      const csvRows = rows.map((contact) => [
        escapeCell(contact.email ?? ""),
        escapeCell(contact.firstName ?? ""),
        escapeCell(contact.lastName ?? ""),
        escapeCell(contact.subscribed ? "Yes" : "No"),
        escapeCell(contact.unsubscribeReason ?? ""),
        escapeCell(new Date(contact.createdAt).toISOString()),
        ...(contactBookVariables ?? []).map((variable) =>
          escapeCell(
            getContactPropertyValue(
              contact.properties,
              variable,
              contactBookVariables ?? [],
            ) ?? "",
          ),
        ),
      ]);

      const csvContent = [
        headers.map(escapeCell).join(","),
        ...csvRows.map((row) => row.join(",")),
      ].join("\n");

      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const today = new Date().toISOString().split("T")[0];
      link.download = `contacts-${sanitizeFilename(contactBookName)}-${today}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to export contacts",
      );
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <TooltipProvider>
      <div className="mt-10 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <Input
              placeholder="Search by email or name"
              className="mr-4 w-[350px]"
              defaultValue={search ?? ""}
              onChange={(e) => debouncedSearch(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Select
              value={status ?? "All"}
              onValueChange={(value) =>
                void setSearchParams({
                  status:
                    value === "All"
                      ? undefined
                      : (value as "Subscribed" | "Unsubscribed"),
                  page: undefined,
                })
              }
            >
              <SelectTrigger className="w-[180px] capitalize">
                {status || "All statuses"}
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="All" className="capitalize">
                  All statuses
                </SelectItem>
                <SelectItem value="Subscribed" className="capitalize">
                  Subscribed
                </SelectItem>
                <SelectItem value="Unsubscribed" className="capitalize">
                  Unsubscribed
                </SelectItem>
              </SelectContent>
            </Select>
            <Button
              onClick={handleExport}
              disabled={isExporting}
              size="sm"
              variant="outline"
            >
              {isExporting ? (
                <Spinner
                  className="mr-2 h-4 w-4"
                  innerSvgClass="stroke-primary"
                />
              ) : (
                <Download className="mr-2 h-4 w-4" />
              )}
              Export
            </Button>
          </div>
        </div>
        <div className="border-broder flex flex-col rounded-xl border shadow">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30">
                <TableHead className="rounded-tl-xl">Email</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created At</TableHead>
                <TableHead className="rounded-tr-xl">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contactsQuery.isLoading ? (
                <TableRow className="h-32">
                  <TableCell colSpan={4} className="py-4 text-center">
                    <Spinner
                      className="mx-auto h-6 w-6"
                      innerSvgClass="stroke-primary"
                    />
                  </TableCell>
                </TableRow>
              ) : contactsQuery.data?.contacts.length ? (
                contactsQuery.data.contacts.map((contact) => {
                  const isPendingConfirmation =
                    Boolean(doubleOptInEnabled) &&
                    !contact.subscribed &&
                    !contact.unsubscribeReason;

                  return (
                    <TableRow key={contact.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          {/* Gravatar is a remote URL on a domain this app
                              does not control, and `next/image` is on its way
                              out with the rest of Next.js. */}
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={contact.gravatarUrl}
                            alt={`${contact.email}'s gravatar`}
                            width={35}
                            height={35}
                            className="rounded-full"
                          />
                          <div className="flex flex-col">
                            <span className="text-sm font-medium">
                              {contact.email}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {contact.firstName} {contact.lastName}
                            </span>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {contact.subscribed ? (
                          <div className="w-[130px] rounded border border-green/25 bg-green/15 py-1 text-center text-xs capitalize text-green">
                            Subscribed
                          </div>
                        ) : isPendingConfirmation ? (
                          <div className="w-[130px] rounded border border-yellow/20 bg-yellow/20 py-1 text-center text-xs capitalize text-yellow">
                            Pending
                          </div>
                        ) : (
                          <Tooltip>
                            <TooltipTrigger>
                              <div className="w-[130px] rounded border border-red/10 bg-red/10 py-1 text-center text-xs capitalize text-red">
                                Unsubscribed
                              </div>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>
                                {getUnsubscribeReason(
                                  contact.unsubscribeReason ??
                                    UnsubscribeReason.UNSUBSCRIBED,
                                )}
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </TableCell>
                      <TableCell>
                        {formatDistanceToNow(new Date(contact.createdAt), {
                          addSuffix: true,
                        })}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-2">
                          {isPendingConfirmation ? (
                            <ResendDoubleOptInConfirmation
                              contactBookId={contactBookId}
                              contactId={contact.id}
                              email={contact.email}
                            />
                          ) : null}
                          <EditContact
                            contact={contact}
                            contactBookVariables={contactBookVariables}
                          />
                          <DeleteContact contact={contact} />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow className="h-32">
                  <TableCell colSpan={4} className="py-4 text-center">
                    No contacts found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex justify-end gap-4">
          <Button
            size="sm"
            onClick={() => void setSearchParams({ page: pageNumber - 1 })}
            disabled={pageNumber === 1}
          >
            Previous
          </Button>
          <Button
            size="sm"
            onClick={() => void setSearchParams({ page: pageNumber + 1 })}
            disabled={pageNumber >= (contactsQuery.data?.totalPage ?? 0)}
          >
            Next
          </Button>
        </div>
      </div>
    </TooltipProvider>
  );
}
