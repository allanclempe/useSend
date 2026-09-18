import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

import { getAuthProviders, getSessionState } from "~/server/functions/session";
import LoginPage from "./-login-page";

/**
 * `/login`.
 *
 * The two search params the page reads are declared here rather than pulled
 * out of `window.location` inside the component, which is what
 * `useSearchParams()` was doing. They are typed, they survive SSR, and
 * `?error=` in particular arrives from better-auth's OAuth callback — a value
 * from outside the application, which is exactly the kind that should meet a
 * schema at the boundary.
 */
const searchSchema = z.object({
  inviteId: z.string().optional(),
  error: z.string().optional(),
});

export const Route = createFileRoute("/login/")({
  validateSearch: searchSchema,
  beforeLoad: async () => {
    if ((await getSessionState()).signedIn) {
      throw redirect({ to: "/dashboard" });
    }
  },
  loader: () => getAuthProviders(),
  component: Login,
});

function Login() {
  const providers = Route.useLoaderData();
  const { inviteId, error } = Route.useSearch();

  return (
    <LoginPage providers={providers} inviteId={inviteId} error={error} />
  );
}
