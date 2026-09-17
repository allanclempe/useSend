import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

import { getSessionState } from "~/server/functions/session";
import { VerifyOtp } from "./-verify-otp";

/**
 * Target of the link in the sign-in email.
 *
 * better-auth's `emailOTP` plugin is a code-only flow with no URL of its own,
 * so the "click here" half of the email points here and this page submits the
 * code on the user's behalf. Keeping both affordances in one email preserves
 * the existing experience without adopting the `magicLink` plugin, whose
 * token-only lookup would make a five-character code guessable for any account
 * rather than only for a known address.
 */
export const Route = createFileRoute("/login/verify")({
  validateSearch: z.object({
    email: z.string().optional(),
    otp: z.string().optional(),
    inviteId: z.string().optional(),
  }),
  beforeLoad: async ({ search }) => {
    if ((await getSessionState()).signedIn) {
      throw redirect({ to: "/dashboard" });
    }

    if (!search.email || !search.otp) {
      throw redirect({ to: "/login" });
    }
  },
  component: Verify,
});

function Verify() {
  const { email, otp, inviteId } = Route.useSearch();

  // `beforeLoad` has already redirected when either is missing; the assertion
  // is only here because `validateSearch` cannot express "both or neither".
  return <VerifyOtp email={email!} otp={otp!} inviteId={inviteId} />;
}
