# Repository Guidelines

## Project Structure & Module Organization

- apps/web: the product. TanStack Start on Cloudflare Workers (#9). Pages are routes under
  `src/routes`; server-side calls are TanStack Start server functions under
  `src/server/functions`. Next.js and tRPC are gone — there is no `src/app`, no
  `src/server/api`, and `next` and `@trpc/*` are not dependencies. Uses Drizzle and Tailwind.
- apps/marketing: Public marketing site (Next.js, static export).
- apps/docs: Mintlify docs content.
- apps/smtp-server: SMTP proxy/server (TypeScript → tsup build).
- packages/\*: Shared libraries (email-editor, ui, eslint-config, tailwind-config, typescript-config, sdk).
- prototypes/\*: Throwaway experiments that answer one design question and are kept for the evidence. Each is self-contained, outside the pnpm workspace (install with `pnpm install --ignore-workspace` inside it), and is not built, deployed, linted or tested by CI. `prototypes/do-hibernation` measures Durable Object residency under an alarm (#7).
- docker/: Dev/compose files; .env\* at repo root define configuration.
- The dev database is Neon Local (`docker/dev/compose.yml`), a proxy to a real Neon branch — not a local Postgres container. It needs `NEON_PROJECT_ID`, `NEON_API_KEY` and `NEON_BRANCH_ID`, read from the root `.env` (the `dx` scripts pass `--project-directory .` so compose sees it) or from `.envrc` via direnv. In a git worktree, source the main checkout's `.envrc` with `source_env "$(git rev-parse --git-common-dir)/../.envrc"`. Connect on `postgres://neon:npg@localhost:54320/neondb?sslmode=require`. `docker/testing/compose.yml` is still plain postgres:16.

## Build, Test, and Development Commands

- `pnpm i`: Install workspace deps (Node >= 20).
- `pnpm dev`: the app, `vite dev` on :8788. Same server `pnpm dev:worker` runs — a Worker has no
  separate `start`, so there is no `start:web:local` any more. `pnpm dev:marketing` (:3001),
  `pnpm dev:docs` and `pnpm dev:editor` are separate; `pnpm dev` no longer starts them.
  **It needs `apps/web/.dev.vars`** (step 2 under "Running the Worker locally"). Without that file
  the isolate dies at startup with `Invalid environment variables` listing `DATABASE_URL`,
  `APP_URL` and `API_KEY_HMAC_SECRET` — which reads like "the env is not loading" but is only ever
  "`.dev.vars` does not exist". Neither half of the app reads the shell's environment: the Worker's
  env is `wrangler` reading `.dev.vars` from disk, and the browser bundle's `NEXT_PUBLIC_*` is Vite
  reading the repo-root `.env` from disk via `envDir`. Verified by running `vite dev` with the
  process environment emptied to six variables: it starts, validates and serves unchanged.
- `pnpm build`: `pnpm -r build` across the workspace. Per-app: `build:web`, `build:marketing`,
  `build:smtp`, `build:sdk`, `build:editor`.
- **There is no Turborepo.** `turbo.json` and the `turbo` dependency are gone: every script is a
  plain `pnpm --filter` / `pnpm -r` invocation. Turbo's task graph was ordering a dependency that
  does not exist — `@usesend/email-editor`, `@usesend/lib` and `@usesend/ui` publish TypeScript
  source (`main`/`types` point at `src/index.ts`), so Vite compiles them directly and their `dist`
  is never consumed. `marketing` builds green with `packages/email-editor/dist` deleted, which is
  the proof. Only `usesend-js` and `smtp-server` emit artifacts anyone uses, both independently,
  and `apps/web/workspace-aliases.ts` already resolves `usesend-js` to source — so the one real
  edge `dependsOn: ["^build"]` had is already handled without it. Do not add it back; `pnpm -r`
  is topological, which is all the ordering this workspace needs.
  Turbo 2 defaults to `envMode: "strict"` and the `dev` task declared no `env`, so it did strip
  the whole environment before Vite started — but that broke nothing and was never why `pnpm dev`
  failed, because neither the Worker's env nor the client bundle's comes from the process
  environment. See the `pnpm dev` bullet.
- `pnpm dx` / `pnpm dx:up` / `pnpm dx:down`: Spin up/down local infra via Docker Compose, then run migrations.
- `pnpm dev:worker`: Run the whole Worker — dashboard and public API — on a local `workerd`
  via `vite dev` (see below).
- Database (apps/web filter): `db:generate` | `db:migrate` | `db:push` | `db:studio`.
- Migrations are drizzle-kit's, in `apps/web/src/server/drizzle/migrations`. The workflow is: edit
  `src/server/drizzle/schema.ts` (the hand-authored source of truth), run `pnpm --filter=web
  db:generate` to write the SQL, then read the generated SQL before committing — drizzle-kit infers
  intent from a schema diff and cannot tell a rename from a drop-and-add. `db:migrate` applies
  migrations. There is no introspection step: nothing regenerates `schema.ts`.
- drizzle-kit's journal is `drizzle.__drizzle_migrations`, in its own `drizzle` schema, so every
  table in `public` is a domain table.
- Database types and enums come from `~/types/db`, never from an ORM package directly. It is the
  one seam over `src/server/drizzle/schema.ts`: enum values (`EmailStatus.SENT`), row types
  (`Campaign`, `Domain`) and `JsonValue`. It is client-safe — it imports the schema with
  `import type`, so adding a value import there would pull the whole schema into the browser
  bundle.
- Never run migrations unless users explicitly asked

## Running the Worker locally

`apps/web/wrangler.jsonc` describes one Worker — `src/server.ts` — carrying the
dashboard, the Hono public API, the queue consumer, the cron handler and the
four Durable Object classes. **No Cloudflare account and no `wrangler login`
are needed**: the dev server runs the real `workerd` binary locally and
simulates KV, R2, Queues and Durable Objects on disk under `apps/web/.wrangler`.
Only `wrangler deploy` needs an account.

**The dev server is Vite, and Vite is `workerd`.** `@cloudflare/vite-plugin`
runs the server half of the app inside a real isolate with every binding in
`wrangler.jsonc`, so there is no second "now try it on Workers" step. Plain
`wrangler dev` cannot build `src/server.ts` — the TanStack Start handler is
assembled from virtual modules only the Vite plugin provides — so
`pnpm dev:worker` is `vite dev`. The three fixture Workers below keep their own
configs and are still plain `wrangler dev`.

1. `pnpm dx:up`, then `pnpm db:migrate`. Hyperdrive's `localConnectionString`
   in `wrangler.jsonc` is the Neon Local database on 54320 — the same
   `DATABASE_URL` the root `.env` migrates — so `dx:up` → `db:migrate` → `dev`
   lands on one database. This matters because the Worker builds its client
   from the Hyperdrive binding per request (`src/server/drizzle/index.ts`);
   `DATABASE_URL` is only the Node fallback, so `.dev.vars` cannot redirect the
   connection and the binding is the only thing that decides.

   **No Neon account?** Neon Local needs `NEON_PROJECT_ID`, `NEON_API_KEY` and
   `NEON_BRANCH_ID`, so `pnpm dx:up` will not start without them. Use the
   throwaway container instead: `pnpm test:infra:up`, then
   `pnpm --filter=web test:integration:prepare:local` once to migrate it, and
   run the Worker with
   `WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://usesend:password@127.0.0.1:54329/usesend_test`.
   That env var overrides the binding for the session and is the general escape
   hatch for pointing local dev at any other database.
2. `cp apps/web/.dev.vars.example apps/web/.dev.vars` and fill it in. `.dev.vars`
   is gitignored. Under `nodejs_compat` these arrive as `process.env`, so
   `src/env.js` validates inside the Worker exactly as it does under Node — an
   env var missing from `.dev.vars` fails the isolate at startup, not at request
   time.
   **`NEXT_PUBLIC_*` does not go in `.dev.vars`** — those come from the
   repo-root `.env`, which `vite.config.ts` points `envDir` at. `.dev.vars` is
   read by `wrangler` at runtime inside the Worker; a public variable has to be
   inlined into the browser bundle at build time, so one set there reached the
   server half only and the two halves of a page disagreed about whether this
   was a cloud install (#9). `src/env.public.ts` therefore takes
   `import.meta.env` before `process.env`: the Worker and the browser it renders
   for are one Vite build and cannot disagree.
3. `pnpm dev:worker`. Everything is on `http://localhost:8788` — the dashboard
   at `/`, the public API under `/api/v1`, `GET /api/v1/doc` for the OpenAPI
   document (no auth), `/storage/*` for R2 and `/api/health` for a liveness
   check that touches nothing.

## Local SES and SNS

`pnpm dx:up` starts `usesend/local-ses-sns` alongside the database. It answers
the SES and SNS APIs on **5350** and posts delivery and bounce notifications
back to the app, so the whole pipeline — identity, send, SNS callback,
`EmailEvent` row — runs with no AWS account. Point the Worker at it with the
`AWS_SES_ENDPOINT` and `AWS_SNS_ENDPOINT` in `.dev.vars.example`; the SDK
appends its own path, so those values end at `/api/ses` and `/api/sns`.

**An unset endpoint means real AWS**, and saving a domain then creates a real,
billable SES identity in whatever account the credentials belong to. `env.js`
therefore requires both outside production, and reaching a real account from a
dev or test environment is an explicit `AWS_ALLOW_REAL_ENDPOINTS=true` (#126).
That is still a supported way to work — it is how you onboard your own SES
account — it just has to be typed rather than forgotten.

Getting to a first send, in order, because each step gates the next:

1. **An SES setting has to exist before any domain can.** `createDomain` asks
   `SesSettingsService.getSetting(region)` first and throws `Ses setting not
   found` with none. One is created under `/admin`, which needs instance admin:
   on a cloud install (`NEXT_PUBLIC_IS_CLOUD=true`, which the repo-root
   `.env.example` sets) that is `ADMIN_EMAIL` matching the address you sign in
   with. Unset, `/admin` is denied and there is no way to configure a region.
2. **The callback URL you give that form must be reachable from inside the
   container**, because SNS confirms the subscription by posting to it, and the
   simulator *exits* when it cannot — leaving the SES call that triggered it to
   fail with `Network connection lost`. `localhost` is the container itself, so
   on Linux use the docker bridge address (`http://172.17.0.1:8788`) and run the
   dev server with `--host`; a host firewall such as `ufw` blocks the bridge by
   default and has to allow it. `WEBHOOK_URL` in `docker/dev/compose.yml` is the
   same address seen from the other side.
3. Sign in — in development `sendSignUpEmail` logs the code instead of sending
   it, so read it out of the dev server's output.

Known gap: `GetEmailIdentity` against the simulator fails to deserialise
(`Expected real number, got implicit NaN`) because it returns ISO-8601 strings
for `VerificationInfo` timestamps where SESv2 specifies epoch seconds. That
breaks **Verify domain** and the domain detail page locally. Sending works;
`Domain.status` has to be set to `SUCCESS` by hand to get past the verification
check. The image is upstream's, third-party, pinned to `:latest`, and has no
source in this repository, so the fix belongs there.

The Worker's request routing is written down once, in the order it is
evaluated, in `src/worker/routing.ts`: `/storage/*`, then the SES callback,
then `/api/v1/*` to Hono, then TanStack Start for everything else. `src/server.ts`
is the entry that gives it the Start handler and holds the exports Cloudflare
looks up by name.

Things that behave differently inside the Worker, by design:

- **No global-scope I/O.** Workers reject sockets, timers and `randomUUID()`
  during module evaluation. Clients must therefore be built on first use, not in
  a module-level `const` or a `static` class field — this is why `drizzleDb` is a
  lazy proxy and why a `WorkersQueue` resolves its binding at send time rather
  than at construction.
- **Queues are Cloudflare Queues.** `server/queue/index.ts` has one driver
  (#12). `enqueue` goes to a Cloudflare Queue producer binding and
  `createWorker` registers a handler rather than starting one — a Cloudflare
  consumer is the `queue()` export on the Worker (`src/worker/queue-consumer.ts`),
  declared in `wrangler.jsonc`. `server/queue/queue-registry.ts` is the source of
  truth for which queues exist, and `queue-registry.unit.test.ts` fails if
  `wrangler.jsonc` disagrees with it. **Adding a queue means editing both**:
  Cloudflare Queues are deploy-time config, so a binding that is not in the
  config is simply absent from `env` at runtime.
- **Queue payloads are ID references.** A message caps at 128 KB and the driver
  refuses anything larger. Never a body, never an attachment.
- **`options.jobId` does nothing.** It was BullMQ's dedup key and Cloudflare
  has no equivalent, so a handler that must not run twice needs its own
  database-side guard (§4.4).
- **Recurring work is a Cron Trigger**, declared in `wrangler.jsonc` and sourced
  from `server/queue/cron-registry.ts`. A job module imports its expression from
  there; it never writes one inline. Sub-minute ticks are not expressible —
  Cron Triggers floor at one minute — so those are Durable Object alarms.
- **Webhook delivery is a Durable Object**, one per `webhookId`. A DO is
  single-threaded per object id, so ordering is a property of where the code
  runs, not a lock to acquire. Two rules from the residency measurement in §4.2
  apply to every DO here and are not optional: **no connection may outlive an
  alarm** (build the database client inside it and `await close()` before
  returning), and **nothing may be left pending across one** — no `setTimeout`,
  no `setInterval`, no unawaited `fetch`. Each makes the object permanently
  ineligible for hibernation, silently, with no error anywhere.
- **No connection reuse across requests.** Workers ties an I/O object to the
  request that created it, so the Worker builds a database client per request
  and publishes it through `AsyncLocalStorage`. Do not cache a connection, a
  socket or a stream in module scope.
- **Storage is a Worker capability.** `storage-service.ts` runs on the R2
  binding, so under Node `isStorageConfigured()` is false and the editors hide
  the image picker. `/storage/*` on the Worker serves uploads and downloads.
- **There is no Redis, and no second runtime.** `bullmq`, `ioredis`,
  `server/redis.ts`, `server/runtime.ts` and the four Redis drivers are deleted
  (#12). Each seam — `server/queue`, `server/cache`, `server/rate-limit`,
  `server/idempotency` — has exactly one driver, and the seam is still the line
  nothing above it may reach across. Cache goes through `server/cache` (Workers
  KV). Anything needing read-after-write — a counter, a dedup guard — cannot use
  KV and belongs on a Durable Object.
- **KV cannot express a TTL under 60 seconds**, and its reads, writes, deletes
  and negative lookups are all eventually consistent within roughly that window.
  `CacheStore.add` is therefore best-effort; the only callers are notification
  cooldowns, where losing the race costs a duplicate email.
- **Rate limits are a Durable Object**, one object per bucket, through
  `server/rate-limit`. Not Cloudflare's Rate Limiting binding: that one is
  per-colo and approximate, and the public API's default is two requests per
  second, so ten colos would grant twenty. All three limiters **fail open**
  except the waitlist — the reasoning is in `server/rate-limit/index.ts` and it
  is a decision, not an accident.
- **Idempotency is a Durable Object**, one per `teamId` + `Idempotency-Key`,
  through `server/idempotency`. `begin` returns `acquired`, `hit`, `conflict` or
  `in-progress` in one call; there is no lock to take and release. KV would let
  two identical sends inside its propagation window both read "no record" and
  both send.
- **KV namespaces and Durable Object bindings live in `server/binding-registry.ts`**,
  and `binding-registry.unit.test.ts` fails if `wrangler.jsonc` disagrees. Same
  rule as queues: **adding one means editing both**, plus a `migrations` entry
  for a new Durable Object class and an `export` from `src/server.ts`.
- **`wrangler dev` writes nothing to Cloudflare.** Never run `wrangler deploy` or
  `wrangler login` without being asked.

`pnpm --filter=web compat:check` runs the §8 runtime-compatibility list
(`src/worker/compat-check.ts`) inside a real isolate and reports what passed.
Run it after changing anything in the Worker's dependency tree.

`pnpm --filter=web queue:check` runs the queue seam inside a real isolate the
same way (`src/worker/queue-check.ts`, port 8791): enqueue through the real
driver, consume through the real `queue()` export, and observe `delaySeconds`,
the retry backoff, the dead letter hop and webhook ordering through the Durable
Object.

`pnpm --filter=web bindings:check` does the same for the Phase 9 seams
(`src/worker/binding-check.ts`, port 8792): the KV cache binding, a rate limit
counted in a Durable Object under twenty concurrent callers — the exactness
claim that justifies not using the Rate Limiting binding — and ten concurrent
duplicate requests under one `Idempotency-Key`. All three
are fixture Workers with their own `wrangler.*.jsonc` and are never deployed.
None of them can prove KV's *eventual consistency* — `wrangler dev` simulates KV
on local disk, where a read after a write is always fresh — so the 60-second
window is reasoned about at the call sites instead.

To exercise a Cron Trigger locally, POST the expression to the dev server —
`wrangler dev` does not fire them on schedule:

```sh
curl "http://localhost:8788/cdn-cgi/handler/scheduled?cron=0+3+*+*+*"
```

## The dashboard (TanStack Start)

Four directories, and which one a file belongs in follows from who is allowed to call it.

- **`src/routes/`** — the URL tree. File-based; `src/routeTree.gen.ts` is generated and
  committed so `tsc` works without running Vite. A file whose name starts with `-` is *not*
  a route, which is how a page's own components sit next to it
  (`routes/login/-login-page.tsx`). `_dashboard.tsx` is a pathless layout: it holds the
  sign-in gate and the chrome, and its children keep the URLs they had.
- **`src/server/functions/<area>.ts`** — one module per former tRPC router. Every function is
  `createServerFn(...)` behind middleware from `functions/middleware.ts`.
- **`src/queries/<area>.ts`** — `queryOptions` factories and a key namespace.
  `<area>Keys.all` is the prefix of every other key in the area, because that is what
  `api.useUtils().<router>.invalidate()` used to be. A key written inline at a call site is a
  key that will eventually disagree with the one that wrote the cache entry.
- **`src/server/authorization.ts`** — the rules the middleware enforces, with no framework in
  them, so they can be read and tested without building a request.

Rules that are not style:

- **Take `teamId` from `context`, never from input.** The middleware ladder is the
  authorisation boundary; a handler that reads a team id the caller sent has walked around it.
- **A resource middleware contributes its own validator field.** `domainMiddleware` means the
  function takes `{ id: number }`; do not redeclare it in the function's own `.validator()`.
- **Start chains validators, so a middleware's `z.object()` strips the function's own input.**
  Each validator is fed the *previous* one's output. A resource loader that parsed strictly
  would delete the fields the server function declared for itself before that function's
  validator ever ran — silently, with no error. All six loaders are `.passthrough()` for that
  reason and `middleware.unit.test.ts` fails if one stops being. The mirror image cannot be
  fixed and is the rule at the call site: the function's own validator strips the *loader's*
  field, so **read the resource from `context`** (`context.domain.id`), never from `data`, even
  though the inferred type of `data` claims the field is there.
- **A server function's return type is checked for serialisability.** Drizzle types a `jsonb`
  column as `unknown`, which Start rejects; coerce it at the seam (`contacts.ts`'s
  `withStringProperties`) rather than in the component. superjson left with tRPC, so `Date`
  travels natively but a `Map`, a `Set` or a `BigInt` does not.
- **`.validator()`, not `.inputValidator()`** — the latter is deprecated in this version.
- **Queries get a `queryOptions` factory; mutations are called directly** by the component
  through `useMutation({ mutationFn })`, invalidating with a key from the area's `queries/`
  module.
- **`beforeLoad` runs on the server during SSR**, so a `redirect()` thrown there is a real
  HTTP redirect on the first request and a client navigation afterwards. That is where a gate
  belongs — not in a component that renders a login form at someone else's URL.
- Errors are `AppError` from `~/server/app-error`. Only the message crosses the wire.

**Every dashboard area has moved, and the old one is deleted.** `src/app`, `src/trpc` and
`src/server/api` are gone, along with `next`, `@trpc/*`, `superjson`, `next.config.js` and the
`*.trpc.test.ts` tier. `pnpm --filter=web dev` and `pnpm dev:worker` both run `vite dev`;
there is no other way to run this app.

**A helper worth testing goes on a service, never beside a server function.** Start strips
`createServerFn` handler bodies from the client build, but a plain exported function next to
them is an ordinary export the client bundle keeps — so it drags Drizzle and the `postgres`
driver into the browser, the client entry dies on `Buffer is not defined`, and React silently
never hydrates. `tsc` and every test still pass. The only way to catch it is to load a page.

## Coding Style & Naming Conventions

- Files: React components PascalCase (e.g., `AppSideBar.tsx`); folders kebab/lowercase.
- Paths (web): use alias `~/` for src imports (e.g., `import { x } from "~/utils/x"`).
- NEVER USE DYNAMIC IMPORTS. ALWAYS IMPORT ON THE TOP
- Linting: the shared configs in `packages/eslint-config` turn the base `no-unused-vars` off and use
  `@typescript-eslint/no-unused-vars` instead — the base rule is TypeScript-unaware and reports
  type-only imports, parameters of function types and `declare module` blocks as unused. A binding
  that is deliberately unused is prefixed with `_` (`_job`, `_target`, `_request`) — that is the
  configured escape hatch (`argsIgnorePattern`/`varsIgnorePattern`/`caughtErrorsIgnorePattern`), not
  an `eslint-disable` comment.
- `pnpm lint` is `pnpm -r --no-bail lint`, so it lints every package that has a `lint` script and
  reports all of them rather than stopping at the first failure — the repo-wide number, in one run.
  It exits non-zero if any package failed. Nothing in CI runs lint today; see #87.

## Dependencies

- **`pnpm-workspace.yaml` is the only place pnpm reads settings from** — `overrides`,
  `packageExtensions`, `allowBuilds`, `minimumReleaseAgeExclude`. There is no second copy: the
  `"pnpm"` field in root `package.json` was a duplicate pnpm 11 ignores outright, and it is gone
  (issue #55). Do not add one back "for older pnpm" — there is no deployment path that resolves pnpm
  from anywhere else now that the Docker and nixpacks builds are gone (#12), and a settings file that
  is edited but not read is the worst place for a security override to live.
- **Check `pnpm-lock.yaml`, not the settings file, to confirm a pnpm setting took effect.** The
  lockfile header records the effective `overrides:` and a `packageExtensionsChecksum:`, and the
  package entries record the resolved versions — that is the only evidence that the setting was read
  rather than merely written. A `[WARN]` about ignored settings is easy to miss in install output.
- **A package that imports something it never declared resolves it by hoist order, so adding an
  unrelated dependency can silently change which version it gets.** `@hookform/resolvers` imports
  `zod` with neither a dependency nor a peer on it. It got zod 3 until `better-auth` put zod 4 in the
  tree and won the hoist — which retyped every `zodResolver(...)` call against the wrong major and
  broke `typecheck` in six components nobody had edited.
- Fix that by declaring the missing dependency in `packageExtensions`, not by casting at the call
  sites. A cast hides a real version mismatch and has to be repeated; the declaration states what the
  package actually needs and survives the next install. The declaration shows up in the lockfile as a
  `zod:` line under `@hookform/resolvers@<version>(...)`; if it is not there, it was not applied.
- After adding any dependency, run `pnpm --filter=web typecheck` before assuming the change is
  contained. A new transitive major of a shared library — zod, react, drizzle — surfaces as type
  errors in files the change never touched.

## Logging

- `logger` from `~/server/logger/log` is the only logger. Never `console.log`.
- Records follow the **OpenTelemetry Logs Data Model**, one JSON object per line: `timestamp` (RFC 3339), `severity_text`, `severity_number`, `body`, `resource`, `attributes`, plus `trace_id` / `span_id` / `trace_flags` when there is a trace. Not pino's `level` / `time` / `msg` — that shape is gone.
- The call shape is unchanged: `logger.info({ teamId }, "Sending email")`. The string is the OTel `Body` — write it for a human; the object becomes `attributes` — put the ids there. Prefer both: a record with no body is hard to search, and a body with the ids interpolated into it is hard to filter.
- **Errors:** pass the `Error` itself, under any key — `logger.error({ err }, "…")`. The logger maps the first Error to `exception.type` / `exception.message` / `exception.stacktrace` and appends the `cause` chain. Do not unpack `err.message` at the call site.
- **Attribute keys:** camelCase for our own ids (`teamId`, `emailId`, `campaignId`). Dotted names only where OTel defines a semantic convention (`exception.*`, `service.*`); do not invent new dotted names.
- **Never log personal data or secrets in an attribute.** No raw email addresses — use `maskEmail` from `~/server/logger/redact`. No API keys, tokens, magic links or message bodies. Never a whole provider payload (`{ data }` from an SES/SNS event): log the ids out of it.
- **Trace context** lives in `~/server/logger/trace-context`. Entry points — HTTP handlers, routes, anything that starts work — wrap themselves in `withTraceContext(startTrace(req.headers.get("traceparent")), …)`. The queue seam (`server/queue/index.ts`) carries it across enqueue/consume on its own, so services, jobs and handlers never touch it.
- **Export path: structured stdout.** Cloudflare Workers Logs ingests and indexes these records (`observability.enabled` in `wrangler.jsonc`). There is deliberately no OTLP exporter in the request path — a log line must not cost a subrequest. If OTLP is wanted, it belongs in a tail worker.

## Rules

- **tRPC is gone (#9).** There are no routers and no `@trpc/*` packages. A new server-side
  call is a server function — see "The dashboard (TanStack Start)" above.
- **Do not add work to the SES event pipeline to learn something we already
  know.** Every subscribed SES event costs an SNS POST, a queue message and a
  consumer invocation per email, and the pipeline is the single largest line in
  the cost model. `SEND` was dropped for exactly this reason (issue #2): the
  facts it carried — `DailyEmailUsage.sent`, `Email.latestStatus = SENT`, the
  `email.sent` webhook, `Campaign.sent` — are all recorded locally now, at
  enqueue and at the SES handoff, where they arrive sooner and cannot be
  delayed, dropped or replayed. Reach for an SES subscription only for facts
  that originate at SES: bounces, complaints, deliveries, rejects.
- **Counters that feed billing need a database-side idempotency guard, not a
  queue-side one.** `DailyEmailUsage.sent` is gated on `Email.usageCountedAt`
  making a one-way transition in the same statement as the increment.
  `EnqueueOptions.jobId` dedup looks like it would do the job, but it is a
  BullMQ affordance and Cloudflare Queues has no equivalent, so anything built
  on it stops working mid-migration — silently, and in the direction of
  overcharging.
- **Match the hash to the secret's entropy.** A password-hashing KDF (scrypt,
  bcrypt, argon2) exists to suppress guess rates against *low-entropy* secrets.
  Applying one to a high-entropy random token buys no security and costs
  milliseconds per request: `scryptSync` over a 128-bit API key was 18.7 CPU-ms
  under Node and ~14ms in a `workerd` isolate, against Workers' **10ms Free-tier
  CPU budget per request** (issue #48). Use a keyed HMAC for tokens we generate;
  keep the KDF for secrets a human chose.
- **Every new secret has to be declared in three places** or something breaks
  quietly: `apps/web/src/env.js` (schema *and* `runtimeEnv`), `.env.example` —
  with the command that generates it — and `apps/web/.dev.vars.example`, which
  is what a local Worker reads. There used to be a fourth, `turbo.json`'s `env`
  allowlist; Turborepo is gone, so `.env` now reaches the dev server unfiltered
  and there is no second list to keep in sync. Add a placeholder to
  `apps/web/src/test/setup/setup-env.ts` if it is required rather than optional.
  Never commit a real value. On a deployed Worker a secret is
  `wrangler secret put`, not a file, so `apps/docs/self-hosting/overview.mdx`
  lists them too; `apps/web/.env.test.example`, `.github/workflows/test-web.yml`
  and `CONTRIBUTION.md` carry their own copies. Renaming one is wider than the
  three places above.
- **There is no web container.** Self-hosting useSend is `wrangler deploy`
  (#12). `docker/Dockerfile`, `docker/start.sh`, `docker/build.sh`,
  `docker/prod/compose.yml`, `.env.selfhost.example` and `nixpacks.toml` are
  deleted, and `.github/workflows/publish.yml` publishes exactly one image:
  `apps/smtp-server`, which is a raw TCP listener that cannot run on Workers.
  `docker/dev/compose.yml` and `docker/testing/compose.yml` stay — they are
  local infrastructure, not shipped artifacts.
- **There are two env modules, and which one a variable goes in is a security
  boundary, not a style choice.** `~/env` is server-only: its `runtimeEnv`
  reads `process.env` once per declared variable at module load, and `process`
  does not exist in a Vite client bundle, so one client import of it is a
  `ReferenceError` on first paint. `~/env.public` holds the handful a browser
  may read. Vite **bakes those in at build time** — it inlines
  `import.meta.env.NEXT_PUBLIC_*` — so changing one on a deployed Worker without
  rebuilding changes nothing in the browser, and nothing secret can go there.
  A module imported from a component reads `~/env.public`; that is why
  `~/utils/common` holds only `isCloud`/`isSelfHosted` and the retention flags
  it used to sit next to now live in `~/server/retention`.
  The `NEXT_PUBLIC_` prefix outlived Next.js. It is now only a name — nothing
  reads it that is not ours — and dropping it is Phase 10's (#12), because it
  changes operator-facing configuration and wants its own PR.
- **`APP_URL` is the one name for the application's public base URL**, and
  `APP_SECRET` is the one name for the application-wide signing key. Neither is
  an auth setting despite having been called `NEXTAUTH_*` until issue #59. Do not
  reintroduce a `BETTER_AUTH_URL`-style second name for either: better-auth takes
  `baseURL: env.APP_URL`.
- **Input limits belong at the service seam, not in a request schema.**
  `sendEmail`/`sendBulkEmails` in `service/email-service.ts` is what every path
  that can produce an email goes through — public API, batch, SMTP, the
  dashboard's test send, double-opt-in — so a limit enforced there cannot be
  walked around by a second entry point, and is stated once. The public API's Zod
  schema *documents* the attachment limits (they reach the OpenAPI document and
  the SDK types from there) but does not enforce them; see
  `service/attachment-limits.ts`. Regenerate the SDK types with
  `pnpm --filter=usesend-js openapi-typegen` after touching
  `apps/docs/api-reference/openapi.json`.
- **`APP_SECRET` cannot be rotated.** It keys the SHA-256 hashes in campaign
  unsubscribe, one-click-unsubscribe and double-opt-in links, which are already
  sitting in delivered inboxes. A new value invalidates all of them, and one-click
  unsubscribe is an RFC 8058 and Gmail/Yahoo bulk-sender obligation. The same
  applies to switching the construction from `createHash` to `createHmac`, which
  is worth doing on its own terms but changes every hash — treat it as a
  link-invalidating migration, not a cleanup.

## Testing Guidelines

- Web testing is configured with Vitest in `apps/web`; add tests when changes impact logic, APIs, or behavior.
- Prefer targeted suites first: `pnpm test:web:unit`, `pnpm test:web:api`; use `pnpm test:web` for default non-integration coverage.
- Test file conventions: `*.unit.test.ts`, `*.api.test.ts`, `*.integration.test.ts`. The `*.trpc.test.ts` tier went with the routers it covered (#9).
- Choose the suite by what is under test, not by what the code touches. Logic — branching, validation, defaults, which notification fires — belongs in a unit test with its edges faked. Queries belong in an integration test against the real database: a mocked query builder only ever asserts the arguments you passed it, never what the query did.
- Do not assert on the shape of a database call (`expect(mockDb.x.update).toHaveBeenCalledWith(...)`). That restates the input and passes even when the query is wrong. Assert on the row that came back, or capture the payload the builder actually received.
- Integration tests require infra and env (`RUN_INTEGRATION=true` with the `usesend_test` Postgres container running). Root commands `pnpm test:web:all` and `pnpm test:web:integration:full` auto-manage infra lifecycle. Postgres is the only infrastructure they need: the cache, the rate limiter, the idempotency store and the webhook dispatcher are Worker bindings, and `src/test/integration/bindings.ts` supplies in-memory ones that run the real Durable Object classes.
- **Install those bindings from `src/test/integration/helpers.ts`, never from a `setupFiles` entry.** A setup file is evaluated before the test module, so everything `bindings.ts` imports — the DO classes pull in a large part of the server graph — would already be in the module registry when a test file's hoisted `vi.mock` calls ran, and the mocks would silently not apply. Twenty-nine tests failed exactly that way before this moved.
- Use `pnpm test:infra:up` / `pnpm test:infra:down` when running targeted integration commands manually.
- The integration suite runs single-fork, so module-level clients are shared across every file. Never close one in a per-file `afterAll` — `postgres-js` `end()` is terminal, and the first file to call it fails every file after it. (Prisma's `$disconnect` is safe only because it reconnects lazily.)
- `pnpm test:web:integration:full` and `test:integration:prepare` run migrations (`drizzle-kit migrate`); never run these unless the user explicitly asks, because they take `DATABASE_URL` from the environment and will migrate whatever it points at. The one safe path is `test:integration:prepare:local`, which `pnpm test:web:all` uses: its `DATABASE_URL` is hardcoded to the `usesend_test` container that `test:infra:up`/`down` creates and destroys per run, so it cannot reach a dev or production database. It takes an empty container to the current schema.
- `pnpm --filter=web bench:cpu` runs the CPU benchmark (`apps/web/src/bench/*.bench.ts`) that backs the CPU-ms figures in `references/serverless-migration.md` §12. It needs no database or infra, and no test suite picks it up — `vitest.bench.config.ts` is the only config that matches `*.bench.ts`.
- Test defaults are cloud mode (`NEXT_PUBLIC_IS_CLOUD=true`); keep new tests compatible with cloud behavior unless the task says otherwise.
- Run the tests when you finish a change, before reporting it done. Always `pnpm --filter=web typecheck`, then the suites your change touches; use `pnpm test:web:all` when it touches services, queues, jobs, or the database. Report what you actually ran and what it said — if a suite was skipped or failed, say so rather than describing the change as complete.

## Commit & Pull Request Guidelines

- Prefer Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`). Git history shows frequent feat/fix usage.
- Track the issue number as the commit scope: `feat(#42): …`, `refactor(#3): …`. Applies to PR titles too, since a squash merge uses the title as the subject. Still put `Closes #nnn` in the body — the scope alone does not close the issue.
- PRs must include: clear description, linked issues, screenshots for UI changes, migration notes, and verification steps.
- never run build,migration commands unless asked for

## Stacked Pull Requests

- Long changes ship as a stack of small PRs, managed with the `github/gh-stack` extension (`gh extension install github/gh-stack`). Install it before touching a stack.
- Append a new PR to the chain with `gh stack link <stack-number> <branch-or-pr>`. The stack number is the one in the GitHub stack UI, and it is not a PR number — passing it first appends to that stack without re-listing the PRs already in it.
- The payoff is `gh stack merge`: it merges the whole stack atomically, all-or-nothing. Only the owner runs it — never merge a stack yourself.
- **A stack is linear: two PRs must never share a base.** Branch from the current top of the stack, not from the tip you happened to start on. When several agents open PRs against the same tip concurrently they fork the stack, and someone has to rebase afterwards to straighten it out.
- **`gh stack checkout` switches branches in the current working tree** (and pulls down stack branches, which can move local refs). Agents share this checkout, so run it — and any other stack command that moves branches — from your own `git worktree`, never in a tree someone else is using.
- `gh stack view` reads local tracking state only; a stack that was assembled with `gh stack link` is invisible to it until you `gh stack checkout` it. To inspect a stack without moving any branch, read it straight from the API: `gh api repos/allanclempe/useSend/stacks`.
