import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { AnimatePresence, motion } from "framer-motion";

import { Card, CardContent, CardHeader, CardTitle } from "@usesend/ui/src/card";
import Spinner from "@usesend/ui/src/spinner";

import { campaignQueries } from "~/queries/campaign";
import { EmailStatusBadge } from "../../emails/-email-status-badge";

/**
 * The most recent sends for a campaign, animated as they arrive.
 *
 * Polls unconditionally every five seconds, unlike the campaign itself: this
 * is the panel someone leaves open while a campaign goes out, and the status
 * that stops the campaign polling (`SENT`) is exactly when the last of these
 * are still landing.
 *
 * `AnimatePresence` needs a stable key per row to animate an exit; the email
 * id is that key. `layout` is what moves the rows below a new arrival down
 * rather than snapping them.
 */
export function LiveActivity({ campaignId }: { campaignId: string }) {
  const emailsQuery = useQuery({
    ...campaignQueries.latestEmails(campaignId),
    refetchInterval: 5000,
  });

  return (
    <Card>
      <CardHeader className="flex gap-2">
        <CardTitle className="font-mono text-sm">Live activity</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex h-[300px] flex-col">
          {emailsQuery.isLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner className="h-5 w-5 text-foreground" />
            </div>
          ) : !emailsQuery.data?.length ? (
            <div className="flex flex-1 items-center justify-center">
              <div className="rounded text-sm text-muted-foreground">
                No recent user actions yet.
              </div>
            </div>
          ) : (
            <div className="no-scrollbar space-y-4 overflow-y-auto overscroll-y-contain pr-1">
              <AnimatePresence initial>
                {emailsQuery.data.map((email) => {
                  const recipient = email.to?.[0] ?? "Unknown recipient";

                  // A scheduled send has not happened yet, so `updatedAt` is
                  // when the row was written, not when anything reached
                  // anyone. The time it claims is the time it will go out.
                  const timestamp =
                    email.latestStatus === "SCHEDULED" && email.scheduledAt
                      ? new Date(email.scheduledAt)
                      : new Date(email.updatedAt ?? email.createdAt);

                  return (
                    <motion.div
                      key={email.id}
                      layout
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -12 }}
                      transition={{ duration: 0.2, ease: "easeOut" }}
                      className="flex flex-col gap-2 border-b pb-4 last:border-b-0 last:pb-0"
                    >
                      <div className="font-mono text-sm">{recipient}</div>
                      <div className="flex items-center justify-between gap-3">
                        <EmailStatusBadge status={email.latestStatus} />
                        <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                          {formatDistanceToNow(timestamp, { addSuffix: true })}
                        </span>
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default LiveActivity;
