# Cloudflare migration plan

Status: **plan / not started**

**Target stack**

| Layer | From | To |
|---|---|---|
| Runtime | Next.js 15 (App Router) on Node | **TanStack Start on Cloudflare Workers** |
| ORM | Prisma 6 | **Drizzle** |
| Database | Postgres (self-hosted / RDS) | **Neon** via **Hyperdrive** |
| Auth | NextAuth v4 + `@auth/prisma-adapter` | **better-auth** + Drizzle adapter |
| Queues | BullMQ / Redis | **Cloudflare Queues** |
| Scheduling | BullMQ repeatable jobs | **Cron Triggers** + **Durable Object alarms** |
| Locks / ordering | Redis `SET NX PX` + Lua | **Durable Objects** (single-threaded by construction) |
| Cache / idempotency | Redis | **Workers KV** + **Durable Objects** |
| API rate limits | Redis `INCR` | **Rate Limiting binding** or a Durable Object |
| Object storage | MinIO / S3 | **R2** |
| IaC | — | **wrangler** |
| SMTP relay | `apps/smtp-server` container | **unchanged**, stays a container (see §7) |
| Email delivery | AWS SES | **AWS SES** (unchanged; CF Email Service adapter is a later, large ticket) |

---

## 1. What Redis is doing today, and where each piece lands

Redis carries five unrelated responsibilities. Only the first is a queue.

| # | Responsibility | Today | Target |
|---|---|---|---|
| 1 | Job queues | BullMQ, 8 queues | **Cloudflare Queues** + **Cron Triggers** |
| 2 | Per-webhook ordering lock | `SET NX PX` + Lua release (`webhook-service.ts:681-703`) | **Durable Object per `webhookId`** — the lock is deleted, not ported |
| 3 | Idempotency keys | `idem:` / `idemlock:` (`idempotency-service.ts`) | **Durable Object** (needs strong consistency) |
| 4 | API / auth / waitlist rate limits | `INCR` + `EXPIRE` (`hono.ts:69-86`) | **Rate Limiting binding**, or a DO for exact counts |
| 5 | Team & usage cache, notification dedup | `withCache`, `limit:notify:` (`team-service.ts:398`) | **Workers KV** with TTL |

**Do not use KV for #3 or #4.** KV is eventually consistent (~60s global propagation). Idempotency
and rate limiting both need read-after-write. KV is correct for #5 only.

## 2. Queue-by-queue mapping

From `apps/web/src/server/queue/queue-constants.ts`:

| BullMQ queue | Target | Notes |
|---|---|---|
| `{region}-transactional` | CF Queue → consumer Worker | `max_concurrency` = `transactionalQuota` |
| `{region}-marketing` | CF Queue → consumer Worker | `max_concurrency` = `marketingQuota` |
| `webhook-dispatch` | **Durable Object per `webhookId`** | serialization is free; DO alarm drives retry backoff |
| `campaign-emails-processing` | CF Queue | |
| `campaign-batch` | CF Queue | must self-chunk, §4.3 |
| `contact-bulk-add` | CF Queue | must self-chunk, §4.3 |
| `ses-webhook` | HTTP route → CF Queue | SNS already POSTs to `setting.callbackUrl`; keep the HTTP hop |
| `campaign-scheduler` | **Durable Object alarm** | preserves the 1.5s tick exactly, §4.2 |
| `domain-verification` | Cron Trigger `0 * * * *` | 1:1 with today's pattern |
| `webhook-cleanup` | Cron Trigger | clean fit |
| `usage-reporting` | Cron Trigger | clean fit |
| `cleanup-email-bodies` | Cron Trigger | clean fit |

**Delayed sends.** CF Queues `delaySeconds` caps at 12 hours — far better than SQS's 15 minutes.
- delay ≤ 12h → `delaySeconds` on send
- delay > 12h (scheduled campaigns) → **Durable Object alarm** that enqueues at fire time

**Scheduled emails are not enqueued at all — see §4.5.**

## 3. Why Durable Objects, specifically

Three of the hardest problems collapse into one primitive:

