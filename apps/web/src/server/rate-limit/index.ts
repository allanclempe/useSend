import { durableObjectRateLimiter } from "./durable-object-driver";
import type { RateLimiter, RateLimitResult, RateLimitWindow } from "./types";

export * from "./types";

/** The rate limiter: one Durable Object per bucket. Redis is gone (#12). */
const limiter: RateLimiter = durableObjectRateLimiter;

export function consumeRateLimit(
  bucket: string,
  window: RateLimitWindow,
): Promise<RateLimitResult> {
  return limiter.consume(bucket, window);
}

/**
 * Counts a request and, when the limiter itself fails, lets the request past.
 *
 * **The fail-open decision, in one place.** Every caller was already fail-open:
 * the API limiter caught Redis errors and called `next()`, the auth limiter
 * logged and fell through. That is kept, deliberately, and the reasoning is
 * that a rate limiter is a cost control rather than a security control here —
 * authentication and authorisation have already happened by the time any of
 * these run, so an outage of the limiter degrades billing accuracy, while
 * failing closed would take out sign-in and the whole public API instead.
 *
 * The one exception is the waitlist, which stays fail-closed because it was: a
 * throw there surfaces as an error to one user submitting one form, and the
 * thing it protects is the founder's inbox.
 *
 * Revisit this if abuse ever becomes the reason the limiter exists.
 */
export async function consumeRateLimitFailOpen(
  bucket: string,
  window: RateLimitWindow,
  // eslint-disable-next-line no-unused-vars -- parameter name in a type signature
  onError: (error: unknown) => void,
): Promise<RateLimitResult | null> {
  try {
    return await limiter.consume(bucket, window);
  } catch (error) {
    onError(error);
    return null;
  }
}
