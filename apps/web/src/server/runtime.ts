/**
 * Which runtime is this module graph loaded in?
 *
 * Most of `apps/web` should never need to ask. The one place it is unavoidable
 * is picking a queue driver: BullMQ opens Redis sockets and starts long-lived
 * blocking consumers, neither of which a Worker isolate can host.
 */
export function isWorkersRuntime(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.userAgent === "Cloudflare-Workers"
  );
}
