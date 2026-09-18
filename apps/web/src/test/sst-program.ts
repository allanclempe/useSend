import { fileURLToPath } from "node:url";

/**
 * Runs the repo root `sst.config.ts` and records what it declares.
 *
 * `sst.config.ts` is not a config file, it is a program: `$config`, `sst` and
 * `cloudflare` are globals the SST CLI injects, and the resources exist only as
 * the side effects of calling `run()`. Reading it as text would prove nothing —
 * every name in it is computed from a registry, which is the point.
 *
 * So this executes it, with the handful of globals it touches replaced by stubs
 * that record their arguments instead of talking to Cloudflare. What comes back
 * is the program's *description* of the Worker, in the same terms
 * `wrangler.jsonc` uses, which is what `sst-config.unit.test.ts` diffs.
 *
 * Two details are reproduced from SST's own source rather than invented,
 * because the test is worthless if they are wrong:
 *
 *   - **A binding's name is the component's name.** SST's `Worker.buildBindings`
 *     takes `link.urn.split("::").at(-1)`, so `new sst.cloudflare.Kv("CACHE")`
 *     is what puts `CACHE` on `env`. That is why the config shouts its
 *     component names, and why this records them verbatim.
 *   - **`transform` has two forms.** A function mutates the args SST built; an
 *     object is shallow-spread over them (`{ ...args, ...transform }`). Both are
 *     applied here exactly as `platform/src/components/component.ts` does, so a
 *     config that reached for the object form and lost SST's bindings would
 *     show up here as lost bindings.
 *
 * Pinned to SST 4.17.1. If the component API moves, this stub is what notices.
 */

/** Every binding kind SST knows how to put on a Worker, keyed as `env` sees it. */
const BINDING_TYPES = {
  aiBindings: "ai",
  plainTextBindings: "plain_text",
  secretTextBindings: "secret_text",
  queueBindings: "queue",
  serviceBindings: "service",
  durableObjectNamespaceBindings: "durable_object_namespace",
  kvNamespaceBindings: "kv_namespace",
  d1DatabaseBindings: "d1",
  r2BucketBindings: "r2_bucket",
  hyperdriveBindings: "hyperdrive",
  versionMetadataBindings: "version_metadata",
  workflowBindings: "workflow",
  rateLimitBindings: "ratelimit",
} as const;

type BindingKind = keyof typeof BINDING_TYPES;

export type RecordedBinding = {
  /** The key on `env`. */
  name: string;
  /** Cloudflare's wire type, eg. `queue`, `durable_object_namespace`. */
  type: string;
  properties: Record<string, unknown>;
};

export type RecordedQueue = { binding: string; queueName: string };

export type RecordedConsumer = {
  queueName: string;
  scriptName: string;
  type: string;
  deadLetterQueue?: string;
  settings: {
    batchSize?: number;
    maxWaitTimeMs?: number;
    maxRetries?: number;
    maxConcurrency?: number;
  };
};

export type RecordedWorker = {
  path?: string;
  scriptName: string;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  migrations: Array<{
    tag: string;
    newSqliteClasses?: string[];
    deletedClasses?: string[];
    renamedClasses?: Array<{ from: string; to: string }>;
  }>;
  observability?: { enabled: boolean };
  bindings: RecordedBinding[];
};

export type SstProgram = {
  app: { name: string; home: string; stage: string };
  worker: RecordedWorker;
  /** Every queue the program creates, keyed by the producer binding it links. */
  queues: RecordedQueue[];
  consumers: RecordedConsumer[];
  crons: string[];
  /** Everything that is not a Worker, queue, consumer or cron. */
  resources: Array<{
    type: string;
    name: string;
    args: Record<string, unknown>;
  }>;
};

/**
 * Just enough of a Pulumi `Output` for the config to compute with.
 *
 * Only `.apply` is reproduced, and it runs eagerly over a concrete value. The
 * config's one `.apply` parses a Postgres URL into Hyperdrive's origin, so the
 * value below has to be a real connection string for that to mean anything.
 */
const DATABASE_URL =
  "postgres://neon:npg@localhost:54320/neondb?sslmode=require";

function unwrap(value: unknown): unknown {
  if (value && typeof value === "object" && "__value" in value) {
    return (value as { __value: unknown }).__value;
  }
  return value;
}

function resolved<T>(value: T) {
  return { __value: value, apply: <U>(fn: (v: T) => U) => resolved(fn(value)) };
}

