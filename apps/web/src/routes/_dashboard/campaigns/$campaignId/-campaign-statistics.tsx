import { Card, CardContent, CardHeader, CardTitle } from "@usesend/ui/src/card";

/**
 * Delivered, and the three outcomes measured against it.
 *
 * The denominator is **delivered**, not sent, and that is the whole point of
 * the card: an open rate over everything that was queued would quietly reward
 * a campaign for bouncing.
 */

const indicatorClasses: Record<string, string> = {
  delivered: "bg-green",
  unsubscribed: "bg-red",
  clicked: "bg-blue",
  opened: "bg-purple",
};

export function CampaignStatistics({
  total,
  processed,
  delivered,
  opened,
  clicked,
  unsubscribed,
}: {
  total: number;
  processed: number;
  delivered: number;
  opened: number;
  clicked: number;
  unsubscribed: number;
}) {
  const share = (value: number) =>
    delivered > 0 ? (value / delivered) * 100 : 0;

  const rows = [
    {
      status: "delivered",
      count: delivered,
      percentage: delivered > 0 ? 100 : 0,
    },
    {
      status: "unsubscribed",
      count: unsubscribed,
      percentage: share(unsubscribed),
    },
    { status: "clicked", count: clicked, percentage: share(clicked) },
    { status: "opened", count: opened, percentage: share(opened) },
  ];

  return (
    <Card>
      <CardHeader className="space-y-4">
        <div className="flex flex-col gap-1">
          <CardTitle className="font-mono text-sm">Statistics</CardTitle>
          {total > 0 ? (
            <div className="font-mono text-sm text-muted-foreground">
              {processed.toLocaleString()} of {total.toLocaleString()} processed
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              No recipients processed yet
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.map((row, index) => (
          <div
            key={row.status}
            className={`flex items-center justify-between gap-4 px-0 pb-3 ${
              index === rows.length - 1
                ? ""
                : "border-b border-dashed border-border"
            }`}
          >
            <div className="flex items-center gap-3">
              <div
                className={`h-2.5 w-2.5 rounded-[2px] ${
                  indicatorClasses[row.status] ?? "bg-gray"
                }`}
              />
              <div className="text-sm capitalize">{row.status}</div>
            </div>
            <div className="text-right">
              <div className="font-mono text-xl">{row.count}</div>
              {row.status === "delivered" ? null : (
                <div className="text-xs text-muted-foreground">
                  {row.percentage.toFixed(1)}% of delivered
                </div>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export default CampaignStatistics;
