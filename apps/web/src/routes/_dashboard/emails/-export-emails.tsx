import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";

import { Button } from "@usesend/ui/src/button";
import { toast } from "@usesend/ui/src/toaster";

import type { EmailExportFilters } from "~/queries/email";
import { emailQueries } from "~/queries/email";

/**
 * Downloads the current filter as a CSV.
 *
 * The query is disabled and fetched by hand: the export re-runs the whole
 * filter without a page limit, and nobody should pay for that just by opening
 * the log.
 *
 * Every cell is quoted defensively because the file is opened in a spreadsheet
 * and the subject line is attacker-controlled — a value starting with `=`, `+`,
 * `-` or `@` is a formula to Excel, so it gets a leading apostrophe.
 */
const escapeCsvValue = (value: unknown) => {
  const raw = String(value ?? "");
  const startsRisky = /^\s*[=+\-@]/.test(raw);
  const safe = (startsRisky ? "'" : "") + raw.replace(/"/g, '""');
  return /[",\r\n]/.test(safe) ? `"${safe}"` : safe;
};

const HEADER = [
  "To",
  "Status",
  "Subject",
  "Sent At",
  "Bounce Type",
  "Bounce Subtype",
  "Bounce Reason",
].join(",");

export default function ExportEmails({
  filters,
}: {
  filters: EmailExportFilters;
}) {
  const exportQuery = useQuery({
    ...emailQueries.exportList(filters),
    enabled: false,
  });

  async function handleExport() {
    const { data } = await exportQuery.refetch();

    if (!data) {
      toast.error("Could not export emails");
      return;
    }

    const rows = data.map((email) =>
      [
        email.to,
        email.status,
        email.subject,
        email.sentAt,
        email.bounceType,
        email.bounceSubType,
        email.bounceReason,
      ]
        .map(escapeCsvValue)
        .join(","),
    );

    // The BOM is what tells Excel the file is UTF-8; without it, every
    // non-ASCII recipient name is mojibake.
    const blob = new Blob(["﻿" + [HEADER, ...rows].join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `emails-${new Date().toISOString().split("T")[0]}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <Button
      variant="outline"
      onClick={handleExport}
      disabled={exportQuery.isFetching}
      className="w-full sm:w-auto"
    >
      <Download className="mr-2 h-4 w-4" />
      Export
    </Button>
  );
}