type Transform<T> =
  ((args: T, opts?: unknown, name?: string) => void) | Partial<T> | undefined;

/** `platform/src/components/component.ts`, verbatim. */
function applyTransform<T extends object>(transform: Transform<T>, args: T): T {
  if (typeof transform === "function") {
    transform(args, {}, "");
    return args;
  }
  return { ...args, ...transform };
}

type Linkable = {
  __binding?: {
    kind: BindingKind;
    name: string;
    properties: Record<string, unknown>;
  };
};

function linkable(
  kind: BindingKind,
  name: string,
  properties: Record<string, unknown>,
): Linkable {
  return { __binding: { kind, name, properties } };
}

class Recorder {
  readonly queues: Array<RecordedQueue & { id: string }> = [];
  readonly consumers: RecordedConsumer[] = [];
  readonly crons: string[] = [];
  readonly others: Array<{
    type: string;
    name: string;
    args: Record<string, unknown>;
  }> = [];
  worker?: RecordedWorker;
}

const STUB_SCRIPT_NAME = "usesend-test-webscript";

function buildStubs(recorder: Recorder, stage: string) {
  const queueIds = new Map<string, string>();

  class Secret {
    value = resolved(DATABASE_URL);
    constructor(readonly name: string) {
      recorder.others.push({ type: "sst.Secret", name, args: {} });
    }
  }

  class Bucket {
    __binding;
    constructor(name: string, args: Record<string, unknown> = {}) {
      recorder.others.push({ type: "sst.cloudflare.Bucket", name, args });
      this.__binding = linkable("r2BucketBindings", name, {
        bucketName: `${name}-generated`,
      }).__binding;
    }
  }

  class Kv {
    __binding;
    constructor(name: string, args: Record<string, unknown> = {}) {
      recorder.others.push({ type: "sst.cloudflare.Kv", name, args });
      this.__binding = linkable("kvNamespaceBindings", name, {
        namespaceId: `${name}-generated`,
      }).__binding;
    }
  }

  class Hyperdrive {
    __binding;
    constructor(name: string, args: Record<string, unknown>) {
      recorder.others.push({
        type: "sst.cloudflare.Hyperdrive",
        name,
        args: { ...args, origin: unwrap(args.origin) },
      });
      this.__binding = linkable("hyperdriveBindings", name, {
        id: `${name}-generated`,
      }).__binding;
    }
  }

  class DurableObject {
    className: string;
    __binding;
    constructor(name: string, args: { className: string }) {
      this.className = args.className;
      this.__binding = linkable("durableObjectNamespaceBindings", name, {
        className: args.className,
      }).__binding;
    }
  }

  class Queue {
    id: string;
    __binding;
    constructor(
      name: string,
      args: {
        transform?: {
          queue?: Transform<{ queueName: string; accountId?: string }>;
        };
      } = {},
    ) {
      // SST hands the provider `queueName: ""` and lets its own naming
      // transformation fill it in, unless the config set one.
      const queueArgs = applyTransform(args.transform?.queue, {
        queueName: "",
        accountId: "stub-account",
      });
      const queueName =
        queueArgs.queueName === ""
          ? `usesend-${stage}-${name.replace(/[^a-zA-Z0-9]/g, "")}queue-random8`.toLowerCase()
          : queueArgs.queueName;

      this.id = `queue:${queueName}`;
      queueIds.set(this.id, queueName);
      recorder.queues.push({ binding: name, queueName, id: this.id });
      this.__binding = linkable("queueBindings", name, { queueName }).__binding;
    }
  }

  class TanStackStart {
    url = resolved(`https://${stage}.example.workers.dev`);
    nodes;
    constructor(
      name: string,
      args: {
        path?: string;
        link?: Linkable[];
        transform?: {
          server?: Transform<Record<string, unknown>>;
        };
      },
    ) {
      // `SsrSite.createWorker`: the site builds the Worker args and runs the
      // `server` transform over them.
      const workerArgs = applyTransform(args.transform?.server, {
        link: args.link,
        url: true,
        dev: false,
        handler: "<built by vite>",
        assets: { directory: "<built by vite>" },
      } as Record<string, unknown>);

      // `Worker`: the `worker` transform runs over the Cloudflare script args.
      const scriptArgs = applyTransform(
        (
          workerArgs.transform as
            { worker?: Transform<Record<string, unknown>> } | undefined
        )?.worker,
        { scriptName: STUB_SCRIPT_NAME } as Record<string, unknown>,
      );

      const compatibility = workerArgs.compatibility as
        { date?: string; flags?: string[] } | undefined;

      recorder.worker = {
        path: args.path,
        scriptName: STUB_SCRIPT_NAME,
        compatibilityDate: compatibility?.date,
        compatibilityFlags: compatibility?.flags,
        migrations: (workerArgs.migrations ??
          []) as RecordedWorker["migrations"],
        observability: scriptArgs.observability as
          { enabled: boolean } | undefined,
        // `Worker.buildBindings` starts with SST's own `SST_RESOURCE_App` and
        // appends one binding per linked component.
        bindings: [
          { name: "SST_RESOURCE_App", type: "plain_text", properties: {} },
          ...(args.link ?? [])
            .filter((link) => link.__binding)
            .map((link) => ({
              name: link.__binding!.name,
              type: BINDING_TYPES[link.__binding!.kind],
              properties: link.__binding!.properties,
            })),
        ],
      };

      this.nodes = {
        server: { nodes: { worker: { scriptName: STUB_SCRIPT_NAME } } },
      };
    }
  }

  class QueueConsumer {
    constructor(
      _name: string,
      args: {
        queueId: string;
        scriptName: string;
        type: string;
        deadLetterQueue?: string;
        settings: RecordedConsumer["settings"];
      },
    ) {
      recorder.consumers.push({
        queueName: queueIds.get(args.queueId) ?? args.queueId,
        scriptName: args.scriptName,
        type: args.type,
        deadLetterQueue: args.deadLetterQueue,
        settings: args.settings,
      });
    }
  }

  class WorkersCronTrigger {
    constructor(
      _name: string,
      args: { scriptName: string; schedules: Array<{ cron: string }> },
    ) {
      recorder.crons.push(...args.schedules.map((schedule) => schedule.cron));
    }
  }

  return {
    sst: {
      Secret,
      cloudflare: {
        Bucket,
        Kv,
        Hyperdrive,
        DurableObject,
        Queue,
        TanStackStart,
        DEFAULT_ACCOUNT_ID: "stub-account",
      },
    },
    cloudflare: { QueueConsumer, WorkersCronTrigger },
  };
}

