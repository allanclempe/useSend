/**
 * `cloudflare:workers`, for a test process that is not a Worker.
 *
 * The four Durable Object classes extend `DurableObject` from the runtime
 * built-in of that name. Under `vitest` there is no such module, so
 * `vitest.config.ts` aliases it here — the counterpart at type level is
 * `src/worker/cloudflare-workers.d.ts`, which declares the same one export and
 * for the same reason.
 *
 * The base class is genuinely this small: it stores `ctx` and `env` and that is
 * all. What `extends DurableObject` buys on Workers is that the subclass's
 * methods become callable over RPC from a stub, which is a property of the
 * runtime rather than of the class — and in a test the "stub" is the instance,
 * so the methods are callable to begin with. The interesting half is the `ctx`
 * the instance is constructed with; see `src/test/integration/bindings.ts`.
 */
export class DurableObject<Env = unknown> {
  constructor(
    protected ctx: DurableObjectState,
    protected env: Env,
  ) {}
}

/** The shape `bindings.ts` supplies and the DO classes consume. */
export type DurableObjectState = {
  storage: {
    // eslint-disable-next-line no-unused-vars -- parameter names in a type signature
    get<T>(key: string): Promise<T | undefined>;
    // eslint-disable-next-line no-unused-vars -- parameter names in a type signature
    put<T>(key: string, value: T): Promise<void>;
    // eslint-disable-next-line no-unused-vars -- parameter names in a type signature
    delete(key: string): Promise<boolean>;
    deleteAll(): Promise<void>;
    getAlarm(): Promise<number | null>;
    // eslint-disable-next-line no-unused-vars -- parameter names in a type signature
    setAlarm(scheduledTime: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
  // eslint-disable-next-line no-unused-vars -- parameter names in a type signature
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
};
