/**
 * `cloudflare:workers` is a runtime built-in, and its types do not reach this
 * project.
 *
 * `@cloudflare/workers-types` ships a `declare module "cloudflare:workers"`,
 * but only as part of a global type environment — and `apps/web` deliberately
 * does not install one: it is a Next.js app that wants the DOM's `Request`,
 * `Response` and `Queue`, so the Worker types are imported per file as types
 * instead (see `server/worker-bindings.ts`). The module declaration never
 * becomes ambient that way.
 *
 * So this declares exactly the one export the Worker uses, and nothing else. It
 * is the base class for Durable Objects: extending it is what makes a class's
 * methods callable over RPC from a stub. Narrow on purpose — the moment this
 * grows a second export, `wrangler types` and a real global environment are the
 * better answer.
 */
declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown> {
    protected ctx: import("@cloudflare/workers-types").DurableObjectState;
    protected env: Env;
    constructor(
      ctx: import("@cloudflare/workers-types").DurableObjectState,
      env: Env,
    );
    alarm?(): void | Promise<void>;
  }
}
