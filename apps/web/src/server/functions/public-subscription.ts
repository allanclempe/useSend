import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { confirmDoubleOptInSubscription } from "~/server/service/double-opt-in-service";
import {
  getContactFromUnsubscribeLink,
  unsubscribeContactFromLink,
} from "~/server/service/campaign-service";

/**
 * The two pages a recipient reaches from a link in an email we sent.
 *
 * **No middleware, deliberately.** There is no session — the person clicking
 * is a contact, not a user — and the credential is the hash in the URL, which
 * the services below verify. Adding an auth middleware here would lock out
 * everyone these exist for.
 *
 * Every one of them is `POST`. That is not a formality: `GET` is what an email
 * client's link scanner and a corporate mail gateway will fetch on the
 * recipient's behalf, and an unsubscribe that happens on `GET` is an
 * unsubscribe somebody did not ask for. The Next.js version used a form and a
 * server action to get the same property; this keeps it.
 *
 * `lookupUnsubscribeTarget` is the exception and is a read, but it is still a
 * server function rather than a loader argument because it takes the hash and
 * must not be reachable without one.
 */

export const lookupUnsubscribeTarget = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string(), hash: z.string() }))
  .handler(async ({ data }) => {
    const contact = await getContactFromUnsubscribeLink(data.id, data.hash);

    // Only what the page renders. The full contact row carries custom
    // properties a campaign's author put there, and none of it belongs in a
    // page anyone with the link can load.
    return { id: contact.id, email: contact.email, subscribed: contact.subscribed };
  });

export const unsubscribe = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string(), hash: z.string() }))
  .handler(async ({ data }) => {
    await unsubscribeContactFromLink(data.id, data.hash);
    return { ok: true };
  });

export const confirmSubscription = createServerFn({ method: "POST" })
  .validator(
    z.object({
      contactId: z.string(),
      expiresAt: z.string(),
      hash: z.string(),
    }),
  )
  .handler(async ({ data }) => {
    await confirmDoubleOptInSubscription(data);
    return { ok: true };
  });
