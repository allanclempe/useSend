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
import { TextWithCopyButton } from "@usesend/ui/src/text-with-copy";

import { adminQueries } from "~/queries/admin";
import EditSesConfiguration from "./-edit-ses-configuration";

/** The eight-column table is eight columns wide in its empty states too. */
const COLUMN_COUNT = 8;

export default function SesConfigurations() {
  const sesSettingsQuery = useQuery(adminQueries.sesSettings());

  return (
    <div className="rounded-xl border shadow">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/30">
            <TableHead className="rounded-tl-xl">Region</TableHead>
            <TableHead>Prefix Key</TableHead>
            <TableHead>Callback URL</TableHead>
            <TableHead>Callback status</TableHead>
            <TableHead>Created at</TableHead>
            <TableHead>Send rate</TableHead>
            <TableHead>Transactional quota</TableHead>
            <TableHead className="rounded-tr-xl">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sesSettingsQuery.isLoading ? (
            <TableRow className="h-32">
              <TableCell colSpan={COLUMN_COUNT} className="py-4 text-center">
                <Spinner
                  className="mx-auto h-6 w-6"
                  innerSvgClass="stroke-primary"
                />
              </TableCell>
            </TableRow>
          ) : sesSettingsQuery.data?.length === 0 ? (
            <TableRow className="h-32">
              <TableCell colSpan={COLUMN_COUNT} className="py-4 text-center">
                <p>No SES configurations added</p>
              </TableCell>
            </TableRow>
          ) : (
            sesSettingsQuery.data?.map((sesSetting) => (
              <TableRow key={sesSetting.id}>
                <TableCell>{sesSetting.region}</TableCell>
                <TableCell>{sesSetting.idPrefix}</TableCell>
                <TableCell>
                  <TextWithCopyButton
                    value={sesSetting.callbackUrl}
                    className="w-[200px] overflow-hidden text-ellipsis"
                  />
                </TableCell>
                <TableCell>
                  {sesSetting.callbackSuccess ? "Success" : "Failed"}
                </TableCell>
                <TableCell>
                  {formatDistanceToNow(sesSetting.createdAt, {
                    addSuffix: true,
                  })}
                </TableCell>
                <TableCell>{sesSetting.sesEmailRateLimit}</TableCell>
                <TableCell>{sesSetting.transactionalQuota}%</TableCell>
                <TableCell>
                  <EditSesConfiguration setting={sesSetting} />
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
