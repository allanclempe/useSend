import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

import { getAuthProviders, getSessionState } from "~/server/functions/session";
import LoginPage from "./login/-login-page";

/**
 * `/signup` — the same page as `/login` with different copy, which is how it
 * already was. Whether an account is actually created is decided by the
 * registration gate in `server/self-hosted-registration.ts`, not here.
 */
export const Route = createFileRoute("/signup")({
  validateSearch: z.object({
    inviteId: z.string().optional(),
    error: z.string().optional(),
  }),
  beforeLoad: async () => {
    if ((await getSessionState()).signedIn) {
      throw redirect({ to: "/dashboard" });
    }
  },
  loader: () => getAuthProviders(),
  component: Signup,
});

function Signup() {
  const providers = Route.useLoaderData();
  const { inviteId, error } = Route.useSearch();

  return (
    <LoginPage
      providers={providers}
      isSignup
      inviteId={inviteId}
      error={error}
    />
  );
}
