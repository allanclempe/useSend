import { redirect } from "next/navigation";

import { headers } from "next/headers";
import { getServerAuthSession } from "~/server/auth";
import { VerifyOtp } from "./verify-otp";

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
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; otp?: string; inviteId?: string }>;
}) {
  const session = await getServerAuthSession(await headers());

  if (session) {
    redirect("/dashboard");
  }

  const { email, otp, inviteId } = await searchParams;

  if (!email || !otp) {
    redirect("/login");
  }

  return <VerifyOtp email={email} otp={otp} inviteId={inviteId} />;
}
