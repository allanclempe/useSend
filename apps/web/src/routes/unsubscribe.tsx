import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";

import { Button } from "@usesend/ui/src/button";
import Spinner from "@usesend/ui/src/spinner";
import { toast } from "@usesend/ui/src/toaster";

import { reSubscribeContact } from "~/server/functions/campaign";
import {
  lookupUnsubscribeTarget,
  unsubscribe,
} from "~/server/functions/public-subscription";

/**
 * `/unsubscribe` — reached from the footer of a campaign email.
 *
 * The URL is in delivered inboxes and `APP_SECRET` cannot be rotated, so the
 * path and both parameters are fixed (`AGENTS.md`). What changed is how the
 * confirmation happens: Next.js used a form posting to a server action and a
 * POST-redirect-GET, and this is a `POST` server function with the result in
 * component state. The property that mattered is preserved — **nothing
 * unsubscribes on a `GET`** — because an email client's link scanner will
 * fetch this page on the recipient's behalf and must not act for them.
 */
const PUBLIC_ERRORS = new Set(["Invalid unsubscribe link", "Contact not found"]);

function publicMessage(error: unknown, fallback: string) {
  return error instanceof Error && PUBLIC_ERRORS.has(error.message)
    ? error.message
    : fallback;
}

export const Route = createFileRoute("/unsubscribe")({
  validateSearch: z.object({
    id: z.string().optional(),
    hash: z.string().optional(),
  }),
  component: UnsubscribePage,
});

function MessageCard({ title, message }: { title: string; message: string }) {
  return (
    <div className="w-full max-w-md space-y-4 rounded-xl border p-8 shadow">
      <h1 className="text-center text-2xl font-semibold">{title}</h1>
      <p className="text-center text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

function UnsubscribePage() {
  const { id, hash } = Route.useSearch();

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      {id && hash ? (
        <UnsubscribeFlow id={id} hash={hash} />
      ) : (
        <MessageCard
          title="Invalid Link"
          message="This unsubscribe link is invalid. Please check the URL and try again."
        />
      )}

      <div className="fixed bottom-10 p-4 text-sm">
        <p>
          Powered by{" "}
          <a
            href="https://usesend.com"
            className="font-bold"
            target="_blank"
            rel="noreferrer"
          >
            useSend
          </a>
        </p>
      </div>
    </main>
  );
}

function UnsubscribeFlow({ id, hash }: { id: string; hash: string }) {
  const contactQuery = useQuery({
    queryKey: ["unsubscribe", id],
    queryFn: () => lookupUnsubscribeTarget({ data: { id, hash } }),
    retry: false,
  });

  const [done, setDone] = useState(false);

  const confirm = useMutation({
    mutationFn: unsubscribe,
    onSuccess: () => setDone(true),
    onError: (error) =>
      toast.error(
        publicMessage(error, "Unable to unsubscribe. Please try again."),
      ),
  });

  if (contactQuery.isPending) {
    return <Spinner className="h-6 w-6" innerSvgClass="stroke-primary" />;
  }

  if (contactQuery.isError) {
    return (
      <MessageCard
        title="Invalid Link"
        message={publicMessage(
          contactQuery.error,
          "Unable to unsubscribe. Please try again.",
        )}
      />
    );
  }

  const contact = contactQuery.data;

  if (done || !contact.subscribed) {
    return <ReSubscribe id={id} hash={hash} email={contact.email} />;
  }

  return (
    <div className="w-full max-w-md space-y-6 rounded-xl border p-8 shadow">
      <div className="space-y-2">
        <h1 className="text-center text-2xl font-semibold">Unsubscribe</h1>
        <p className="text-center text-sm text-muted-foreground">
          Are you sure you want to stop receiving emails at{" "}
          <span className="font-medium text-foreground">{contact.email}</span>?
        </p>
      </div>

      <Button
        type="button"
        variant="destructive"
        className="min-h-11 w-full touch-manipulation"
        onClick={() => confirm.mutate({ data: { id, hash } })}
        disabled={confirm.isPending}
        aria-disabled={confirm.isPending}
      >
        {confirm.isPending ? "Unsubscribing…" : "Confirm unsubscribe"}
      </Button>
    </div>
  );
}

function ReSubscribe({
  id,
  hash,
  email,
}: {
  id: string;
  hash: string;
  email: string;
}) {
  const [subscribed, setSubscribed] = useState(false);

  const resubscribe = useMutation({
    mutationFn: reSubscribeContact,
    onSuccess: () => {
      toast.success("You have been subscribed again");
      setSubscribed(true);
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <div className="w-full max-w-xl space-y-8 rounded-xl border p-10 shadow">
      <h2 className="text-center text-xl font-extrabold">
        {subscribed ? "You have subscribed again" : "You have unsubscribed"}
      </h2>
      <div>
        {subscribed
          ? "You have been added to our mailing list and will receive all emails at"
          : "You have been removed from our mailing list and won't receive any emails at"}{" "}
        <span className="font-bold">{email}</span>.
      </div>

      <div className="flex justify-center">
        {!subscribed ? (
          <Button
            type="button"
            className="mx-auto min-h-11 w-[150px] touch-manipulation"
            onClick={() => resubscribe.mutate({ data: { id, hash } })}
            disabled={resubscribe.isPending}
            aria-disabled={resubscribe.isPending}
          >
            {resubscribe.isPending ? (
              <Spinner className="h-4 w-4" />
            ) : (
              "Subscribe Again"
            )}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
