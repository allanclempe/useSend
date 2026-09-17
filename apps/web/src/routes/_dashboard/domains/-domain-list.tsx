import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import React from "react";

import Spinner from "@usesend/ui/src/spinner";
import { Switch } from "@usesend/ui/src/switch";

import { domainKeys, domainQueries } from "~/queries/domain";
import { updateDomain } from "~/server/functions/domain";
import type { Domain } from "~/types/db";
import { DomainStatusBadge } from "./-domain-badge";
import { StatusIndicator } from "./-status-indicator";

export default function DomainsList() {
  const domainsQuery = useQuery(domainQueries.list());

  return (
    <div className="mt-10">
      <div className="flex flex-col gap-6">
        {domainsQuery.isLoading ? (
          <div className="mt-10 flex justify-center">
            <Spinner
              className="mx-auto h-6 w-6"
              innerSvgClass="stroke-primary"
            />
          </div>
        ) : domainsQuery.data?.length ? (
          domainsQuery.data.map((domain) => (
            <DomainItem key={domain.id} domain={domain} />
          ))
        ) : (
          <div className="mt-20 text-center">No domains Added</div>
        )}
      </div>
    </div>
  );
}

const DomainItem: React.FC<{ domain: Domain }> = ({ domain }) => {
  const queryClient = useQueryClient();

  const update = useMutation({
    mutationFn: updateDomain,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: domainKeys.all }),
  });

  const [clickTracking, setClickTracking] = React.useState(domain.clickTracking);
  const [openTracking, setOpenTracking] = React.useState(domain.openTracking);

  function handleClickTrackingChange() {
    setClickTracking(!clickTracking);
    update.mutate({ data: { id: domain.id, clickTracking: !clickTracking } });
  }

  function handleOpenTrackingChange() {
    setOpenTracking(!openTracking);
    update.mutate({ data: { id: domain.id, openTracking: !openTracking } });
  }

  return (
    <div key={domain.id}>
      <div className="flex items-stretch rounded-lg border pr-8 shadow">
        <StatusIndicator status={domain.status} />
        <div className="flex w-full justify-between py-4 pl-8">
          <div className="flex w-1/5 flex-col gap-4">
            <Link
              to="/domains/$domainId"
              params={{ domainId: String(domain.id) }}
              className="text-lg font-medium underline decoration-dashed underline-offset-4"
            >
              {domain.name}
            </Link>
            <DomainStatusBadge status={domain.status} />
          </div>

          <div className="flex flex-col gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Created at</p>
              <p className="text-sm">
                {formatDistanceToNow(new Date(domain.createdAt), {
                  addSuffix: true,
                })}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Region</p>
              <p className="flex items-center gap-2 text-sm">{domain.region}</p>
            </div>
          </div>
          <div className="flex flex-col gap-6">
            <div className="flex items-center gap-2">
              <p className="text-sm">Click tracking</p>
              <Switch
                checked={clickTracking}
                onCheckedChange={handleClickTrackingChange}
                className="data-[state=checked]:bg-success"
              />
            </div>
            <div className="flex items-center gap-2">
              <p className="text-sm">Open tracking</p>
              <Switch
                checked={openTracking}
                onCheckedChange={handleOpenTrackingChange}
                className="data-[state=checked]:bg-success"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