- **Webhook ordering.** A DO is single-threaded per object ID. `webhook-service.ts:536-703` —
  `acquireLock`, `releaseLock`, the Lua script, `WEBHOOK_LOCK_TTL_MS`, `WEBHOOK_LOCK_RETRY_DELAY_MS`,
  and the lock-not-acquired retry path all **delete**.
- **The 1.5s scheduler tick.** `setAlarm()` is millisecond-precision. No 1-minute floor.
- **Delayed sends and idempotency.** Transactional DO storage with strong consistency, plus alarms.

This is the main reason Cloudflare beats the AWS/SQS design for this codebase.

## 4. The five things that are genuinely hard

### 4.1 Queues are static in `wrangler.toml`; SES regions are dynamic

`EmailQueueService.initializeQueue(region, quota, ...)` is called **at runtime** when a user adds an
SES region in the UI (`ses-settings-service.ts:127`, `:193`). Queue bindings are deploy-time config.

**Resolution:** a fixed `SUPPORTED_SES_REGIONS` list in `wrangler.toml`, with queue + consumer pairs
pre-declared for each. Idle queues cost nothing. Adding a region becomes a deploy — a real product
behaviour change that needs UI copy.

`max_concurrency` is also deploy-time, while `sesEmailRateLimit` is a DB column editable in the UI.
**Decided: deploy-time only.** Changing the rate limit in the UI no longer takes effect until a
deploy. `updateSesSetting` (`ses-settings-service.ts:193`) must stop implying an immediate effect,
and the settings UI needs copy saying so.

### 4.2 The campaign scheduler ticks every 1.5s

`campaign-scheduler-job.ts:12` — `SCHEDULER_TICK_MS = 1500`. Cron Triggers floor at 1 minute, so
this one job must be a **Durable Object with a self-rescheduling alarm**, not a Cron Trigger.
No behaviour change required, unlike the EventBridge design.

### 4.3 Workers CPU and subrequest limits vs unbounded loops

Three handlers iterate unbounded result sets in a single job:
- `runDueDomainVerifications()` — iterates **every** domain sequentially (`domain-verification-job.ts:17-38`)
- `contact-bulk-add` — bulk contact import
- `campaign-batch` — campaign fan-out

Each must **fan out or self-continue**: process a bounded page, enqueue a continuation with a cursor.
Two separate ceilings apply — CPU time *and* the per-invocation **subrequest limit** (1000 on paid).
`runDueDomainVerifications` makes AWS calls per domain, so it hits the subrequest cap well before CPU.
This is the largest behavioural code change in the migration and is not optional.

### 4.4 At-least-once delivery

CF Queues are at-least-once; BullMQ was effectively at-most-once per attempt. Every consumer must be
idempotent. `IdempotencyService` covers the public API send path but **not** internal job handlers —
those need the same treatment. Configure a DLQ (`dead_letter_queue`) and `max_retries` per queue.

**Queue message size caps at 128 KB.** Current payloads are ID references only
(`emailId`, `callId`, `contactBookId`) so this is fine — but it is now a constraint: never put an
email body or attachment in a message.

### 4.5 Scheduled emails: sweeper, not queue mutation

Neither `changeDelay` (`email-queue-service.ts:279`) nor `chancelEmail` (`:301`, note the typo)
has a Cloudflare Queues equivalent — a queued message cannot be moved or withdrawn.

They do not need one. **Postgres is already the source of truth**: `updateEmail`
(`email-service.ts:304`) writes `scheduledAt` to the DB and only then mutates the queue;
`cancelEmail` (`:336`) sets `latestStatus = 'CANCELLED'` and only then removes the job. The queue
mutation is redundant bookkeeping, and it is racy today — a job already picked up by a worker sends
regardless of what the DB says.

**Design:**
- **Immediate sends** (no `scheduledAt`) → enqueue directly, as today.
- **Scheduled sends** → write the DB row and nothing else. The campaign-scheduler Durable Object
  from §4.2 sweeps `WHERE latestStatus = 'SCHEDULED' AND scheduledAt <= now()` on each alarm tick
  and enqueues what is due. This is the pattern `campaign-scheduler-job.ts:34` already uses for
  campaigns — extend it to cover emails rather than inventing a second mechanism.

