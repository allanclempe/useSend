import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { formatDate } from "date-fns";
import { useDebouncedCallback } from "use-debounce";

import { Button } from "@usesend/ui/src/button";
import { Input } from "@usesend/ui/src/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@usesend/ui/src/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@usesend/ui/src/sheet";
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

import { DEFAULT_QUERY_LIMIT } from "~/lib/constants";
import { apiKeyQueries } from "~/queries/api-key";
import { domainQueries } from "~/queries/domain";
import { emailQueries } from "~/queries/email";
import type { EmailSearch } from "./-email-filters";
import { emailListFilters, FILTERABLE_STATUSES } from "./-email-filters";
import EmailDetails from "./-email-details";
import { EmailStatusBadge } from "./-email-status-badge";
import ExportEmails from "./-export-emails";

const ALL_API_KEYS = "All API Keys";
const ALL_DOMAINS = "All Domains";
const ALL_STATUSES = "All statuses";

const route = getRouteApi("/_dashboard/emails/");

export default function EmailList() {
  const search = route.useSearch();
  const navigate = route.useNavigate();

  const filters = emailListFilters(search);
  const emailsQuery = useQuery(emailQueries.list(filters));
  const domainsQuery = useQuery(domainQueries.list());
  const apiKeysQuery = useQuery(apiKeyQueries.list());

  /**
   * Choosing a filter is a deliberate act, so it gets a history entry and the
   * back button undoes it. Typing in the search box is not — it fires once a
   * second and would otherwise bury the page the user came from.
   *
   * Any filter change also returns to page one. The Next.js version kept the
   * page number, which left you looking at page 3 of a list the new filter had
   * just made one page long.
   */
  function setFilter(next: Partial<EmailSearch>, replace = false) {
    void navigate({
      search: (prev) => ({ ...prev, ...next, page: 1 }),
      replace,
    });
  }

  function goToPage(page: number) {
    void navigate({ search: (prev) => ({ ...prev, page }) });
  }

  /**
   * The sheet is a view of the row, not a place. It replaces the current entry
   * so that closing it and pressing back does not walk the user through every
   * email they peeked at.
   */
  function setSelectedEmail(emailId: string | undefined) {
    void navigate({
      search: (prev) => ({ ...prev, emailId }),
      replace: true,
      resetScroll: false,
    });
  }

  const debouncedSearch = useDebouncedCallback((value: string) => {
    setFilter({ search: value || undefined }, true);
  }, 1000);

  return (
    <div className="mt-10 flex flex-col gap-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-0">
        <Input
          placeholder="Search by subject or email"
          className="w-full sm:mr-4 sm:w-[350px]"
          defaultValue={search.search ?? ""}
          onChange={(e) => debouncedSearch(e.target.value)}
        />
        <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Select
            value={search.apikey ? String(search.apikey) : ALL_API_KEYS}
            onValueChange={(value) =>
              setFilter({
                apikey: value === ALL_API_KEYS ? undefined : Number(value),
              })
            }
          >
            <SelectTrigger className="w-full sm:w-[180px]">
              {search.apikey
                ? apiKeysQuery.data?.find((key) => key.id === search.apikey)
                    ?.name
                : ALL_API_KEYS}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_API_KEYS}>{ALL_API_KEYS}</SelectItem>
              {apiKeysQuery.data?.map((apiKey) => (
                <SelectItem key={apiKey.id} value={apiKey.id.toString()}>
                  {apiKey.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={search.domain ? String(search.domain) : ALL_DOMAINS}
            onValueChange={(value) =>
              setFilter({
                domain: value === ALL_DOMAINS ? undefined : Number(value),
              })
            }
          >
            <SelectTrigger className="w-full sm:w-[180px]">
              {search.domain
                ? domainsQuery.data?.find(
                    (domain) => domain.id === search.domain,
                  )?.name
                : ALL_DOMAINS}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_DOMAINS} className="capitalize">
                {ALL_DOMAINS}
              </SelectItem>
              {domainsQuery.data?.map((domain) => (
                <SelectItem key={domain.id} value={domain.id.toString()}>
                  {domain.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={search.status ?? ALL_STATUSES}
            onValueChange={(value) =>
              setFilter({
                status:
                  value === ALL_STATUSES
                    ? undefined
                    : (value as EmailSearch["status"]),
              })
            }
          >
            <SelectTrigger className="w-full capitalize sm:w-[180px]">
              {search.status
                ? search.status.toLowerCase().replace("_", " ")
                : ALL_STATUSES}
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_STATUSES} className="capitalize">
                {ALL_STATUSES}
              </SelectItem>
              {FILTERABLE_STATUSES.map((status) => (
                <SelectItem key={status} value={status} className="capitalize">
                  {status.toLowerCase().replace("_", " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ExportEmails filters={filters} />
        </div>
      </div>
      <div className="flex flex-col rounded-xl border shadow">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted dark:bg-muted/70">
              <TableHead className="rounded-tl-xl">To</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead className="rounded-tr-xl text-right">
                Sent at
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {emailsQuery.isLoading ? (
              <TableRow className="h-32">
                <TableCell colSpan={4} className="py-4 text-center">
                  <Spinner
                    className="mx-auto h-6 w-6"
                    innerSvgClass="stroke-primary"
                  />
                </TableCell>
              </TableRow>
            ) : emailsQuery.data?.emails.length ? (
              emailsQuery.data.emails.map((email) => (
                <TableRow
                  key={email.id}
                  onClick={() => setSelectedEmail(email.id)}
                  className="cursor-pointer"
                >
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-4">
                      <p>{email.to}</p>
                    </div>
                  </TableCell>
                  <TableCell>
                    {email.latestStatus === "SCHEDULED" && email.scheduledAt ? (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger>
                            <EmailStatusBadge
                              status={email.latestStatus ?? "SENT"}
                            />
                          </TooltipTrigger>
                          <TooltipContent>
                            Scheduled at{" "}
                            {formatDate(
                              email.scheduledAt,
                              "MMM dd'th', hh:mm a",
                            )}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : (
                      <EmailStatusBadge status={email.latestStatus ?? "SENT"} />
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="max-w-xs truncate">{email.subject}</div>
                  </TableCell>
                  <TableCell className="text-right">
                    {email.latestStatus !== "SCHEDULED"
                      ? formatDate(
                          email.scheduledAt ?? email.createdAt,
                          "MMM do, hh:mm a",
                        )
                      : "--"}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow className="h-32">
                <TableCell colSpan={4} className="py-4 text-center">
                  No emails found
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        {/*
          Radix renders a portal only once it has mounted, so this survives the
          server render on its own — the `next/dynamic` wrappers the Next.js
          page wrapped it in were working around a Next-specific hydration bug
          and have no counterpart here.
        */}
        <Sheet
          open={Boolean(search.emailId)}
          onOpenChange={(isOpen) => {
            if (!isOpen) {
              setSelectedEmail(undefined);
            }
          }}
        >
          <SheetContent className="no-scrollbar overflow-y-auto sm:max-w-3xl">
            <SheetTitle className="sr-only">Email Details</SheetTitle>
            <SheetDescription className="sr-only">
              Detailed view of the selected email.
            </SheetDescription>
            {search.emailId ? <EmailDetails emailId={search.emailId} /> : null}
          </SheetContent>
        </Sheet>
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
          disabled={emailsQuery.data?.emails.length !== DEFAULT_QUERY_LIMIT}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
