import { createFileRoute } from "@tanstack/react-router";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@usesend/ui/src/card";
import { TextWithCopyButton } from "@usesend/ui/src/text-with-copy";

import { getSmtpSettings } from "~/server/functions/smtp";

/**
 * `/dev-settings/smtp`.
 *
 * The Next.js page was a server component reading `env` in its body. The two
 * values it wanted come from a server function now and arrive through the
 * loader, because they are configuration rather than data: nothing on the page
 * can change them, so there is no cache entry to invalidate and no query
 * options factory to write. `loading.tsx` goes with it — the loader resolves
 * before the route renders, so there is no in-between state to draw.
 */
export const Route = createFileRoute("/_dashboard/dev-settings/smtp")({
  loader: () => getSmtpSettings(),
  component: SmtpPage,
});

function SmtpPage() {
  const { host, user } = Route.useLoaderData();

  return (
    <Card className="mt-9 max-w-xl">
      <CardHeader>
        <CardTitle>SMTP</CardTitle>
        <CardDescription>
          Send emails using SMTP instead of the REST API. See documentation for
          more information.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          <div>
            <strong>Host:</strong>
            <TextWithCopyButton
              className="ml-1 mt-1 w-full rounded-lg border bg-primary/10 p-2"
              value={host}
            />
          </div>
          <div>
            <strong>Port:</strong>
            <TextWithCopyButton
              className="ml-1 mt-1 w-full rounded-lg bg-primary/10 p-2 font-mono"
              value="465"
            />
            <p className="ml-1 mt-1 text-sm text-zinc-500">
              For encrypted/TLS connections use{" "}
              <strong className="font-mono">2465</strong>,{" "}
              <strong className="font-mono">587</strong> or{" "}
              <strong className="font-mono">2587</strong>
            </p>
          </div>
          <div>
            <strong>User:</strong>
            <TextWithCopyButton
              className="ml-1 mt-1 w-full rounded-lg bg-primary/10 p-2"
              value={user}
            />
          </div>
          <div>
            <strong>Password:</strong>
            <TextWithCopyButton
              className="ml-1 mt-1 w-full rounded-lg bg-primary/10 p-2"
              value="YOUR_API_KEY"
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
