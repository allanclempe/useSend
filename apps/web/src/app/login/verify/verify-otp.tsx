"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Spinner from "@usesend/ui/src/spinner";

import { authClient } from "~/lib/auth-client";
import { GENERIC_AUTH_ERROR_MESSAGE } from "../auth-error";

export function VerifyOtp({
  email,
  otp,
  inviteId,
}: {
  email: string;
  otp: string;
  inviteId?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  // React runs effects twice in development. Submitting the code twice would
  // burn one of the three allowed attempts and, worse, the second call can land
  // after the first has already consumed the code — reporting a failure for a
  // sign-in that actually succeeded.
  const submitted = useRef(false);

  useEffect(() => {
    if (submitted.current) return;
    submitted.current = true;

    authClient.signIn
      .emailOtp({ email, otp })
      .then(({ error: signInError }) => {
        if (signInError) {
          setError(signInError.message ?? GENERIC_AUTH_ERROR_MESSAGE);
          return;
        }

        window.location.href = inviteId
          ? `/join-team?inviteId=${inviteId}`
          : "/dashboard";
      })
      .catch(() => setError(GENERIC_AUTH_ERROR_MESSAGE));
  }, [email, otp, inviteId]);

  return (
    <main className="flex h-screen items-center justify-center">
      {error ? (
        <div className="flex w-[350px] flex-col gap-4 text-center">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Link href="/login" className="text-sm underline">
            Back to sign in
          </Link>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4">
          <Spinner className="h-6 w-6" innerSvgClass="stroke-primary" />
          <p className="text-sm text-muted-foreground">Signing you in...</p>
        </div>
      )}
    </main>
  );
}
