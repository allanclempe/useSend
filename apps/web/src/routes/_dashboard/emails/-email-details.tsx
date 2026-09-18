import { useQuery } from "@tanstack/react-query";
import {
  BOUNCE_ERROR_MESSAGES,
  COMPLAINT_ERROR_MESSAGES,
  DELIVERY_DELAY_ERRORS,
} from "@usesend/lib/src/constants/ses-errors";
import { formatDate } from "date-fns";
import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { UAParser } from "ua-parser-js";

import { Separator } from "@usesend/ui/src/separator";

import { getEmailPreviewSrcDoc } from "~/lib/email-preview";
import { emailQueries } from "~/queries/email";
import type {
  SesBounce,
  SesClick,
  SesComplaint,
  SesDeliveryDelay,
  SesOpen,
} from "~/types/aws-types";
import type { EmailStatus, JsonValue } from "~/types/db";
import CancelEmail from "./-cancel-email";
import { EmailStatusBadge, EmailStatusIcon } from "./-email-status-badge";

/**
 * The contents of the sheet the email log opens.
 *
 * The detail query is not warmed by the route loader: the sheet is closed on
 * almost every visit, and a bookmarked `?emailId=` is rare enough that one
 * fetch on open is the right trade.
 */
export default function EmailDetails({ emailId }: { emailId: string }) {
  const emailQuery = useQuery(emailQueries.detail(emailId));
  const email = emailQuery.data;

  return (
    <div className="no-scrollbar h-full overflow-auto px-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="font-bold">{email?.to}</h1>
          <EmailStatusBadge status={email?.latestStatus ?? "SENT"} />
        </div>
      </div>
      <div className="mt-8 flex flex-col items-start gap-8">
        <div className="flex w-full flex-col gap-2 rounded-lg border p-2 shadow">
          <div className="flex flex-col gap-1 px-4 py-1">
            <div className="text-sm">Subject: {email?.subject}</div>
            <div className="text-xs text-muted-foreground">
              From: {email?.from}
            </div>
          </div>
          {email?.latestStatus === "SCHEDULED" && email.scheduledAt ? (
            <>
              <Separator />
              <div className="flex items-center gap-2 px-4">
                <span className="w-[100px] text-sm text-muted-foreground">
                  Scheduled at
                </span>
                <span className="text-sm">
                  {formatDate(email.scheduledAt, "MMM dd'th', hh:mm a")}
                </span>
                <div className="ml-4">
                  <CancelEmail emailId={emailId} />
                </div>
              </div>
            </>
          ) : null}

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.2, delay: 0.3 }}
          >
            <EmailPreview html={email?.html} text={email?.text} />
          </motion.div>
        </div>
        {email && email.latestStatus !== "SCHEDULED" ? (
          <div className="mb-2 w-full rounded-lg border shadow">
            <div className="flex w-full flex-col gap-8 p-4">
              <div className="font-medium">Events History</div>
              <div className="flex w-full items-stretch px-4">
                <div className="border-r border-dashed border-gray-300 dark:border-gray-700" />
                <div className="flex w-full flex-col gap-12">
                  {email.emailEvents.map((event) => (
                    <div
                      key={event.status}
                      className="flex w-full items-start gap-5"
                    >
                      <div className="-ml-2.5">
                        <EmailStatusIcon status={event.status} />
                      </div>
                      <div className="-mt-[0.125rem] w-full">
                        <div className="font-medium capitalize">
                          <EmailStatusBadge status={event.status} />
                        </div>
                        <div className="mt-2 text-xs text-muted-foreground">
                          {formatDate(event.createdAt, "MMM dd, hh:mm a")}
                        </div>
                        <div className="mt-1 text-foreground/80">
                          <EmailStatusText
                            status={event.status}
                            data={event.data}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The preview waits a moment before it mounts the iframe. Loading a whole
 * document is enough work to stutter the sheet's slide-in animation, and the
 * placeholder is the same size, so nothing moves when it arrives.
 */
const EmailPreview = ({
  html,
  text,
}: {
  html: string | null | undefined;
  text: string | null | undefined;
}) => {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setShow(true), 200);
    return () => clearTimeout(timer);
  }, []);

  const srcDoc = getEmailPreviewSrcDoc(html, text);

  if (!show) {
    return (
      <div className="h-[350px] overflow-visible rounded border-t dark:bg-slate-200"></div>
    );
  }

  if (!srcDoc) {
    return (
      <div className="flex h-[350px] items-center justify-center overflow-visible rounded border-t dark:bg-slate-200">
        <span className="text-sm text-muted-foreground dark:text-slate-500">
          No content to preview
        </span>
      </div>
    );
  }

  return (
    <div className="h-[350px] overflow-visible rounded border-t dark:bg-slate-200">
      <iframe
        className="h-full w-full"
        srcDoc={srcDoc}
        sandbox="allow-same-origin"
      />
    </div>
  );
};

/**
 * What an event means, in English. SES says `Permanent/Suppressed`; the person
 * reading this wants to know whether to try again.
 */
const EmailStatusText = ({
  status,
  data,
}: {
  status: EmailStatus;
  data: JsonValue;
}) => {
  if (status === "SENT") {
    return (
      <div>
        We received your request and sent the email to recipient&apos;s server.
      </div>
    );
  }

  if (status === "DELIVERED") {
    return <div>Mail is successfully delivered to the recipient.</div>;
  }

  if (status === "DELIVERY_DELAYED") {
    const delay = data as unknown as SesDeliveryDelay;
    return <div>{DELIVERY_DELAY_ERRORS[delay.delayType]}</div>;
  }

  if (status === "BOUNCED") {
    const bounce = data as unknown as SesBounce;

    return (
      <div className="flex w-full flex-col gap-4">
        <p>{getBounceMessage(bounce)}</p>
        <div className="flex flex-col gap-4 rounded-xl bg-muted/30 p-4">
          <div className="flex w-full gap-2">
            <div className="w-1/2">
              <p className="text-sm text-muted-foreground">Type</p>
              <p>{bounce.bounceType}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Sub Type</p>
              <p>{bounce.bounceSubType}</p>
            </div>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">SMTP response</p>
            <p>{bounce.bouncedRecipients[0]?.diagnosticCode}</p>
          </div>
        </div>
      </div>
    );
  }

  if (status === "FAILED") {
    const failure = data as unknown as { error: string };
    return <div>{failure.error}</div>;
  }

  if (status === "OPENED") {
    const open = data as unknown as SesOpen;
    const userAgent = getUserAgent(open.userAgent);

    return (
      <div className="mt-4 w-full rounded-xl bg-muted/30 p-4">
        <div className="flex w-full">
          {userAgent.os.name ? (
            <div className="w-1/2">
              <p className="text-sm text-muted-foreground">OS</p>
              <p>{userAgent.os.name}</p>
            </div>
          ) : null}
          {userAgent.browser.name ? (
            <div>
              <p className="text-sm text-muted-foreground">Browser</p>
              <p>{userAgent.browser.name}</p>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  if (status === "CLICKED") {
    const click = data as unknown as SesClick;
    const userAgent = getUserAgent(click.userAgent);

    return (
      <div className="mt-4 flex w-full flex-col gap-4 rounded-xl bg-muted/30 p-4">
        <div className="flex w-full">
          {userAgent.os.name ? (
            <div className="w-1/2">
              <p className="text-sm text-muted-foreground">OS </p>
              <p>{userAgent.os.name}</p>
            </div>
          ) : null}
          {userAgent.browser.name ? (
            <div>
              <p className="text-sm text-muted-foreground">Browser </p>
              <p>{userAgent.browser.name}</p>
            </div>
          ) : null}
        </div>
        <div className="w-full">
          <p className="text-sm text-muted-foreground">URL</p>
          <p>{click.link}</p>
        </div>
      </div>
    );
  }

  if (status === "COMPLAINED") {
    const complaint = data as unknown as SesComplaint;

    return (
      <div className="flex w-full flex-col gap-4">
        <p>
          {
            COMPLAINT_ERROR_MESSAGES[
              complaint.complaintFeedbackType as keyof typeof COMPLAINT_ERROR_MESSAGES
            ]
          }
        </p>
      </div>
    );
  }

  if (status === "CANCELLED") {
    return <div>This scheduled email was cancelled</div>;
  }

  if (status === "SUPPRESSED") {
    return (
      <div>
        This email was suppressed because this email is previously either
        bounced or the recipient complained.
      </div>
    );
  }

  return <div className="w-full">{status}</div>;
};

const getBounceMessage = (bounce: SesBounce) => {
  if (bounce.bounceType === "Permanent") {
    return BOUNCE_ERROR_MESSAGES.Permanent[
      bounce.bounceSubType as keyof typeof BOUNCE_ERROR_MESSAGES.Permanent
    ];
  }

  if (bounce.bounceType === "Transient") {
    return BOUNCE_ERROR_MESSAGES.Transient[
      bounce.bounceSubType as keyof typeof BOUNCE_ERROR_MESSAGES.Transient
    ];
  }

  if (bounce.bounceType === "Undetermined") {
    return BOUNCE_ERROR_MESSAGES.Undetermined;
  }
};

const getUserAgent = (userAgent: string) => {
  const parser = new UAParser(userAgent);
  return {
    browser: parser.getBrowser(),
    os: parser.getOS(),
    device: parser.getDevice(),
  };
};
