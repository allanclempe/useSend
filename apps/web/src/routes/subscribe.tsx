import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";

import { confirmSubscription } from "~/server/functions/public-subscription";

/**
 * `/subscribe` — the double-opt-in confirmation page.
 *
 * The URL is in delivered inboxes and its hash is keyed by `APP_SECRET`, which
 * cannot be rotated (`AGENTS.md`), so the path and all three parameters are
 * fixed. As on `/unsubscribe`, the confirmation is a **`POST`**: an email
 * client's link scanner will fetch this page on the recipient's behalf, and a
 * subscription confirmed by a scanner is not a confirmation. Next.js got the
 * same property from a form and a server action.
 *
 * The expiry is checked here as well as on the server, so an expired link says
 * so instead of offering a button that cannot work.
 */
const PUBLIC_ERRORS = new Set([
  "Invalid confirmation link",
  "Confirmation link has expired",
  "Contact not found",
]);

function publicMessage(error: unknown) {
  return error instanceof Error && PUBLIC_ERRORS.has(error.message)
    ? error.message
    : "Unable to confirm your subscription.";
}

export const Route = createFileRoute("/subscribe")({
  validateSearch: z.object({
    contactId: z.string().optional(),
    expiresAt: z.string().optional(),
    hash: z.string().optional(),
  }),
  component: SubscribePage,
});

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4 rounded-xl border p-8 shadow">
        <h1 className="text-center text-2xl font-semibold">{title}</h1>
        {children}
      </div>
    </div>
  );
}

function SubscribePage() {
  const { contactId, expiresAt, hash } = Route.useSearch();
  const [confirmed, setConfirmed] = useState(false);

  const confirm = useMutation({
    mutationFn: confirmSubscription,
    onSuccess: () => setConfirmed(true),
  });

  if (confirmed) {
    return (
      <Card title="Subscription Confirmed">
        <p className="text-center text-sm text-muted-foreground">
          Your subscription is confirmed and you will receive future emails.
        </p>
      </Card>
    );
  }

  const expiresAtTimestamp = Number(expiresAt);
  const hasValidExpiry = Number.isFinite(expiresAtTimestamp);

  if (!contactId || !expiresAt || !hash || !hasValidExpiry) {
    return (
      <Card title="Invalid Link">
        <p className="text-center text-sm text-muted-foreground">
          This confirmation link is invalid. Please request a new one.
        </p>
      </Card>
    );
  }

  if (Date.now() > expiresAtTimestamp) {
    return (
      <Card title="Confirmation Failed">
        <p className="text-center text-sm text-muted-foreground">
          Confirmation link has expired
        </p>
      </Card>
    );
  }

  return (
    <Card title="Confirm Subscription">
      <p className="text-center text-sm text-muted-foreground">
        Click the button below to confirm your subscription.
      </p>

      {confirm.isError ? (
        <p role="alert" className="text-center text-sm text-red">
          {publicMessage(confirm.error)}
        </p>
      ) : null}

      <div className="pt-2">
        <button
          type="button"
          onClick={() =>
            confirm.mutate({ data: { contactId, expiresAt, hash } })
          }
          disabled={confirm.isPending}
          className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {confirm.isPending ? "Confirming…" : "Confirm subscription"}
        </button>
      </div>
    </Card>
  );
}