Reschedule and cancel become **pure DB writes**. `EmailQueueService.changeDelay` and
`chancelEmail` are deleted, along with the `jobId: emailId` coupling that exists only to support them.

**Pair it with a claim-UPDATE**, which is required for §4.4 regardless:

```sql
UPDATE "Email" SET "latestStatus" = 'QUEUED'
WHERE id = $1 AND "latestStatus" = 'SCHEDULED'
RETURNING id
```

Zero rows returned means already-claimed or cancelled: ack the message and drop it. One atomic
statement covers duplicate delivery, cancellation, and any stale message left by a reschedule.

**Trade-off:** up to one alarm tick (~1.5s) of scheduling jitter, on an email scheduled hours out.
In exchange the current race disappears.

**Rejected:** a Durable Object per scheduled email would give an exact `changeDelay` equivalent
(`setAlarm()` moves freely and can be cleared), but that is one billed object per scheduled email to
replicate what a `WHERE` clause already does. Keep DOs for webhook ordering and for the >12h delay
case in §2, where they are load-bearing.

## 5. Database: Neon + Hyperdrive + Drizzle

**Driver choice is settled by existing code.** There are 6 interactive transactions
(`auth.ts:211`, `campaign-service.ts:712`, `:774`, `webhook-service.ts:605`,
`create-contact-book.ts:57`, plus an array form at `webhook-service.ts:567`) and 8 raw-SQL sites
(`admin.ts:438`, `email.ts:97`, `:139`, `dashboard-service.ts:28`, `usage-service.ts:38`, `:48`,
`ses-hook-parser.ts:117`).

Interactive transactions rule out `drizzle-orm/neon-http`. Use:
- **Hyperdrive + `postgres-js`** (recommended) — real transactions, session affinity, edge pooling.
  Disable Hyperdrive query caching; this workload is write-heavy and read-your-writes matters.
- Fallback: `@neondatabase/serverless` WebSocket driver + `drizzle-orm/neon-serverless`.

`auth.ts:215` runs `pg_advisory_xact_lock` inside a transaction. Transaction-scoped advisory locks are
pool-safe, so this survives Hyperdrive unchanged — but it must stay `_xact_` scoped. A session-scoped
advisory lock would break under pooling.

**Scope:** 24 models, ~265 Prisma call sites. Use `drizzle-kit pull` to introspect the live database
rather than hand-porting `schema.prisma`. Migration history does not transfer — baseline Drizzle at
current state and keep the Prisma migration folder read-only for reference.

## 6. Auth: NextAuth v4 → better-auth

37 call sites. NextAuth v4 survives neither the framework change nor the ORM change, so this is its
own ticket, not a sub-task.

- Providers in use: GitHub, Google, and `EmailProvider` (magic link) — `auth.ts:8-11`.
- Requires a **data migration** across `User`, `Account`, `Session`, `VerificationToken`. Get the
  session table shape right or every user is logged out at cutover.
- OAuth callback URLs must be re-registered with GitHub and Google.
- `sendSignUpEmail` (`server/mailer.ts`) must be wired to better-auth's email hooks.
- Self-hosted registration gating (`canRegisterSelfHostedUser`, `SelfHostedRegistrationError`) is
  custom logic in a NextAuth `signIn` callback — it needs a deliberate port to a better-auth hook,
  including the advisory lock.
- **Scope is user / session / account / verification only.** Team, TeamUser and TeamInvite stay
  exactly as they are.

  better-auth's `organization` plugin was evaluated and **rejected**: it expects string IDs, while
  `Team.id` and `User.id` are `Int @default(autoincrement())` with `teamId` as a foreign key in 37
  places in the schema and `teamId: number` threaded through every service signature and
  `TeamJob<T>`. Adopting it would force an Int→String PK migration across nearly every table to
  re-implement invitations, roles and membership that already work (`routers/invitiation.ts`,
  `TeamInvite`, the `Role` enum). Not worth it.

  Consequence: **Int primary keys are preserved end to end.** Do not let the Drizzle port (Phase 3)
  quietly change ID types.

## 7. What does not move

