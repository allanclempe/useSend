import { publicEnv } from "~/env.public";

/**
 * Which deployment is this?
 *
 * Client-safe, and deliberately the only thing left in this module: it is
 * imported from twenty-odd places on both sides of the network boundary, and
 * it used to sit next to three retention helpers that read server-only
 * variables. That made `~/utils/common` a module the browser could not load,
 * which nobody noticed under Next.js because webpack rewrites every
 * `process.env.X` in a client bundle to a literal. The retention helpers moved
 * to `~/server/retention`.
 */
export function isCloud() {
  return publicEnv.NEXT_PUBLIC_IS_CLOUD;
}

export function isSelfHosted() {
  return !isCloud();
}
