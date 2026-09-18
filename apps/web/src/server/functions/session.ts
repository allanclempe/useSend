import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { getServerAuthSession } from "~/server/auth";
import { getEnabledAuthProviders } from "~/server/better-auth";

/**
 * What a route can ask about the caller before it renders anything.
 *
 * Deliberately **not** the session object. `/` and the two sign-in pages only
 * need to know where to send someone, and shipping the whole session into the
 * SSR payload of a page that is about to redirect is how a user's email ends
 * up in the HTML of a page they never see. The browser gets the full session
 * from better-auth's own client once it is past the gate.
 */
export const getSessionState = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await getServerAuthSession(getRequest().headers);

    return {
      signedIn: Boolean(session?.user),
      isWaitlisted: Boolean(session?.user.isWaitlisted),
    };
  },
);

/**
 * The signed-in user, for the pages that have to render something about them
 * before better-auth's client store exists.
 *
 * Only `/wait-list` needs this: it shows the address the founders will reply
 * to, and a blank field there while the session hydrates reads as a bug.
 * Everything behind the dashboard gate uses `useSession()` instead, which is
 * already warm by then.
 */
export const getSessionUser = createServerFn({ method: "GET" }).handler(
  async () => {
    const session = await getServerAuthSession(getRequest().headers);
    return session?.user ?? null;
  },
);

/**
 * Which sign-in methods this installation has configured.
 *
 * A server function because it reads `env`: `GITHUB_ID`, `GOOGLE_CLIENT_ID`
 * and `FROM_EMAIL` are server variables, and the login page only needs to know
 * whether each is set — not what it is. NextAuth's `getProviders()` fetched
 * the same three booleans over the network on every render.
 */
export const getAuthProviders = createServerFn({ method: "GET" }).handler(() =>
  getEnabledAuthProviders(),
);