- **`apps/smtp-server`** — a raw TCP SMTP listener on :465/:587 with a TLS cert. Workers cannot listen
  on arbitrary TCP ports. It talks to useSend only over the public HTTP API
  (`apps/smtp-server/src/server.ts:20-35`), so it is fully decoupled and needs **no changes**.
  Leave it where it is; move to Fly.io at leisure. It is a product feature (documented at
  `apps/docs/get-started/smtp.mdx`, surfaced at `dev-settings/smtp/page.tsx:15`), not infrastructure.
- **The public API.** `server/public-api/hono.ts` is already Hono and runs natively on Workers.
  Rehost it; do not rewrite it. This is the single biggest free win in the migration.
- **AWS SES.** Delivery, identity management, configuration sets, SES tenants, suppression lists all
  stay. A Cloudflare Email Service adapter is a large future ticket — it must replace all of
  `aws/ses.ts` and the domain lifecycle in `domain-service.ts`, not just a send call.
- **R2 is nearly free.** `storage-service.ts` already takes an S3-compatible endpoint with
  `forcePathStyle` for MinIO. **Decided: native R2 binding**, not presigned URLs — drop
  `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` and proxy uploads/downloads through a
  Worker route. Removes request-signing overhead and two SDK dependencies from the bundle.

## 8. Runtime compatibility gotchas

| Item | Location | Action |
|---|---|---|
| **pino** | `server/logger/log.ts` | Worker threads / transports don't run on Workers. `AsyncLocalStorage` is fine under `nodejs_compat`. Keep the `logger` Proxy and `withLogger` API identical; swap only the implementation. Contained — do it early. |
| **Stripe SDK** | `billing/payments.ts:14`, `billing/usage.ts:8` | Needs `Stripe.createFetchHttpClient()`. Webhook verification must become `constructEventAsync` + `createSubtleCryptoProvider()`. Silently broken if missed. |
| **`generateKeyPairSync`** | `aws/ses.ts:17` | BYODKIM keypair generation. Verify under `nodejs_compat`; may need WebCrypto `generateKey`. |
| **`scryptSync`** | `server/crypto.ts:1` | Sync and CPU-heavy — exactly what the Workers CPU budget punishes. Benchmarked: **18.7ms per call**, on every public-API request, 97% of a transactional send's CPU (§12). Supported under `nodejs_compat`, so it runs — but cache the verification or move to a keyed HMAC. |
| Other `node:crypto` | 9 more files | `randomBytes`, `createHash`, `createHmac`, `randomUUID`, `timingSafeEqual` — expected to work under `nodejs_compat`. |
| **`jsx-email`** | email preview rendering | Verify SSR on Workers. |
| **`@isaacs/ttlcache`** | in-process cache | Isolates are ephemeral and per-colo; hit rates drop sharply. Move to KV or a DO rather than assuming in-memory carries load. |
| **Attachment size** | email attachments | Check against Workers request body limits. |
| **SNS signature verification** | `ses-hook-parser.ts` | Must work via WebCrypto. |

### Verified on `workerd`, not from documentation (Phase 5)

`apps/web/src/worker/compat-check.ts` runs this list inside a real isolate —
`pnpm --filter=web compat:check`, then `curl localhost:8790`. Under
`wrangler dev`, workerd 1.20260916.1, `nodejs_compat`, `compatibility_date`
2026-01-01. Local `workerd`, not Cloudflare hardware.

