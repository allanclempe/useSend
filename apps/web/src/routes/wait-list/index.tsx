import { createFileRoute, redirect } from "@tanstack/react-router";
import { Rocket } from "lucide-react";

import { getSessionState, getSessionUser } from "~/server/functions/session";
import { WaitListForm } from "./-waitlist-form";

/**
 * `/wait-list` — where a signed-in but not-yet-admitted user lands.
 *
 * The address is loaded server-side rather than read from better-auth's client
 * store, because the form shows it as the contact address the founders will
 * reply to and a blank field there while the session hydrates reads as a bug.
 */
export const Route = createFileRoute("/wait-list/")({
  beforeLoad: async () => {
    const { signedIn, isWaitlisted } = await getSessionState();

    if (!signedIn) {
      throw redirect({ to: "/login" });
    }

    if (!isWaitlisted) {
      throw redirect({ to: "/dashboard" });
    }
  },
  loader: () => getSessionUser(),
  component: WaitList,
});

function WaitList() {
  const user = Route.useLoaderData();

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="flex w-full max-w-xl flex-col gap-6 rounded-lg border bg-card p-8 shadow-lg">
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-primary/10 p-2 text-primary">
            <Rocket className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold">
              You&apos;re on the waitlist
            </h1>
            <p className="text-sm text-muted-foreground">
              Share a bit more context so we can prioritize your access.
            </p>
          </div>
        </div>

        <WaitListForm userEmail={user?.email ?? ""} />
      </div>
    </div>
  );
}