type SstConfig = {
  app: (input: { stage?: string }) => {
    name: string;
    home: string;
    [key: string]: unknown;
  };
  run: () => Promise<unknown>;
};

/**
 * Executes `sst.config.ts` and returns what it declared.
 *
 * The import specifier is computed rather than literal on purpose: a static
 * import would drag `sst.config.ts` into `tsc --noEmit` for this workspace,
 * where the `$config` and `sst` globals do not exist. They come from
 * `.sst/platform/config.d.ts`, which `sst install` generates and which is not
 * in the repo.
 */
export async function runSstProgram(stage = "test"): Promise<SstProgram> {
  const recorder = new Recorder();
  const stubs = buildStubs(recorder, stage);

  // `globalThis` is where the SST CLI would put `$config`, `sst` and the
  // provider namespaces. eslint's env predates it; `server/drizzle/index.ts`
  // does the same thing for the same reason.
  // eslint-disable-next-line no-undef
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  const install = (key: string, value: unknown) => {
    saved.set(key, globals[key]);
    globals[key] = value;
  };

  install("$config", (input: unknown) => input);
  install("$app", { name: "usesend", stage });
  install("$dev", false);
  install("$util", { output: resolved });
  install("sst", stubs.sst);
  install("cloudflare", stubs.cloudflare);

  try {
    const configPath = fileURLToPath(
      new URL("../../../../sst.config.ts", import.meta.url),
    );
    const configModule = (await import(/* @vite-ignore */ configPath)) as {
      default: SstConfig;
    };
    const config = configModule.default;
    const app = config.app({ stage });
    await config.run();

    if (!recorder.worker) {
      throw new Error("sst.config.ts declared no Worker");
    }

    return {
      app: { name: app.name, home: app.home, stage },
      worker: recorder.worker,
      queues: recorder.queues.map(({ binding, queueName }) => ({
        binding,
        queueName,
      })),
      consumers: recorder.consumers,
      crons: recorder.crons,
      resources: recorder.others,
    };
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete globals[key];
      else globals[key] = value;
    }
  }
}
