import { useQuery } from "@tanstack/react-query";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@usesend/ui/src/select";
import { Tabs, TabsList, TabsTrigger } from "@usesend/ui/src/tabs";

import { domainQueries } from "~/queries/domain";

const ALL_DOMAINS = "All Domains";

export function DashboardFilters({
  days,
  domain,
  onDaysChange,
  onDomainChange,
}: {
  days: number;
  domain: number | undefined;
  onDaysChange: (days: number) => void;
  onDomainChange: (domain: number | undefined) => void;
}) {
  const domainsQuery = useQuery(domainQueries.list());

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <Select
        value={domain === undefined ? ALL_DOMAINS : String(domain)}
        onValueChange={(value) =>
          onDomainChange(value === ALL_DOMAINS ? undefined : Number(value))
        }
      >
        <SelectTrigger className="w-full sm:w-[180px]">
          {domain === undefined
            ? ALL_DOMAINS
            : (domainsQuery.data?.find((d) => d.id === domain)?.name ??
              ALL_DOMAINS)}
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_DOMAINS} className="capitalize">
            {ALL_DOMAINS}
          </SelectItem>
          {domainsQuery.data?.map((d) => (
            <SelectItem key={d.id} value={String(d.id)}>
              {d.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Tabs value={String(days)} onValueChange={(v) => onDaysChange(Number(v))}>
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="7" className="flex-1 sm:flex-none">
            7 Days
          </TabsTrigger>
          <TabsTrigger value="30" className="flex-1 sm:flex-none">
            30 Days
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}

export default DashboardFilters;