| Item | Result |
|---|---|
| `scryptSync` | **Runs**, and byte-identical to Node at the same defaults. That parity is load-bearing: `crypto.ts` passes no options, so a different default `N` would silently invalidate every API key hash already stored. ~14ms median against the 18.7ms PR #47 measured under Node on the same machine — Workers does not make #48 worse. |
| `generateKeyPairSync` | **Runs.** rsa-1024, spki/pkcs8 PEM, ~7ms. No WebCrypto rewrite needed. |
| **nodemailer MIME build** | **Runs.** The stream transport in `sendRawEmail` produces a 367 KB RFC 5322 message including a 256 KB base64 attachment, headers from `buildHeaders` intact. The largest open risk on this list, and it is closed — no rewrite. |
| `Stripe.createFetchHttpClient()` | **Runs.** `constructEventAsync` + `createSubtleCryptoProvider()` verifies a real signature and rejects a forged one. |
| `stripe.webhooks.constructEvent` | **Does not run.** The synchronous call at `app/api/webhook/stripe/route.ts:45` throws "SubtleCryptoProvider cannot be used in a synchronous context". Better than §8 feared — it fails loudly, not open — but the route must move to `constructEventAsync` before it runs on Workers. |
| `process.env` | **Populated** from `vars`, secrets and `.dev.vars` at module scope, so `src/env.js` validates inside a Worker unchanged. A missing variable fails the isolate at startup rather than at request time. |
| Bundling | Nothing in the dependency tree failed to resolve or bundle — Prisma, ioredis, BullMQ, nodemailer, Stripe and the AWS SDKs all built. |

**What actually breaks is where I/O happens, not which APIs exist.**

1. **Global scope.** Workers reject sockets, timers and `randomUUID()` during
   module evaluation. `postgres-js` connects when its client is constructed and
   BullMQ's queue constructor does both, and services hold those in module-level
   `const`s and `static` fields — so importing `campaign-service.ts` killed the
   isolate at load. Build clients on first use.
2. **Across requests.** Workers ties every I/O object to the request that created
   it. A cached connection serves exactly one request and then fails every one
   after it with "Cannot perform I/O on behalf of a different request", surfacing
   as an intermittent 500 from whatever middleware queried first. **Build the
   database client per request** and let Hyperdrive pool. This is the single
   least obvious thing on this page.
3. **BullMQ cannot run in a Worker at all**, not for lack of `node:net` but
   because a consumer holds a blocking Redis connection open for the life of the
   process. `server/queue/index.ts` picks a driver by runtime.

**Free plan is not an option.** Workers Free caps CPU at 10ms per request, and
one `scryptSync` in the auth middleware is ~14ms. Workers Paid defaults to 30s.

### Attachment size, measured

| Limit | Value | Binding? |
|---|---|---|
| Workers request body | 100 MB Free/Pro, 200 MB Business | No |
| **SES v2 message, after base64** | **40 MB, not adjustable** | **Yes** |
| Queue message | 128 KB | No — attachments are stored on the `Email` row, not in the message |
| What the API enforces | `email-schema.ts:32` caps the attachment *count* at 10. **Nothing caps size.** | — |

A 40 MB request body is accepted and read in full under `wrangler dev`. So the
ceiling is SES's, not Cloudflare's: ~40 MB of base64, ~30 MB of file bytes. Worth
enforcing in the schema rather than discovering it as an SES rejection — and note
`sendRawEmail` buffers the whole message with `Buffer.concat`, so a 40 MB send
holds several copies inside a 128 MB isolate.

## 9. Sequencing

**Do not run the three migrations concurrently.** ORM, framework, and infra are each independently
large; done together there is no working intermediate state and no way to bisect a regression.

Phases 0–3 land on the **current Next.js app, in production, incrementally**. Nothing below Phase 4
requires a Cloudflare account.

- **Phase 0 — Shrink the event pipeline.** Pure cost work, independent of everything else, and it
  reduces the load every later phase has to carry. See §12.
  - Prune SES event types (`aws/ses.ts`, `ses-hook-parser.ts:600-616`) — highest leverage change
    available, and it is config.
  - `EmailEvent` retention policy, extending the `cleanup-email-bodies` pattern.
  *Ships on Next.js.*
- **Phase 1 — Logger.** pino → Workers-compatible structured logger behind the existing API.
  Small, contained, unblocks everything. *Ships on Next.js.*
- **Phase 2 — Queue seam.** A `Queue` interface (`enqueue`, `enqueueDelayed`, `schedule`) with BullMQ
  as the only driver. Route all call sites through it. *Ships on Next.js, no behaviour change.*
  Worth doing even if the migration stalls.
- **Phase 3 — Prisma → Drizzle.** `drizzle-kit pull` to introspect, then port ~265 call sites and the
  8 raw-SQL sites. *Ships on Next.js.* The single largest ticket — split it per router/service.
