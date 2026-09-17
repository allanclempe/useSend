import { createAuthClient } from "better-auth/react";
import { customSessionClient, emailOTPClient } from "better-auth/client/plugins";

import type { auth } from "~/server/auth";

/**
 * Browser-side auth client.
 *
 * `customSessionClient<typeof auth>()` is what carries the server's session
 * shape to the client, so `useSession()` returns the same `user` the server
 * built — numeric `id`, `isAdmin`, `isBetaUser`, `isWaitlisted` — rather than
 * better-auth's raw row.
 *
 * No provider component: the session lives in a nanostore inside the client, so
 * `useSession` works anywhere without a `SessionProvider` above it.
 */
export const authClient = createAuthClient({
  plugins: [emailOTPClient(), customSessionClient<typeof auth>()],
});

export const { useSession, signIn, signOut } = authClient;
