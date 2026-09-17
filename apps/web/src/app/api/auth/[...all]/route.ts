import { handleAuthRequest } from "~/server/auth-route";

/**
 * Next.js's entry into `/api/auth/*`. The handler itself, including the OTP
 * rate limit, is in `~/server/auth-route` so the TanStack Start server route
 * at `routes/api.auth.$.ts` cannot drift from it (#9).
 */
export const GET = handleAuthRequest;
export const POST = handleAuthRequest;
