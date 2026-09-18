import { describe, expect, it } from "vitest";

import {
  confirmSubscription,
  lookupUnsubscribeTarget,
  unsubscribe,
} from "~/server/functions/public-subscription";

/**
 * Nothing on these pages may act on a `GET`.
 *
 * An email client's link scanner and a corporate mail gateway both fetch the
 * URLs in a delivered message on the recipient's behalf. An unsubscribe that
 * happens on `GET` is an unsubscribe nobody asked for, and a double-opt-in
 * confirmed by a scanner is not a confirmation. Next.js got this property from
 * a `<form>` and a server action; here it is the `method` on the server
 * function, which is exactly the kind of thing a later edit removes without
 * noticing.
 *
 * `lookupUnsubscribeTarget` is a read and is still `POST`, because it takes
 * the link's hash and there is no reason for it to be replayable from a URL.
 */
describe("public subscription endpoints", () => {
  it.each([
    ["unsubscribe", unsubscribe],
    ["confirmSubscription", confirmSubscription],
    ["lookupUnsubscribeTarget", lookupUnsubscribeTarget],
  ])("%s is POST-only", (_name, fn) => {
    expect(fn.method).toBe("POST");
  });
});