- **Phase 4 — Neon.** Data migration off the current Postgres. Still on Next.js, still on Node.
- **Phase 5 — Cloudflare foundation.** `wrangler.toml`, Hyperdrive binding, R2 bucket, KV namespace.
  Deploy the **Hono public API** to Workers first — it is already compatible and proves the stack
  end-to-end with the smallest blast radius.
  - **Instrument CPU-ms per send and per event here.** It is the one number in §12 that is estimated
    rather than measured, and this phase is the cheapest place to measure it.
  - **Prototype Durable Object hibernation** under a 1.5s alarm before committing to the scheduler
    design. A 30x cost swing rides on it (§12).
- **Phase 6 — better-auth.** Auth swap plus session/account data migration. Sequence before the
  framework rip, since TanStack Start has no NextAuth story.
- **Phase 7 — TanStack Start.** Rip Next.js: 126 files under `src/app`. **All 17 tRPC routers are
  retired** in favour of TanStack Start server functions; `@trpc/*` leaves the dependency tree.
  The Hono public API (`server/public-api/`) is untouched and remains the external contract.
- **Phase 8 — Jobs to Queues + DOs**, easiest first:
  `domain-verification` → `webhook-cleanup` → `usage-reporting` → `cleanup-email-bodies`
  (pure cron) → `ses-webhook` → `webhook-dispatch` (DO, deletes the lock) → `contact-bulk-add`
  → `campaign-*` → `campaign-scheduler` (DO alarm) → email send queues last.
  - The `ses-webhook` cutover must **batch**: `sendBatch` from the SNS route, and one multi-row
    INSERT per consumer batch rather than 100 round trips (§12).
- **Phase 9 — Redis's other four jobs.** Idempotency + rate limits → DO; cache + dedup → KV.
- **Phase 10 — Delete.** Drop `bullmq`, `ioredis`, `server/redis.ts`, `REDIS_URL` / `REDIS_KEY_PREFIX`
  from `env.js` and `turbo.json`. Delete `docker/prod/compose.yml`.

## 10. Test impact

Integration tests require real Redis today (`AGENTS.md:37`, `docker/testing/compose.yml`,
`test/setup/setup-env.ts`). Target: `@cloudflare/vitest-pool-workers` / Miniflare for Queues, DOs,
KV and R2, against Neon branches for Postgres.

Affected: `hono.integration.test.ts`, `idempotency-service.integration.test.ts`,
`api-service.integration.test.ts`, `trpc.integration.test.ts`, `helpers.ts` (uses `$queryRaw` +
`$executeRawUnsafe` for table truncation — needs a Drizzle port), plus the mocked unit tests for
webhook, campaign and domain services.

## 11. Decisions (settled 2026-09-17)

1. **`max_concurrency` is deploy-time only.** Changing `sesEmailRateLimit` in the UI no longer takes
   effect until a deploy. The settings UI (`ses-settings-service.ts:193`) needs copy saying so, and
   `updateSesSetting` should stop implying an immediate effect.
2. **No `organization` plugin.** better-auth covers user / session / account / verification only;
   Team, TeamUser and TeamInvite stay as-is. Int primary keys are preserved throughout — see §6.
3. **TanStack Start server functions** for the dashboard. All 17 tRPC routers are retired; the Hono
   public API (`server/public-api/`) is untouched and stays the external contract.
4. **Native R2 binding**, not presigned URLs. `storage-service.ts` drops `@aws-sdk/client-s3` and
   `@aws-sdk/s3-request-presigner`; uploads/downloads proxy through a Worker route.
5. **Scheduled emails move to a sweeper** — see §4.5. `changeDelay` and `chancelEmail` are deleted.
6. **Logs are OpenTelemetry records on stdout; the export path is Workers Logs.** `server/logger/log.ts`
   emits the OTel Logs Data Model (`severity_text` / `severity_number`, `body`, `attributes`,
   `resource`, `trace_id`) as one JSON object per line, and `observability.enabled` in
   `wrangler.jsonc` is what ships them. **No OTLP exporter in the request path** — a Worker that
   POSTs to a collector pays a subrequest per log line, against a 1000-subrequest cap, on the same
   path that is already spending them on SES and Neon. OTLP, if it is ever wanted, goes in a tail
   worker reading exactly these records. W3C `traceparent` is propagated by the queue seam
   (`server/queue/index.ts`), so an API request, the message it enqueues and the consumer that runs
   it share one `trace_id` — no tracer SDK, and nothing to rip out when #7 adds one.

