/// <reference path="./.sst/platform/config.d.ts" />

/**
 * useSend infrastructure — the Cloudflare half.
 *
 * **Nothing consumes this yet.** `apps/web/wrangler.jsonc` is still what
 * `vite dev` and `wrangler deploy` read, and `sst deploy` has never been run
 * against this program. It is here so it can be reviewed against the file it
 * will replace, one question at a time: *does this describe the same Worker?*
 * `apps/web/src/server/sst-config.unit.test.ts` is the machine-checked half of
 * that answer — it executes `run()` below with recording stubs and diffs the
 * result against `wrangler.jsonc`. See issue #130, PR A.
 *
 * It will not deploy as-is, deliberately: `sst.cloudflare.TanStackStart` calls
 * `validateNoWranglerFile()` and refuses to run while `apps/web/wrangler.jsonc`
 * exists. Deleting that file is PR B, together with pointing
 * `@cloudflare/vite-plugin` at `process.env.SST_WRANGLER_PATH`, which is the
 * env var SST sets for the site build.
 *
 * The reference above resolves only after `sst install`, which downloads the
 * platform into a gitignored `.sst/`. Until then an editor will flag `$config`
 * and `sst` as undefined here — `tsc --noEmit` will not, because nothing in any
 * tsconfig's program reaches this file.
 *
 * ## Why the shape below
 *
 * Every name, setting and count is derived by looping over the registries the
 * Worker itself reads — `queue-registry.ts`, `cron-registry.ts`,
 * `binding-registry.ts`, `durable-object-migrations.ts`. Hand-transcribing 31
 * queues and 32 consumers into a second file is exactly the drift those
 * registries exist to prevent, and the drift would be invisible until a send
 * path hit a binding that is not on `env`.
 *
 * Two things are deliberately *not* done the way SST's docs suggest, both for
 * reasons that were measured rather than guessed:
 *
 * 1. **Durable Objects use the first-class `sst.cloudflare.DurableObject`
 *    component and the Worker's `migrations` field.** Not
 *    `transform.worker.migrations`: the object form of `transform` is a shallow
 *    spread (`{ ...args, ...transform }`), so it silently drops SST's own
 *    bindings, and `WorkersScriptArgs.migrations` is a stateful *wire delta* —
 *    Cloudflare's `oldTag`/`newTag`/`steps` — not a ledger. A static block there
 *    either 412s with `Actor migration tag precondition failed` or only ever
 *    works against one stage's history. `Worker.migrations` takes the full
 *    ordered ledger and computes the delta against the deployed tag, which is
 *    what `durable-object-migrations.ts` is.
 *
 * 2. **Consumers and crons are raw Pulumi resources, not `Queue.subscribe()`
 *    and `sst.cloudflare.Cron`.** Both of those components *always construct a
 *    new Worker* and offer no way to point at an existing one. useSend has one
 *    Worker serving the dashboard, the API, all 32 queue consumers and all 6
 *    crons, so subscribing would mean 38 more Worker scripts, 38 more builds
 *    and 38 copies of the bundle. `cloudflare.QueueConsumer` and
 *    `cloudflare.WorkersCronTrigger` both take a `scriptName`, so they attach
 *    to the one script the site component already built.
 */

import {
  DURABLE_OBJECT_BINDINGS,
  KV_BINDINGS,
} from "./apps/web/src/server/binding-registry";
import { DURABLE_OBJECT_MIGRATIONS } from "./apps/web/src/server/durable-object-migrations";
import { CRON_EXPRESSIONS } from "./apps/web/src/server/queue/cron-registry";
import {
  DEAD_LETTER_QUEUE_NAME,
  maxRetriesFor,
  QUEUES,
} from "./apps/web/src/server/queue/queue-registry";

