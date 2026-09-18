export const INVITATION_REQUIRED_MESSAGE =
  "You need a team invitation to create an account on this instance.";
export const GENERIC_AUTH_ERROR_MESSAGE =
  "Unable to sign in. Please try again.";

/**
 * Error codes that mean "this instance will not create an account for you".
 *
 * `REGISTRATION_NOT_ALLOWED` is ours, raised by the self-hosted registration
 * gate and carried through better-auth's OAuth callback, which turns an
 * `APIError`'s `code` into `?error=<code>` on the redirect
 * (`better-auth/dist/api/routes/callback.mjs:240`).
 */
const REGISTRATION_BLOCKED_CODES = new Set(["REGISTRATION_NOT_ALLOWED"]);

export function getAuthErrorMessage(error?: string | null) {
  if (!error) {
    return null;
  }

  if (REGISTRATION_BLOCKED_CODES.has(error)) {
    return INVITATION_REQUIRED_MESSAGE;
  }

  return GENERIC_AUTH_ERROR_MESSAGE;
}