## 12. Cost model

Verified against Cloudflare and Neon pricing, September 2026.

### The multiplier

`ses-hook-parser.ts:600-616` handles nine SES event types. A typical marketing email fires
**Send + Delivery + Open + Click ≈ 3.5 events**. Each is an SNS POST → Worker request → queue
message → consumer invocation → one `EmailEvent` insert + one `Email` update.

Per email sent: **~4.5 Worker requests, ~13.5 queue operations**. Only one of each is the actual
send. **The event pipeline is ~78% of infrastructure load.**

### Where the free tiers run out

| Resource | Included (Workers Paid) | Per email | Free until | Cost after |
|---|---|---|---|---|
| Queue operations | 1M/mo | ~13.5 | **~75K emails/mo** | ~$5.40 / 1M emails |
| Worker requests | 10M/mo | ~4.5 | **~2.2M emails/mo** | ~$1.35 / 1M emails |
| Worker CPU | 30M CPU-ms | **~9ms campaign, ~19ms transactional** *(measured)* | **~1.6–3.3M emails/mo** | ~$0.18–0.38 / 1M emails |
| DO requests | 1M/mo | ~3 | ~330K emails/mo | ~$0.45 / 1M emails |

**At 10M emails/month the entire Cloudflare bill is roughly $80.** Queues is the first tier to go,
at ~75K emails — but at $0.40/million operations, crossing it costs pocket change. There is no
cliff anywhere on the Cloudflare side.

### CPU per send and per event — measured

The CPU row above used to read *~35ms, estimated*. It is now measured, by
`apps/web/src/bench/cpu-per-email.bench.ts` (`pnpm --filter=web bench:cpu`). Medians of 25–40
samples per case, `process.cpuUsage()` user+sys, Node 26 on an AMD Ryzen 9 9900X. Each payload
class is stated with the size of the HTML it actually produced.

| Step | Payload | CPU median | CPU p95 |
|---|---|---|---|
| `jsx-email` render — `OtpEmail`, the real sign-in template | 9.1 KB out | 1.64 ms | 3.13 ms |
| `EmailRenderer.render` — double opt-in default (repo fixture) | 4.3 KB out | 0.63 ms | 1.35 ms |
| `EmailRenderer.render` — 6-section newsletter | 42.3 KB out | 6.06 ms | 11.1 ms |
| `EmailRenderer.render` — 30-section newsletter | 199.4 KB out | 27.7 ms | 36.2 ms |
| `html-to-text` — transactional | 9.1 KB in | 0.42 ms | 1.15 ms |
| `html-to-text` — 6-section newsletter | 42.3 KB in | 0.89 ms | 1.87 ms |
| `html-to-text` — 30-section newsletter | 199.4 KB in | 2.43 ms | 3.59 ms |
| MIME build (`nodemailer` stream transport, `ses.ts:183`) | 42.3 KB body | 2.26 ms | 3.44 ms |
| MIME build + 256 KB attachment | 341.3 KB | 1.54 ms | 2.75 ms |
| **`scryptSync` — `verifySecureHash`, every public-API request** | — | **18.7 ms** | 19.2 ms |
| SES event: `JSON.parse` envelope + inner + status derivation | 2.4 KB | 0.004 ms | 0.007 ms |
| Webhook sign: `JSON.stringify` + HMAC-SHA256 | — | 0.002 ms | 0.005 ms |

Rolled up: **campaign email ~9.2 CPU-ms** (render + `html-to-text` + MIME), **transactional email
~19.2 CPU-ms** when each send is its own API request, **~0.7 CPU-ms** when sent through
`POST /emails/batch` (100 per request, so the `scryptSync` is amortised 100 ways). The whole event
pipeline is **0.021 CPU-ms per email** — 3.5 events at 0.006 ms each. It is 78% of the request and
queue load and 0.2% of the CPU.

