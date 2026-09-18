import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";

import Spinner from "@usesend/ui/src/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@usesend/ui/src/table";

import { apiKeyQueries } from "~/queries/api-key";
import DeleteApiKey from "./-delete-api-key";
import { EditApiKey } from "./-edit-api-key";

export default function ApiList() {
  const apiKeysQuery = useQuery(apiKeyQueries.list());

  return (
    <div className="mt-10">
      <div className="rounded-xl border shadow">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30">
              <TableHead className="rounded-tl-xl">Name</TableHead>
              <TableHead>Token</TableHead>
              <TableHead>Permission</TableHead>
              <TableHead>Domain Access</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Created at</TableHead>
              <TableHead className="rounded-tr-xl">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {apiKeysQuery.isLoading ? (
              <TableRow className="h-32">
                <TableCell colSpan={7} className="py-4 text-center">
                  <Spinner
                    className="mx-auto h-6 w-6"
                    innerSvgClass="stroke-primary"
                  />
                </TableCell>
              </TableRow>
            ) : apiKeysQuery.data?.length === 0 ? (
              <TableRow className="h-32">
                <TableCell colSpan={7} className="py-4 text-center">
                  <p>No API keys added</p>
                </TableCell>
              </TableRow>
            ) : (
              apiKeysQuery.data?.map((apiKey) => (
                <TableRow key={apiKey.id}>
                  <TableCell>{apiKey.name}</TableCell>
                  <TableCell>{apiKey.partialToken}</TableCell>
                  <TableCell>{apiKey.permission}</TableCell>
                  <TableCell>
                    {apiKey.domainId
                      ? (apiKey.domain?.name ?? "Domain removed")
                      : "All domains"}
                  </TableCell>
                  <TableCell>
                    {apiKey.lastUsed
                      ? formatDistanceToNow(apiKey.lastUsed, {
                          addSuffix: true,
                        })
                      : "Never"}
                  </TableCell>
                  <TableCell>
                    {formatDistanceToNow(apiKey.createdAt, {
                      addSuffix: true,
                    })}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <EditApiKey apiKey={apiKey} />
                      <DeleteApiKey apiKey={apiKey} />
                    </div>
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