/**
 * Worker runtime settings, kept here because they are deploy config and not
 * something any registry owns. `sst-config.unit.test.ts` asserts both against
 * `wrangler.jsonc`, so they cannot drift away from it silently.
 *
 * `nodejs_compat` covers node:crypto, node:stream and node:net; from
 * compatibility_date 2025-04-01 it also populates `process.env` from vars and
 * secrets, which is what lets `src/env.js` validate unchanged.
 */
const COMPATIBILITY_DATE = "2026-01-01";
const COMPATIBILITY_FLAGS = ["nodejs_compat"];

/**
 * The dead letter queue's consumer settings.
 *
 * The only consumer whose numbers are not in `queue-registry.ts`: the registry
 * describes queues the app produces to, and nothing produces to this one —
 * Cloudflare does, on a message's last failure. A large, slow batch because the
 * handler only logs (§11: Workers Logs, not an OTLP exporter), and no retries
 * because there is nowhere left to send a failure.
 */
const DEAD_LETTER_CONSUMER = {
  batchSize: 100,
  maxWaitTimeMs: 30_000,
  maxRetries: 0,
};

export default $config({
  app(input) {
    return {
      name: "usesend",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage ?? ""),
      home: "cloudflare",
    };
  },

  async run() {
    // ── Hyperdrive ──────────────────────────────────────────────────────
    // Pooled Postgres in front of Neon. The origin is parsed from one secret
    // rather than five so that `sst secret set DatabaseUrl` takes the same
    // string `pnpm db:migrate` and `.env.example` use — the agreement
    // `wrangler.jsonc`'s `localConnectionString` comment is about.
    const databaseUrl = new sst.Secret("DatabaseUrl");

    const hyperdrive = new sst.cloudflare.Hyperdrive("HYPERDRIVE", {
      origin: databaseUrl.value.apply((raw) => {
        const url = new URL(raw);
        return {
          scheme: "postgres" as const,
          host: url.hostname,
          port: Number(url.port || 5432),
          database: decodeURIComponent(url.pathname.replace(/^\//, "")),
          user: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
        };
      }),
    });

    // ── R2 and KV ───────────────────────────────────────────────────────
    // The component name *is* the binding name on `env`: SST derives a
    // binding's name from the last segment of the component's URN. That is why
    // these are shouted rather than TitleCased, and why the KV namespaces are
    // built by looping over `KV_BINDINGS` instead of being spelled out.
    const storage = new sst.cloudflare.Bucket("STORAGE");

    const kvNamespaces = KV_BINDINGS.map(
      (binding) => new sst.cloudflare.Kv(binding),
    );

    // ── Durable Objects ─────────────────────────────────────────────────
    // One component per binding, `className` straight off the registry. SST
    // adds the `durable_object_namespace` binding when the Worker links them,
    // with no `scriptName`, which is what binds them to this same script.
    const durableObjects = Object.entries(DURABLE_OBJECT_BINDINGS).map(
      ([binding, className]) =>
        new sst.cloudflare.DurableObject(binding, { className }),
    );

    // ── Queues ──────────────────────────────────────────────────────────
    // `queueName` is pinned to the registry's name through a *function* form
    // transform (the object form would shallow-spread over SST's own props).
    // Left alone, SST names a queue `usesend-<stage>-<component>-<random8>`,
    // and the random suffix would be fatal: the consumer reverse-looks-up its
    // `QueueDefinition` from `MessageBatch.queue`, which is the account-level
    // queue name. See `queueDefinitionByQueueName`.
    //
    // The cost of pinning is that queue names are account-global, so one
    // Cloudflare account holds one stage's queues. That matches what
    // `wrangler.jsonc` does today and is the point of this PR; making it
    // per-stage is a decision for PR B, and it has to be made together with
    // teaching the consumer how to strip the stage back off.
    const deadLetterQueue = new sst.cloudflare.Queue("DeadLetter", {
      transform: {
        queue: (args) => {
          args.queueName = DEAD_LETTER_QUEUE_NAME;
        },
      },
    });

    const queues = QUEUES.map((queue) => ({
      definition: queue,
      resource: new sst.cloudflare.Queue(queue.binding, {
        transform: {
          queue: (args) => {
            args.queueName = queue.queueName;
          },
        },
      }),
    }));

    // ── The Worker ──────────────────────────────────────────────────────
    // One script: the dashboard, the Hono API, every queue consumer, the cron
    // handler and the four Durable Object classes. `TanStackStart` rather than
    // `Worker` because the entry is assembled from virtual modules that only
    // the Vite plugin provides — `wrangler.jsonc` says the same thing about why
    // there is no plain `wrangler dev`.
    //
    // `transform.server` is the function form, so it mutates the args SST
    // already built rather than replacing them.
    const web = new sst.cloudflare.TanStackStart("Web", {
      path: "apps/web",
      link: [
        hyperdrive,
        storage,
        ...kvNamespaces,
        ...durableObjects,
        ...queues.map((queue) => queue.resource),
      ],
      transform: {
        server: (args) => {
          args.compatibility = {
            date: COMPATIBILITY_DATE,
            flags: COMPATIBILITY_FLAGS,
          };
          args.migrations = DURABLE_OBJECT_MIGRATIONS.map((migration) => ({
            ...migration,
          }));
          args.transform = {
            ...args.transform,
            worker: (script) => {
              script.observability = { enabled: true };
            },
          };
        },
      },
    });

    // In `sst dev` the site component is a placeholder and builds no script,
    // so there is nothing for a consumer or a cron to attach to. That is
    // known gap 3 on issue #130 — a naive `sst dev` produces queues nothing
    // reads — and it is PR B's dev overlay that has to close it, not this file.
    const script = web.nodes.server?.nodes.worker;
    if (!script) return { url: web.url };

    const accountId = sst.cloudflare.DEFAULT_ACCOUNT_ID;

    // ── Consumers ───────────────────────────────────────────────────────
    // `maxBatchTimeout` is seconds in the registry and in `wrangler.jsonc`;
    // the API takes milliseconds. `maxRetries` is Cloudflare's count of
    // *retries*, which `maxRetriesFor` converts from the registry's count of
    // attempts — the one place that off-by-one is allowed to happen.
    //
    // `maxConcurrency` is left unset when the registry says `null`: that is
    // what opts a queue in to Cloudflare's autoscaling, and it is the same
    // thing `wrangler.jsonc` says by omitting the key.
    for (const { definition, resource } of queues) {
      new cloudflare.QueueConsumer(`${definition.binding}_CONSUMER`, {
        accountId,
        queueId: resource.id,
        scriptName: script.scriptName,
        type: "worker",
        deadLetterQueue: DEAD_LETTER_QUEUE_NAME,
        settings: {
          batchSize: definition.maxBatchSize,
          maxWaitTimeMs: definition.maxBatchTimeout * 1000,
          maxRetries: maxRetriesFor(definition),
          ...(definition.maxConcurrency === null
            ? {}
            : { maxConcurrency: definition.maxConcurrency }),
        },
      });
    }

    // The Worker consumes its own dead letter queue and logs each message at
    // error severity. No `deadLetterQueue` of its own: a failure here has
    // nowhere left to go.
    new cloudflare.QueueConsumer("DEAD_LETTER_CONSUMER", {
      accountId,
      queueId: deadLetterQueue.id,
      scriptName: script.scriptName,
      type: "worker",
      settings: DEAD_LETTER_CONSUMER,
    });

    // ── Cron Triggers ───────────────────────────────────────────────────
    // One resource holding every schedule, because that is how the Cloudflare
    // API models it: `PUT /workers/scripts/{name}/schedules` replaces the whole
    // list. Two resources would fight over it.
    new cloudflare.WorkersCronTrigger("Crons", {
      accountId,
      scriptName: script.scriptName,
      schedules: CRON_EXPRESSIONS.map((cron) => ({ cron })),
    });

    return {
      url: web.url,
      scriptName: script.scriptName,
    };
  },
});