Three things fall out of this:

1. **The 35ms estimate does not hold, and the error is not where §8 expected.** `jsx-email` and
   `html-to-text` were the named suspects; together they are ~7ms on a typical marketing email and
   ~1ms on a transactional one. Marginal CPU cost drops from ~$0.70 to **~$0.18 / 1M campaign
   emails**, and the free tier stretches from ~850K to ~3.3M emails/month. CPU was never going to
   be the binding constraint; queues still are, at ~75K.
2. **`scryptSync` is the whole transactional figure.** 18.7ms — twice the entire campaign send —
   and `getTeamAndApiKey` (`api-service.ts:78`) runs it on every request with nothing caching the
   result. It is Node's default cost (`N=16384, r=8, p=1, keylen=64`; `crypto.ts` passes no
   options, and an explicit-parameter run reproduces the same 17–19ms). It is also *synchronous*:
   18ms during which the isolate does nothing else. This is the one number worth acting on.
3. **Rendering bounds the campaign fan-out batch size.** At 6ms per recipient a single invocation
   fits ~5,000 renders inside the 30s CPU limit; at 28ms for a long newsletter, ~1,000. The
   self-continuation in §4.3 needs a page size well under that, and the subrequest cap (1000) bites
   first anyway.

**Caveats.** Measured under Node on x86 Linux, not on a `workerd` isolate on Cloudflare hardware —
the same V8, but different silicon, different build flags and a colder JIT, so treat these as an
order of magnitude rather than a bill. The benchmark loops hot, so nothing here captures cold-start
or JIT warm-up. It covers the named hot paths only: Hono routing, Zod validation, Drizzle query
construction and row serialisation are all unmeasured, so the per-email totals are a floor, not a
full accounting. `scryptSync` *is* available under `nodejs_compat` (all `node:crypto` is, bar
argon2, ed448/x448 and DSA/DH keypairs), so it will run — the open question is what it costs there.
Re-run on real Workers once #7's account access exists.

### The two things that actually bite

**1. Durable Object duration — bites on day one, not at scale.**

DO duration bills wall-clock time while running *or idle but unable to hibernate*: 400,000 GB-s
included, then $12.50/million GB-s.

The campaign-scheduler DO alarms every 1.5s forever (§4.2). If it stays resident it burns
~328,000 GB-s/month — **82% of the entire allowance at zero email volume**. If it hibernates
cleanly between alarms it is ~11,000 GB-s. A 30x swing decided by implementation detail.

This is a **fixed cost independent of volume**, which makes it the only thing here that can
surprise you while still small. Prototype it in Phase 5.

**2. Neon — the real cost center, at every scale.**

At 1M emails/month: ~8M row writes (1M `Email` inserts + 3.5M `EmailEvent` inserts + 3.5M `Email`
updates). Compute $0.106/CU-hour on Launch, $0.222 on Scale; storage $0.35/GB-month.

Realistically **$40–150/mo at 1M emails**, scaling with *burst concurrency* rather than steady
volume — campaign sends spike it. Storage compounds: ~3.5M `EmailEvent` rows/month, forever.

### Optimizations, by leverage

1. **Prune SES event types.** If `Send` does not drive product behaviour — the `Email` row already
   records it — dropping it removes ~25% of the entire event pipeline: requests, queue ops, CPU,
   row writes and storage. Config change. → Phase 0
2. **`EmailEvent` retention policy.** Otherwise storage growth is unbounded and monotonic. The
   existing `cleanup-email-bodies` job is the pattern to follow. → Phase 0
3. **Batch the event ingest path.** `sendBatch` from the SNS route; one multi-row INSERT per
   consumer batch. Cuts queue operations and Neon write load together. → Phase 8
4. **Cache API key verification.** `scryptSync` is 18.7ms of synchronous CPU on *every* public-API
   request and is 97% of a transactional send. Caching the verified `clientId → team` mapping, or
   moving to a keyed HMAC over a high-entropy token (these are generated secrets, not passwords —
   scrypt is protecting against an attack the threat model does not have), removes it. Note the
   cache has to be KV or a DO, not `@isaacs/ttlcache` (§8). → Phase 5
