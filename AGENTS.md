# Repository Guidelines

## Project Structure & Module Organization

- apps/web: Next.js app (primary product). Uses Drizzle, TRPC, Tailwind.
- apps/marketing: Public marketing site (Next.js, static export).
- apps/docs: Mintlify docs content.
- apps/smtp-server: SMTP proxy/server (TypeScript → tsup build).
- packages/\*: Shared libraries (email-editor, ui, eslint-config, tailwind-config, typescript-config, sdk).
- prototypes/\*: Throwaway experiments that answer one design question and are kept for the evidence. Each is self-contained, outside the pnpm workspace (install with `pnpm install --ignore-workspace` inside it), and is not built, deployed, linted or tested by CI. `prototypes/do-hibernation` measures Durable Object residency under an alarm (#7).
- docker/: Dev/compose files; .env\* at repo root define configuration.
- The dev database is Neon Local (`docker/dev/compose.yml`), a proxy to a real Neon branch — not a local Postgres container. It needs `NEON_PROJECT_ID`, `NEON_API_KEY` and `NEON_BRANCH_ID`, read from the root `.env` (the `dx` scripts pass `--project-directory .` so compose sees it) or from `.envrc` via direnv. In a git worktree, source the main checkout's `.envrc` with `source_env "$(git rev-parse --git-common-dir)/../.envrc"`. Connect on `postgres://neon:npg@localhost:54320/neondb?sslmode=require`. `docker/testing/compose.yml` is still plain postgres:16.

## Build, Test, and Development Commands

- `pnpm i`: Install workspace deps (Node >= 20).
- `pnpm dev`: Turbo dev for all relevant apps (loads `.env`).
- `pnpm start:web:local`: Run only `apps/web` locally on port 3000.
- `pnpm build`: Turbo build across the monorepo.
- `pnpm dx` / `pnpm dx:up` / `pnpm dx:down`: Spin up/down local infra via Docker Compose, then run migrations.
- `pnpm dev:worker`: Run the public API on Cloudflare Workers locally (see below).
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

`apps/web/wrangler.jsonc` serves the Hono public API (`src/worker/index.ts`) on
Cloudflare Workers. **No Cloudflare account and no `wrangler login` are needed**:
`wrangler dev` runs the real `workerd` binary locally and simulates KV, R2,
Queues and Durable Objects on disk under `apps/web/.wrangler`. Only
`wrangler deploy` needs an account.

1. `pnpm test:infra:up`, then `pnpm --filter=web test:integration:prepare:local`
   once to migrate the throwaway `usesend_test` container. That is the database
   `wrangler.jsonc` points Hyperdrive at locally. To use a different one for a
   session, set
   `WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://…`.
2. `cp apps/web/.dev.vars.example apps/web/.dev.vars` and fill it in. `.dev.vars`
   is gitignored. Under `nodejs_compat` these arrive as `process.env`, so
   `src/env.js` validates inside the Worker exactly as it does under Node — an
   env var missing from `.dev.vars` fails the isolate at startup, not at request
   time.
3. `pnpm dev:worker`. The API is on `http://localhost:8788/api`; `GET /api/v1/doc`
   serves the OpenAPI document and needs no auth.

Things that behave differently inside the Worker, by design:

- **No global-scope I/O.** Workers reject sockets, timers and `randomUUID()`
  during module evaluation. Clients must therefore be built on first use, not in
  a module-level `const` or a `static` class field — this is why `drizzleDb` is a
  lazy proxy and why the BullMQ driver defers its queue.
- **No BullMQ.** `server/queue/index.ts` picks a driver by runtime. Inside a
  Worker, `enqueue` goes to a Cloudflare Queue producer binding and
  `createWorker` registers a handler rather than starting one — a Cloudflare
  consumer is the `queue()` export on the Worker (`src/worker/queue-consumer.ts`),
  declared in `wrangler.jsonc`. `server/queue/queue-registry.ts` is the source of
  truth for which queues exist, and `queue-registry.unit.test.ts` fails if
  `wrangler.jsonc` disagrees with it. **Adding a queue means editing both**:
  Cloudflare Queues are deploy-time config, so a binding that is not in the
  config is simply absent from `env` at runtime.
- **Queue payloads are ID references.** A message caps at 128 KB and the driver
  refuses anything larger. Never a body, never an attachment.
- **`options.jobId` does nothing on Workers.** It is BullMQ's dedup key and
  Cloudflare has no equivalent, so a handler that must not run twice needs its
  own database-side guard (§4.4).
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
- **`wrangler dev` writes nothing to Cloudflare.** Never run `wrangler deploy` or
  `wrangler login` without being asked.

`pnpm --filter=web compat:check` runs the §8 runtime-compatibility list
(`src/worker/compat-check.ts`) inside a real isolate and reports what passed.
Run it after changing anything in the Worker's dependency tree.

`pnpm --filter=web queue:check` runs the queue seam inside a real isolate the
same way (`src/worker/queue-check.ts`, port 8791): enqueue through the real
driver, consume through the real `queue()` export, and observe `delaySeconds`,
the retry backoff, the dead letter hop and webhook ordering through the Durable
Object. Both are fixture Workers with their own `wrangler.*.jsonc` and are never
deployed.

To exercise a Cron Trigger locally, POST the expression to the dev server —
`wrangler dev` does not fire them on schedule:

```sh
curl "http://localhost:8788/cdn-cgi/handler/scheduled?cron=0+3+*+*+*"
```

## Coding Style & Naming Conventions

- Files: React components PascalCase (e.g., `AppSideBar.tsx`); folders kebab/lowercase.
- Paths (web): use alias `~/` for src imports (e.g., `import { x } from "~/utils/x"`).
- NEVER USE DYNAMIC IMPORTS. ALWAYS IMPORT ON THE TOP

## Dependencies

- **`pnpm-workspace.yaml` is the only place pnpm reads settings from** — `overrides`,
  `packageExtensions`, `allowBuilds`, `minimumReleaseAgeExclude`. There is no second copy: the
  `"pnpm"` field in root `package.json` was a duplicate pnpm 11 ignores outright, and it is gone
  (issue #55). Do not add one back "for older pnpm" — both deployment paths resolve pnpm from
  `packageManager` via corepack (`docker/Dockerfile`, `nixpacks.toml`), and a settings file that is
  edited but not read is the worst place for a security override to live.
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

- Prefer to use trpc alway unless asked otherwise
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
- **Every new secret has to be declared in four places** or something breaks
  quietly: `apps/web/src/env.js` (schema *and* `runtimeEnv`), `turbo.json`'s
  `env` list, `.env.example`, and `.env.selfhost.example` — the last two with the
  command that generates it. Add a placeholder to
  `apps/web/src/test/setup/setup-env.ts` if it is required rather than optional.
  Never commit a real value. Docker and self-host paths carry their own copies —
  `docker/prod/compose.yml`, `docker/README.md`, `apps/web/.dev.vars.example`,
  `apps/web/.env.test.example`, `.github/workflows/test-web.yml`, `CONTRIBUTION.md`
  and `apps/docs/**` — so renaming one is wider than the four places above.
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
- Prefer targeted suites first: `pnpm test:web:unit`, `pnpm test:web:trpc`, `pnpm test:web:api`; use `pnpm test:web` for default non-integration coverage.
- Test file conventions: `*.unit.test.ts`, `*.trpc.test.ts`, `*.api.test.ts`, `*.integration.test.ts`.
- Choose the suite by what is under test, not by what the code touches. Logic — branching, validation, defaults, which notification fires — belongs in a unit test with its edges faked. Queries belong in an integration test against the real database: a mocked query builder only ever asserts the arguments you passed it, never what the query did.
- Do not assert on the shape of a database call (`expect(mockDb.x.update).toHaveBeenCalledWith(...)`). That restates the input and passes even when the query is wrong. Assert on the row that came back, or capture the payload the builder actually received.
- Integration tests require infra and env (`RUN_INTEGRATION=true` with Postgres/Redis available). Root commands `pnpm test:web:all` and `pnpm test:web:integration:full` auto-manage infra lifecycle.
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
