import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import React from "react";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@usesend/ui/src/breadcrumb";
import { Button } from "@usesend/ui/src/button";
import { Switch } from "@usesend/ui/src/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@usesend/ui/src/table";
import { TextWithCopyButton } from "@usesend/ui/src/text-with-copy";
import { toast } from "@usesend/ui/src/toaster";

import { domainKeys, domainQueries } from "~/queries/domain";
import { startVerification, updateDomain } from "~/server/functions/domain";
import { DomainStatus } from "~/types/db";
import type { DomainWithDnsRecords } from "~/types/domain";
import DeleteDomain from "./-delete-domain";
import { DomainStatusBadge } from "./-domain-badge";
import SendTestMail from "./-send-test-mail";

/**
 * `/domains/$domainId`.
 *
 * `domainId` is a string in the URL and a number in the database, so the
 * parse happens once here rather than at every `Number(...)` call site the
 * Next.js page had.
 */
export const Route = createFileRoute("/_dashboard/domains/$domainId")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(
      domainQueries.detail(Number(params.domainId)),
    ),
  component: DomainPage,
});

function DomainPage() {
  const { domainId } = Route.useParams();
  const id = Number(domainId);
  const queryClient = useQueryClient();

  const domainQuery = useQuery({
    ...domainQueries.detail(id),
    // A verification in flight resolves within a minute or so, and the page is
    // the only thing that will tell the user it finished.
    refetchInterval: (query) => (query.state.data?.isVerifying ? 10_000 : false),
    refetchIntervalInBackground: true,
  });

  const verify = useMutation({
    mutationFn: startVerification,
    onSettled: () => domainQuery.refetch(),
  });

  if (domainQuery.isLoading) {
    return <p>Loading...</p>;
  }

  const domain = domainQuery.data;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link to="/domains" className="text-lg">
                    Domains
                  </Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="text-lg" />
              <BreadcrumbItem>
                <BreadcrumbPage className="text-lg">
                  {domain?.name}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>

          <DomainStatusBadge
            status={domain?.status ?? DomainStatus.NOT_STARTED}
          />
        </div>
        <div className="flex gap-4">
          <Button
            variant="outline"
            onClick={() => verify.mutate({ data: { id } })}
          >
            {domain?.isVerifying
              ? "Verifying..."
              : domain?.status === DomainStatus.SUCCESS
                ? "Verify again"
                : "Verify domain"}
          </Button>
          {domain ? <SendTestMail domain={domain} /> : null}
        </div>
      </div>

      <div className="rounded-lg border p-4 shadow">
        <p className="text-xl font-semibold">DNS records</p>
        <Table className="mt-2">
          <TableHeader>
            <TableRow>
              <TableHead className="rounded-tl-xl">Type</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Content</TableHead>
              <TableHead>TTL</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead className="rounded-tr-xl">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(domain?.dnsRecords ?? []).map((record) => {
              const valueClassName = record.name.includes("_domainkey")
                ? "w-[200px] overflow-hidden text-ellipsis"
                : "w-[200px] overflow-hidden text-ellipsis text-nowrap";

              return (
                <TableRow key={`${record.type}-${record.name}`}>
                  <TableCell>{record.type}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {record.recommended ? (
                        <span className="text-sm text-muted-foreground">
                          (recommended)
                        </span>
                      ) : null}
                      <TextWithCopyButton value={record.name} />
                    </div>
                  </TableCell>
                  <TableCell>
                    <TextWithCopyButton
                      value={record.value}
                      className={valueClassName}
                    />
                  </TableCell>
                  <TableCell>{record.ttl}</TableCell>
                  <TableCell>{record.priority ?? ""}</TableCell>
                  <TableCell>
                    <DnsVerificationStatus status={record.status} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {domain ? (
        <DomainSettings
          domain={domain}
          onChanged={() =>
            queryClient.invalidateQueries({ queryKey: domainKeys.all })
          }
        />
      ) : null}
    </div>
  );
}

const DomainSettings: React.FC<{
  domain: DomainWithDnsRecords;
  onChanged: () => void;
}> = ({ domain, onChanged }) => {
  const update = useMutation({ mutationFn: updateDomain });

  const [clickTracking, setClickTracking] = React.useState(domain.clickTracking);
  const [openTracking, setOpenTracking] = React.useState(domain.openTracking);

  function handleClickTrackingChange() {
    setClickTracking(!clickTracking);
    update.mutate(
      { data: { id: domain.id, clickTracking: !clickTracking } },
      {
        onSuccess: () => {
          onChanged();
          toast.success("Click tracking updated");
        },
      },
    );
  }

  function handleOpenTrackingChange() {
    setOpenTracking(!openTracking);
    update.mutate(
      { data: { id: domain.id, openTracking: !openTracking } },
      {
        onSuccess: () => {
          onChanged();
          toast.success("Open tracking updated");
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-6 rounded-lg border p-4 shadow">
      <p className="text-xl font-semibold">Settings</p>
      <div className="flex flex-col gap-1">
        <div className="font-semibold">Click tracking</div>
        <p className="text-sm text-muted-foreground">
          Track any links in your emails content.{" "}
        </p>
        <Switch
          checked={clickTracking}
          onCheckedChange={handleClickTrackingChange}
          className="data-[state=checked]:bg-success"
        />
      </div>

      <div className="flex flex-col gap-1">
        <div className="font-semibold">Open tracking</div>
        <p className="text-sm text-muted-foreground">
          Unsend adds a tracking pixel to every email you send. This allows you
          to see how many people open your emails. This will affect the delivery
          rate of your emails.
        </p>
        <Switch
          checked={openTracking}
          onCheckedChange={handleOpenTrackingChange}
          className="data-[state=checked]:bg-success"
        />
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-lg font-semibold text-destructive">Danger</p>

        <p className="text-sm font-semibold text-destructive">
          Deleting a domain will stop sending emails with this domain.
        </p>
        <DeleteDomain domain={domain} />
      </div>
    </div>
  );
};

const DnsVerificationStatus: React.FC<{ status: DomainStatus }> = ({
  status,
}) => {
  let badgeColor = "bg-gray/10 text-gray border-gray/10";

  switch (status) {
    case DomainStatus.SUCCESS:
      badgeColor = "bg-green/15 text-green border border-green/25";
      break;
    case DomainStatus.FAILED:
      badgeColor = "bg-red/10 text-red border border-red/10";
      break;
    case DomainStatus.TEMPORARY_FAILURE:
    case DomainStatus.PENDING:
      badgeColor = "bg-yellow/20 text-yellow border border-yellow/10";
      break;
    default:
      badgeColor = "bg-gray/10 text-gray border border-gray/20";
  }

  return (
    <div
      className={`flex min-w-[70px] items-center justify-center rounded-md py-1 text-center text-xs capitalize ${badgeColor}`}
    >
      {status.split("_").join(" ").toLowerCase()}
    </div>
  );
};
