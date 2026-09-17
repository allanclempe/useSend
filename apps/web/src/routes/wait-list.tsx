import { createFileRoute, redirect } from "@tanstack/react-router";
import { Rocket } from "lucide-react";

import { getSessionState } from "~/server/functions/session";

/**
 * `/wait-list` — where a signed-in but not-yet-admitted user lands.
 *
 * The form that submits a request is still in the Next.js app: it posts
 * through the `waitlist` router, which has not moved yet. What is here is the
 * gate and the copy, so the redirect from `/` and from the dashboard layout
 * has somewhere real to go.
 */
export const Route = createFileRoute("/wait-list")({
  beforeLoad: async () => {
    const { signedIn, isWaitlisted } = await getSessionState();

    if (!signedIn) {
      throw redirect({ to: "/login" });
    }

    if (!isWaitlisted) {
      throw redirect({ to: "/dashboard" });
    }
  },
  component: WaitList,
});

function WaitList() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="flex w-full max-w-xl flex-col gap-6 rounded-lg border bg-card p-8 shadow-lg">
        <div className="flex items-center gap-3">
          <span className="rounded-full bg-primary/10 p-2 text-primary">
            <Rocket className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-semibold">You&apos;re on the waitlist</h1>
            <p className="text-sm text-muted-foreground">
              Share a bit more context so we can prioritize your access.
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          The request form has not moved off Next.js yet.
        </div>
      </div>
    </div>
  );
}
