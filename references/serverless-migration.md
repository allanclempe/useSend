# Cloudflare migration plan

Status: **in progress — Phases 0–3, 5, 8 and 9 landed; 7 under way; 4, 6 and 10 outstanding.**
Sections marked **Done** record what was actually built and where it differed from the plan; the
rest is still a plan. Nothing here has run on a Cloudflare account — every measurement is local
`workerd` under `wrangler dev`.

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
| API rate limits | Redis `INCR` | **Durable Object** (exact; the Rate Limiting binding is per-colo) |
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
| 3 | Idempotency keys | `idem:` / `idemlock:` (`idempotency-service.ts`) | **Durable Object** — `server/idempotency/`, **done** |
| 4 | API / auth / waitlist rate limits | `INCR` + `EXPIRE` (`hono.ts:69-86`) | **Durable Object**, one per bucket — `server/rate-limit/`, **done** |
| 5 | Team & usage cache, notification dedup | `withCache`, `limit:notify:` (`team-service.ts:398`) | **Workers KV** with TTL — `server/cache/`, **done** |

**Do not use KV for #3 or #4.** KV is eventually consistent (~60s global propagation). Idempotency
and rate limiting both need read-after-write. KV is correct for #5 only.

## 2. Queue-by-queue mapping

From `apps/web/src/server/queue/queue-constants.ts`:

| BullMQ queue | Target | Notes |
|---|---|---|
| `{region}-transactional` | CF Queue → consumer Worker | `max_concurrency` = `transactionalQuota` |
| `{region}-marketing` | CF Queue → consumer Worker | `max_concurrency` = `marketingQuota` |
| `webhook-dispatch` | **Durable Object per `webhookId`** | serialization is free; DO alarm drives retry backoff |
| ~~`campaign-emails-processing`~~ | — | **Does not exist.** `CAMPAIGN_MAIL_PROCESSING_QUEUE` is a constant nothing reads: no `createQueue`, no `createWorker`, no enqueue. Nothing to cut over. |
| `campaign-batch` | CF Queue | must self-chunk, §4.3 |
| `contact-bulk-add` | CF Queue | must self-chunk, §4.3 |
| `ses-webhook` | HTTP route → CF Queue | SNS already POSTs to `setting.callbackUrl`; keep the HTTP hop. **Done** — `server/service/ses-callback.ts`, served by both the Next route and the Worker so the one subscribed URL cannot drift. The consumer-side batched INSERT (§12, optimization 3) is **not** done. |
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
  and the lock-not-acquired retry path all **delete**. **Done.**
  `src/worker/webhook-dispatcher.ts`. Two consequences the plan did not call out:
  - **Retry is an alarm, not a redelivery.** A queue would put a failed message back at an
    arbitrary position relative to the messages behind it, which is the ordering the lock existed
    to protect. The DO keeps the failed call at the head and re-arms.
  - **That means head-of-line blocking**, which the Redis lock did *not* have: a dead endpoint now
    stalls its own webhook's backlog for the full retry ladder (~2.5 minutes over 6 attempts)
    instead of letting later events past. Bounded by auto-disable at 30 consecutive failures, and
    per-webhook — one bad endpoint cannot affect another, because it is a different object.
  - **Under Node the lock is replaced by concurrency 1**, not by a port. Stronger than the lock
    (global serialisation) and slower. Node is being deleted; keeping the lock alive for it is not
    worth it.
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

**Done.** `server/queue/ses-regions.ts`, thirteen regions, twenty-six send queues, derived into
`queue-registry.ts` and declared in `wrangler.jsonc`. **The contents of that list are a product
decision that has not been made** — what is there is AWS's commercial SES regions minus the opt-in
ones, which is a defensible default and not an answer about where anyone sends from. Sending from a
region outside it now fails at the seam with a message naming the file and the supported set.

The registration also had to move. On BullMQ the set of send queues came from `SesSetting` rows, so
`init()` read the database to learn which queues to create. A Queues consumer has to be registered
before the first message arrives, which is earlier than the first send, so on Workers the pair for
every supported region is registered at module load and `init()` reads nothing.

`max_concurrency` is also deploy-time, while `sesEmailRateLimit` is a DB column editable in the UI.
**Decided: deploy-time only.** Changing the rate limit in the UI no longer takes effect until a
deploy. `updateSesSetting` (`ses-settings-service.ts:193`) must stop implying an immediate effect,
and the settings UI needs copy saying so.

### 4.2 The campaign scheduler ticks every 1.5s

`campaign-scheduler-job.ts:12` — `SCHEDULER_TICK_MS = 1500`. Cron Triggers floor at 1 minute, so
this one job must be a **Durable Object with a self-rescheduling alarm**, not a Cron Trigger.

**Measured: keep the alarm, drop the 1.5s.** A Durable Object is only removed from memory after
10s of inactivity, so one that re-arms every 1.5s never leaves it — the constructor runs once and
the object sits resident for as long as the tick keeps running. Whether that resident time is
*billed* hangs on a distinction in Cloudflare's pricing wording that cannot be settled without an
account, and the two readings are 30x apart (§12). **A 30s tick makes the question moot**: at any
interval past 10s the object is evicted between every alarm, measured. The cost is up to 30s of
scheduling jitter, which is invisible against `batchWindowMinutes` (minutes) and scheduled sends
(minute precision) — and §4.5 already accepts one tick of jitter on the same path.

**Done.** `src/worker/campaign-scheduler.ts`. Confirmed against the real scheduler under `wrangler
dev`, not just the prototype: five consecutive 30s ticks each ran on a **fresh instance**
(`alarmsHandledByThisInstance: 1`, five distinct `instanceId`s), so the object is evicted between
every alarm with a real queue `send()` inside it. Sending to a queue binding does not pin the object
the way a held socket does.

Two things the plan did not anticipate:

- **Something has to arm the first alarm.** A Worker has no startup hook, and an alarm chain that
  fails permanently stops with nothing to say so. There is now a `*/10 * * * *` Cron Trigger whose
  only job is to call `ensureRunning()` on the object, which arms the alarm if none is set.
- **Which makes the Durable Object's margin thin.** With the tick at 30s, the DO buys **30 seconds
  of latency over what that keepalive cron could do on its own** — and the design needs the cron
  regardless. The alarm is still the right call while the tick is sub-minute, but if the tick ever
  moves to 60s the object stops earning its place and the cron should simply do the sweep.

Two constraints on the DO follow, and neither is optional:

- **It must not hold a Postgres connection.** A held-open outbound socket makes a Durable Object
  ineligible for hibernation, so it is billed wall-clock however coarse the tick. Measured: the
  same object that was evicted between every 15s alarm stayed resident across all of them with one
  socket open. A pooled Neon/Hyperdrive connection in the scheduler DO is exactly this. Have the
  alarm enqueue and let a Queues consumer touch the database, or query over HTTP.
- **Nothing may be left pending across a tick** — no `setTimeout`, no `setInterval`, no unawaited
  in-flight `fetch()`. Each was measured to pin the object on its own.

### 4.3 Workers CPU and subrequest limits vs unbounded loops

Three handlers were named as iterating unbounded result sets in a single job. Two of them do; the
third turned out not to. Each real one must **fan out or self-continue**: process a bounded page,
enqueue a continuation with a cursor. Two separate ceilings apply — CPU time *and* the
per-invocation **subrequest limit** (1000 on paid).

- **`runDueDomainVerifications()`** — iterated **every** domain sequentially, with AWS calls per
  domain, so it hits the subrequest cap well before CPU. **Done**: 25 domains per invocation,
  keyset-paged on `Domain.id` (unique, so a page boundary cannot repeat or skip a row — the old
  `createdAt asc` ordering was not). The hourly Cron Trigger runs page one and the handler enqueues
  its own continuations, which makes `domain-verification` both a cron name and a queue —
  `CRON_CONTINUED_QUEUES`.
- **`campaign-batch`** — already paged on `lastCursor`, but at `batchSize` per invocation, default
  **500**, which is past the subrequest cap and deep into the CPU budget at 5.7ms a render.
  **Done**, and the subtlety is that `batchSize` is not a page size: it is the user's pacing unit,
  "send 500, then wait `batchWindowMinutes`". So the *window* keeps the user's number and the
  *invocation* is capped at 100, with what is left carried on a continuation message. `lastSentAt`
  — which is what gates the next window — is written only when the window is fully spent. Writing
  it per invocation would quietly turn a 500-per-hour campaign into a 100-per-hour one.
- **`contact-bulk-add`** — **not actually unbounded, and not on a Worker path at all.** The
  consumer takes one contact per message at a batch of 25. The public API producer is capped at
  1000 contacts per request (`bulk-add-contacts.ts`) and the driver already splits a bulk enqueue
  into `sendBatch` calls of 100, so it costs 10 subrequests. The one path that could hurt is the
  **tRPC** `contacts.addContacts`, capped at **50,000** — 500 `sendBatch` calls, half the
  subrequest budget — and tRPC runs on Node today and is retired entirely in Phase 7 (§11,
  decision 3). **That cap needs revisiting when the route becomes a server function**, not now.

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

**Trade-off:** up to one alarm tick (30s, §4.2) of scheduling jitter, on an email scheduled hours
out. In exchange the current race disappears.

**Done**, with two corrections the plan as written needed. Both were found by running it.

- **The claim as specified loses emails.** `SCHEDULED → QUEUED` is one-way, so a handler that
  throws *after* claiming and *before* reaching a terminal status leaves the row in QUEUED, where
  the redelivery cannot claim it: never sent, never FAILED, nothing to say so. It reproduced on the
  first local run, when `getConfigurationSetName` threw for an unconfigured region. The handler now
  **releases the claim** (`QUEUED → SCHEDULED`, only if still QUEUED) before rethrowing, so the
  redelivery can take it.
- **Releasing it forever is a loop.** A row back in SCHEDULED and still due is re-enqueued by the
  next sweep, every 30 seconds, for as long as the failure lasts. So on its *last* attempt the
  handler marks the email FAILED terminally instead of releasing, which ends the loop and still
  lets the message reach the dead letter queue on the way out.

One more consequence: with `SCHEDULED` as the only pre-send state, `sendEmail` writes it for
**immediate** sends too, and `QUEUED` now means "a consumer has claimed this". An immediate send is
therefore briefly `SCHEDULED` with a null `scheduledAt` — and, less obviously, becomes cancellable
in that window, which it was not before.

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
  **Done in Phase 5.** An R2 binding has no URL to presign, so `getDocumentUploadUrl` now issues a
  short-lived HMAC-signed URL pointing at `/storage/*` on the Worker, which is what the presigned
  URL was doing. The route sits outside the Hono app deliberately — it is a dashboard concern, not
  part of the API contract. Storage became a Worker capability: under Node there is no binding,
  `isStorageConfigured()` is false, and both editors already hide the file picker on
  `imageUploadSupported: false`. `S3_COMPATIBLE_*` is gone from `env.js` and `turbo.json`.

## 8. Runtime compatibility gotchas

| Item | Location | Action |
|---|---|---|
| **pino** | `server/logger/log.ts` | Worker threads / transports don't run on Workers. `AsyncLocalStorage` is fine under `nodejs_compat`. Keep the `logger` Proxy and `withLogger` API identical; swap only the implementation. Contained — do it early. |
| **Stripe SDK** | `billing/payments.ts:14`, `billing/usage.ts:8` | Needs `Stripe.createFetchHttpClient()`. Webhook verification must become `constructEventAsync` + `createSubtleCryptoProvider()`. Silently broken if missed. |
| **`generateKeyPairSync`** | `aws/ses.ts:17` | BYODKIM keypair generation. Verify under `nodejs_compat`; may need WebCrypto `generateKey`. |
| **`scryptSync`** | ~~`server/crypto.ts:1`~~ | **Resolved — #48.** Was sync and CPU-heavy, exactly what the Workers CPU budget punishes: **18.7ms per call** on every public-API request, 97% of a transactional send's CPU. `crypto.ts` now uses a keyed HMAC-SHA256 with `timingSafeEqual` at **0.004ms**, and `scryptSync` is on no request path at all (§12). |
| Other `node:crypto` | 9 more files | `randomBytes`, `createHash`, `createHmac`, `randomUUID`, `timingSafeEqual` — expected to work under `nodejs_compat`. Since #48 the last two are **load-bearing, not incidental**: they are the API key check on every public-API request. |
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
| `scryptSync` | **Runs**, and byte-identical to Node at the same defaults — ~14ms median against the 18.7ms PR #47 measured under Node on the same machine. Workers did not make #48 worse; it made it decisive, 14ms against a 10ms Free-tier budget. **#48 has since taken `scryptSync` off the request path** (§12), so the byte-parity finding no longer guards anything — no stored hash is a scrypt hash any more. The `createHmac` that replaced it runs in this same isolate: the Stripe row below builds its signature with one. |
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

**Free plan: no longer blocked at the door, still not the plan.** This read *not
an option*, because Workers Free caps CPU at 10ms per request and one
`scryptSync` in the auth middleware was ~14ms — authentication alone overran the
whole request budget, before any work happened. **#48 removed that floor**: the
HMAC is 0.004ms and an entire transactional send is **0.47 CPU-ms**, under 5% of
the Free ceiling. What rules Free out now is campaigns, not auth — one 6-section
newsletter send is 8.6 CPU-ms against that same 10ms cap, and a 30-section one
is 36ms, over it outright for a *single* recipient. Queues and Durable Objects are
both available on Free, so the practical ceiling is volume rather than
capability: 10,000 queue operations/day at §12's 13.5 per email is ~740
emails/day. Free is a viable hobby tier for transactional sending and cannot run
campaigns at all. Workers Paid defaults to 30s.

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
  - **Durable Object hibernation is measured** — `prototypes/do-hibernation`, results in §12. At a
    1.5s alarm the object never leaves memory; the scheduler ticks at 30s instead (§4.2). What is
    left to confirm on a real account is the billing, not the behaviour.
- **Phase 6 — better-auth.** Auth swap plus session/account data migration. Sequence before the
  framework rip, since TanStack Start has no NextAuth story.
- **Phase 7 — TanStack Start.** Rip Next.js: 126 files under `src/app`. **All 17 tRPC routers are
  retired** in favour of TanStack Start server functions; `@trpc/*` leaves the dependency tree.
  The Hono public API (`server/public-api/`) is untouched and remains the external contract.

  **Done.** It shipped as a stack of small PRs that left Next.js serving `src/app` until the
  last one, so no intermediate state had neither framework working. The teardown is the three
  PRs at the end of the stack: `src/app`, then `src/trpc` + `src/server/api`, then `next`
  itself. `NotPortedYet` is gone, `next` and `@trpc/*` are out of `apps/web/package.json`, and
  `pnpm --filter=web dev` is `vite dev`.

  **Four things the teardown found that nothing typechecked.** Worth reading before the next
  bulk deletion, because none of them failed a build:

  1. **`app/globals.css` was the Tailwind entry**, imported by `src/styles.css`. Deleting the
     directory would have taken every `@source` glob and the theme import with it, silently.
     It now lives in `src/styles.css`.
  2. **`team-service.ts` imported `TRPCError`** — a service, not a router, so it survived every
     grep for `~/trpc` and `~/server/api`. It throws `AppError` now.
  3. **A plain export on a `server/functions` module reaches the browser.** Start strips
     `createServerFn` handler bodies from the client build; it does not strip an ordinary
     exported function beside them. Exporting two helpers from `functions/campaign.ts` pulled
     Drizzle and the `postgres` driver into the client bundle, which died on `Buffer is not
     defined` — so React never hydrated and every form fell back to a native submit. Helpers
     worth testing go on a service. **This is the one to remember:** it is invisible to `tsc`
     and to every test, and only shows up when a page is actually loaded in a browser.
  4. **Duplicate `vite` instances are order-sensitive.** `lightningcss` is an optional peer of
     `vite`, so two resolutions of it produce two nominally distinct copies of vite's `Plugin`
     type. The vitest configs mix them, and which copy `tsc` anchors on depends on the order
     files enter the program — so deleting enough files turned a latent mismatch into six
     errors in untouched files. `lightningcss` is pinned in `pnpm-workspace.yaml`.

  What the plan did not anticipate, and what made it smaller than 126 files suggests:

  - **There is no server-component data flow to port.** The dashboard is already a
    client-rendered SPA — `app/(dashboard)/layout.tsx` is `force-static`, the gate is
    better-auth's client `useSession()` in `providers/auth.tsx`, and nothing in the app imports
    `~/trpc/server`. The page files move across with their imports swapped.
  - **`next/*` appears outside `src/app` in six files.** `next/link`, `next/image`,
    `next/navigation` in four components, and `next/headers` in `server/auth.ts` and
    `trpc/server.ts`.
  - The real volume is **124 `use{Query,Mutation}` call sites across 78 files** plus **49
    `api.useUtils()`** invalidations, which is what the per-area `queryOptions` factories exist
    to absorb.

  **The dev server is the proof.** `@cloudflare/vite-plugin` runs the server half of the app in
  a real `workerd` isolate with every binding from `wrangler.jsonc`, so `vite dev` is the same
  runtime `wrangler dev` gave the API and there is no separate step. Plain `wrangler dev` can no
  longer build `src/server.ts`, because the Start handler is assembled from virtual modules only
  the Vite plugin provides.

  **One Worker, one entry.** `src/server.ts` is both `main` in `wrangler.jsonc` and Start's
  `server.entry`: it holds the `fetch`/`queue`/`scheduled` exports and the four Durable Object
  classes, and delegates routing to `src/worker/routing.ts` —` /storage/*`, the SES callback,
  `/api/v1/*` to Hono, then Start. The Hono mount narrowed from `/api` to `/api/v1`, which is
  the only behaviour change to it: it used to answer a JSON 404 for any unmatched `/api/…`, and
  that space now belongs to the route handlers that were Next.js files.
- **Phase 8 — Jobs to Queues + DOs**, easiest first:
  `domain-verification` → `webhook-cleanup` → `usage-reporting` → `cleanup-email-bodies`
  (pure cron) → `ses-webhook` → `webhook-dispatch` (DO, deletes the lock) → `contact-bulk-add`
  → `campaign-*` → `campaign-scheduler` (DO alarm) → email send queues last.

  **Largely done.** Every queue is cut over, both Durable Objects exist, the Redis lock is deleted
  and the whole of it has been exercised in a real `workerd` isolate under `wrangler dev` with no
  Cloudflare account. What the seam looks like now:

  | Piece | Where it lives |
  |---|---|
  | Queue producers and the `queue()` consumer | `server/queue/workers-driver.ts`, `src/worker/queue-consumer.ts` |
  | Which queues exist, and their batch/retry settings | `server/queue/queue-registry.ts`, checked against `wrangler.jsonc` by a unit test |
  | Which crons exist | `server/queue/cron-registry.ts`, same check |
  | Webhook ordering | `src/worker/webhook-dispatcher.ts` (DO per `webhookId`) |
  | The scheduler tick | `src/worker/campaign-scheduler.ts` (DO alarm, 30s) |
  | Scheduled emails | `server/service/scheduled-email-sweeper.ts` + the claim in `email-queue-service.ts` |
  | Supported SES regions | `server/queue/ses-regions.ts` |

  **Left over, in the order they matter:**

  1. **The batched `EmailEvent` INSERT** (§12, optimization 3). The consumer still writes one row
     per message. This is the largest remaining cost lever in the whole migration — 78% of queue
     and request load — and it means restructuring `parseSesHook`, which carries engagement dedup,
     campaign analytics and webhook emission per event. Note that **`sendBatch` from the SNS route
     is not possible**: SNS HTTP/S delivery posts exactly one notification per request, so the
     producer has exactly one message to send. The win is entirely consumer-side.
  2. **`SUPPORTED_SES_REGIONS` needs a product decision.** Thirteen regions are pre-declared; the
     list is a default, not an answer.
  3. ~~**Domain verification is blocked on Phase 9**~~ — cleared by Phase 9's cache seam, below.
  4. **Idempotency for the remaining consumers.** The send path has its claim-UPDATE (§4.5) and
     webhook delivery is serialised by its Durable Object, but `contact-bulk-add` and
     `campaign-batch` are at-least-once with no guard beyond the natural idempotence of an upsert
     and a `campaignEmail` existence check.
  5. **DLQ alerting.** The dead letter queue is declared and consumed, and every dead message is
     logged at error severity with its source queue — which is §11's alerting path. Nobody has
     written the alert.
- **Phase 9 — Redis's other four jobs.** Idempotency + rate limits → DO; cache + dedup → KV.
  **Done**, and **the domain verification blocker is cleared**. Nothing outside
  `server/queue/bullmq-driver.ts` imports `server/redis` any more; what is left of it is three
  drivers (`server/cache`, `server/rate-limit`, `server/idempotency`) and the integration test
  helper, all of which Phase 10 deletes.

  `getDomainVerificationState` used to read three Redis keys per domain, through the module-level
  `let` in `server/redis.ts` — which on Workers serves exactly one invocation and then hangs, so
  the hourly cron's first page ran and both its continuation and the next cron stalled. It is now
  a single Workers KV value per domain behind `server/cache`, which also cuts the sweep from six
  binding calls per domain to two against the 1000-subrequest cap.

  The seam is `server/cache/` — `CacheStore` with a KV driver and a Redis driver, picked by
  `isWorkersRuntime()` exactly the way the queue seam picks BullMQ or Queues. `withCache` moved
  there from `server/redis.ts` unchanged. Two KV properties the callers have to live with, and do:
  **no TTL below 60 seconds**, and **no conditional write** — so `CacheStore.add` is exact on Redis
  and best-effort on KV, which is only ever used for notification cooldowns.

  **Rate limits are a Durable Object per bucket** (`server/rate-limit/`), and the plan's "**Rate
  Limiting binding**, or a DO" is settled as the DO. The Rate Limiting binding is per-colo and
  approximate; `Team.apiRateLimit` defaults to **two requests per second**, so a customer spread
  over ten colos would be granted twenty — an over-grant of the same order as the limit itself. It
  also reports no count, no remaining and no reset, and the API returns all three as headers. What
  the DO costs instead is latency: an object lives in one place, and a caller far from it pays the
  round trip on every request. Verified exact in a real isolate — twenty concurrent calls on one
  bucket return the counts 1..20 with no duplicate, and exactly `limit` of them come back allowed
  (`pnpm --filter=web bindings:check`).

  There is deliberately **no alarm on the rate limit object**, so an abandoned bucket leaves one
  small row behind forever. Reclaiming it would cost a Durable Object request per window per
  bucket, and the busiest bucket has a one-second window — roughly doubling requests on the hottest
  path in the API to recover tens of bytes.

  **Idempotency is a Durable Object per `teamId` + key** (`server/idempotency/`). The lock is
  deleted rather than ported, for the reason §3 gives about the webhook lock: a Durable Object is
  single-threaded per object id, so "only one caller may be deciding this" is a property of where
  the code runs. What was `GET` → `SET NX` → a second `GET` to cover the winner finishing in
  between — three round trips and a race the second `GET` only narrows — is one `begin` that
  returns one of four answers: `acquired`, `hit`, `conflict`, `in-progress`. The Redis driver
  answers the same four, which is why the lock now holds the body hash instead of `"1"`.

  This object *does* get an alarm, unlike the rate limiter: keys are client-supplied and unbounded,
  and the alarm is one request per key per day rather than per second.

  Verified in a real isolate: ten concurrent `withIdempotency` calls on one key run the operation
  **once**, one caller gets the result and nine are refused, and a later duplicate replays rather
  than runs (`pnpm --filter=web bindings:check`).
- **Phase 10 — Delete.** Drop `bullmq`, `ioredis`, `server/redis.ts`, `REDIS_URL` / `REDIS_KEY_PREFIX`
  from `env.js` and `turbo.json`. Delete `docker/prod/compose.yml`.

  Phase 7's teardown hands it three more, none of which are Redis:

  1. **`docker/Dockerfile` no longer builds, and is left that way deliberately.** It builds
     `apps/web` expecting `.next/standalone` and runs `node apps/web/server.js` via
     `docker/start.sh`. That is the self-hosted Node deployment this migration replaces with
     `wrangler deploy`, so the question is not how to repoint it but **whether useSend still
     ships a container at all** — a product decision, not a teardown one. Nothing on `main`
     builds it: `.github/workflows/publish.yml` is tag-triggered. Either rewrite both files
     around `wrangler deploy` or delete them with `docker/prod/compose.yml` and `nixpacks.toml`.
     `docker/dev/compose.yml` and `docker/testing/compose.yml` stay — they are local infra.
  2. **The `NEXT_PUBLIC_` prefix is now free to go.** It survived Phase 7 only because renaming
     it mid-stack would have broken whichever framework was still running; nothing depends on
     the name any more. It is a wide but mechanical rename — `env.public.ts`, the `envPrefix` in
     `vite.config.ts`, `turbo.json`, `.dev.vars.example`, `.github/workflows/test-web.yml`,
     `docker/`, and every `publicEnv.NEXT_PUBLIC_*` read — and it changes operator-facing
     configuration, so it wants its own PR rather than a corner of someone else's.
  3. **`apps/web/.eslintrc.cjs` still extends `@usesend/eslint-config/next.js`.** The preset's
     Next rules are inert in a Vite app but the name now lies, and one
     `eslint-disable-next-line @next/next/no-img-element` in
     `routes/_dashboard/contacts/$contactBookId/-contact-list.tsx` depends on the plugin still
     being loaded. `apps/marketing` is a real Next.js app and keeps the preset, so this is a
     new non-Next config for `apps/web`, not a change to the shared one.

  Note that `pnpm --filter=web lint` already fails `--max-warnings 0` on `main` — 138 warnings
  before the teardown, 52 after it. That backlog predates #9 and belongs to #87, not here.

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

7. **Rate limiting fails open; the waitlist fails closed.** The API limiter and the auth-email
   limiter both let a request through when the limiter itself errors, which is what they already
   did on Redis. The reasoning is that a rate limiter here is a cost control, not a security
   control — authentication and authorisation have already run by the time any of them do — so an
   outage of the limiter should degrade billing accuracy rather than take out sign-in and the whole
   public API. The waitlist keeps its throw: it is one user submitting one form, and what it
   protects is the founder's inbox. Revisit if abuse ever becomes the reason a limiter exists.

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
| Worker CPU | 30M CPU-ms | **~8.6ms campaign, ~0.49ms transactional** *(measured)* | **~3.5M–61M emails/mo** | ~$0.01–0.17 / 1M emails |
| DO requests | 1M/mo | ~3 | ~330K emails/mo | ~$0.45 / 1M emails |

**At 10M emails/month the entire Cloudflare bill is roughly $80.** Queues is the first tier to go,
at ~75K emails — but at $0.40/million operations, crossing it costs pocket change. There is no
cliff anywhere on the Cloudflare side. Since #48 the CPU row is the *last* to expire rather than
the third, outlasting even Worker requests; the bill is unmoved, because CPU was never more than a
dollar or two of it.

### CPU per send and per event — measured

The CPU row above used to read *~35ms, estimated*. It is now measured, by
`apps/web/src/bench/cpu-per-email.bench.ts` (`pnpm --filter=web bench:cpu`). Medians of 25–40
samples per case, `process.cpuUsage()` user+sys, Node 26 on an AMD Ryzen 9 9900X. Each payload
class is stated with the size of the HTML it actually produced. **Re-measured after #48** replaced
scrypt with a keyed HMAC; the non-auth rows moved a few percent between the two runs, which is the
run-to-run noise the caveats below describe.

| Step | Payload | CPU median | CPU p95 |
|---|---|---|---|
| `jsx-email` render — `OtpEmail`, the real sign-in template | 9.1 KB out | 1.66 ms | 2.91 ms |
| `EmailRenderer.render` — double opt-in default (repo fixture) | 4.3 KB out | 0.573 ms | 1.49 ms |
| `EmailRenderer.render` — 6-section newsletter | 42.3 KB out | 5.67 ms | 10.1 ms |
| `EmailRenderer.render` — 30-section newsletter | 199.4 KB out | 25.7 ms | 37.0 ms |
| `html-to-text` — transactional | 9.1 KB in | 0.360 ms | 0.901 ms |
| `html-to-text` — 6-section newsletter | 42.3 KB in | 0.751 ms | 1.31 ms |
| `html-to-text` — 30-section newsletter | 199.4 KB in | 2.34 ms | 3.10 ms |
| MIME build (`nodemailer` stream transport, `ses.ts:183`) — transactional | 9.1 KB body | 0.465 ms | 0.845 ms |
| MIME build — 6-section newsletter | 42.3 KB body | 2.13 ms | 3.09 ms |
| MIME build + 256 KB attachment | 341.3 KB | 1.11 ms | 2.18 ms |
| **`verifySecureHash` — every public-API request, keyed HMAC since #48** | — | **0.004 ms** | 0.007 ms |
| `scryptSync` at Node's defaults — what that row cost *before* #48 | — | *16.9 ms* | *17.3 ms* |
| SES event: `JSON.parse` envelope + inner + status derivation | 2.4 KB | 0.004 ms | 0.007 ms |
| Webhook sign: `JSON.stringify` + HMAC-SHA256 | — | 0.002 ms | 0.005 ms |

The scrypt row is no longer on any request path — the benchmark still runs it at explicit
parameters as a control, which is what keeps the before/after legible instead of a number that
silently changed. It reads 16.9 ms here against the 18.7 ms PR #47 measured; same machine, same
parameters, so the spread is run-to-run noise and neither figure is more right than the other.

Rolled up: **campaign email ~8.6 CPU-ms** (render + `html-to-text` + MIME), **transactional email
~0.49 CPU-ms** — and that is now the figure whether the send is its own API request or one of 100
in a `POST /emails/batch`. Before #48 those two read ~19.2 and ~0.7, and the whole gap between them
was one `scryptSync` being amortised 100 ways. **Batching no longer buys CPU; it still buys
requests and queue operations**, which is where its leverage always mattered more. The whole event
pipeline is **0.021 CPU-ms per email** — 3.5 events at 0.006 ms each. It is 78% of the request and
queue load and 0.2% of the CPU.

Three things fall out of this:

1. **The 35ms estimate does not hold, and the error is not where §8 expected.** `jsx-email` and
   `html-to-text` were the named suspects; together they are ~6ms on a typical marketing email and
   ~1ms on a transactional one. Marginal CPU cost drops from ~$0.70 to **~$0.17 / 1M campaign
   emails**, and the free tier stretches from ~850K to ~3.5M emails/month. CPU was never going to
   be the binding constraint; queues still are, at ~75K.
2. **`scryptSync` was the whole transactional figure, and #48 removed it.** It measured 18.7ms —
   twice the entire campaign send — on every request through `getTeamAndApiKey`
   (`api-service.ts:78`), with nothing caching the result. That was Node's default cost
   (`N=16384, r=8, p=1, keylen=64`, inherited because `crypto.ts` passed no options) and it was
   *synchronous*: 18ms in which the isolate did nothing else. It was the one number worth acting
   on, and acting on it paid ~4,000x on the hash and ~39x on the send. The replacement is a keyed
   HMAC rather than a cache because **a cache could not have worked**: every cold isolate is a
   miss, so the p99 stays at the scrypt cost however good the hit rate is.
3. **Rendering bounds the campaign fan-out batch size.** At 5.7ms per recipient a single invocation
   fits ~5,000 renders inside the 30s CPU limit; at 26ms for a long newsletter, ~1,100. The
   self-continuation in §4.3 needs a page size well under that, and the subrequest cap (1000) bites
   first anyway. **This is now the only CPU figure that constrains anything** — with auth at
   0.004ms, rendering is the whole story.

**Caveats.** Measured under Node on x86 Linux, not on a `workerd` isolate on Cloudflare hardware —
the same V8, but different silicon, different build flags and a colder JIT, so treat these as an
order of magnitude rather than a bill. The benchmark loops hot, so nothing here captures cold-start
or JIT warm-up. It covers the named hot paths only: Hono routing, Zod validation, Drizzle query
construction and row serialisation are all unmeasured, so the per-email totals are a floor, not a
full accounting. All of `node:crypto` is available under `nodejs_compat` bar argon2, ed448/x448 and
DSA/DH keypairs, and #63 exercised both primitives in a real `workerd` isolate — `scryptSync` at
~14ms there, and the `createHmac` that replaced it in the same run (§8), though neither was
timed against Cloudflare hardware. Re-run on real Workers once #7's account access exists.

### The two things that actually bite

**1. Durable Object duration — bites on day one, not at scale.**

DO duration bills wall-clock time while running *or idle in memory but unable to hibernate*:
400,000 GB-s included, then $12.50/million GB-s, metered against 128 MB per object whatever it
actually uses.

The campaign-scheduler DO alarms every 1.5s forever (§4.2). If resident time is billed it burns
~332,000 GB-s/month — **83% of the entire allowance at zero email volume**. If idle-but-eligible
time is free it is 4,000–11,000 GB-s. A 30x swing on a **fixed cost independent of volume**, which
makes it the only thing here that can surprise you while still small.

### DO residency under a 1.5s alarm — measured

Measured by `prototypes/do-hibernation` (`pnpm experiment`), a Durable Object shaped like the
campaign scheduler running against real `workerd` under `wrangler dev`. Residency is read off
instance identity: each instance mints an id in its constructor, so an alarm handled by an instance
that has handled no earlier alarm means the object was evicted and rebuilt in between.

| Alarm interval | Alarms on a fresh instance | Result |
|---|---|---|
| **1500ms** (today's tick) | 0 of 39 | **Never evicted.** One instance handled all 40 alarms, 60s old at the last. |
| 3000ms | 0 of 7 | Never evicted |
| 6000ms | 0 of 5 | Never evicted |
| 9000ms | 0 of 4 | Never evicted |
| 11000ms | 4 of 4 | **Evicted between every alarm** — each handler ran on a 9ms-old instance |
| 15000ms | 3 of 3 | Evicted between every alarm |
| 30000ms | 3 of 3 | Evicted between every alarm |

The cliff sits between 9s and 11s, which is Cloudflare's documented rule: a Durable Object
hibernates after **10 seconds of inactivity**, and is evicted outright after 70–140s
([lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)).
Nothing about the alarm pins the object — a pending alarm is stored, not held in memory. A 1.5s
tick simply never idles long enough to reach the threshold.

Same object at 15s, an interval where it otherwise evicts every time, with one thing left behind:

| Left behind across the idle gap | Result |
|---|---|
| **An open outbound TCP socket** | **Resident** — never evicted |
| An in-flight unawaited `fetch()` | Resident — never evicted |
| A pending `setTimeout` | Resident — never evicted |
| A running `setInterval` | Resident — never evicted |
| State hydrated in `blockConcurrencyWhile` | Evicted between every alarm — no effect |

Those four are exactly Cloudflare's documented hibernation-eligibility rules, reproduced by the
local runtime — which is the reason to trust the measurement: `workerd` implements the same
eviction path, and `workerd.capnp` documents the same 10s/70s defaults. **The socket row is the one
with teeth here**: a pooled Postgres connection to Neon held by the scheduler DO would make it
permanently ineligible, silently, with no error anywhere.

**What this cannot settle: the bill.** `workerd` models eviction but not metering — there is no
GB-s counter in local dev. And Cloudflare's pricing page says idle time that is *eligible* for
hibernation is not billed *"even before the runtime has hibernated"*, so a 1.5s ticker that is
resident-but-eligible may be in the cheap branch already. That sentence was added in February 2026
and reads as though written for the ~10s window, not for an object that stays hibernation-eligible
for months. It is the interpretation, not the behaviour, that is unresolved. Only a deployed canary
reading account duration GB-s over 24h closes it: 11,059 GB-s if resident time is billed, ~370 GB-s
if it is not.

**So don't bet on the interpretation — design it away.** A 30s tick is in the cheap branch under
either reading (§4.2), and wins on two axes that do not depend on the interpretation at all: alarm
invocations are billed as DO requests, and each `setAlarm()` is a billed row write.

| Per month, one scheduler DO | 1.5s tick | 30s tick |
|---|---|---|
| Alarm invocations | 1,728,000 — **173% of the 1M included DO requests, at zero volume** | 86,400 (8.6%) |
| `setAlarm()` row writes | 1,728,000 (3.5% of the included 50M) | 86,400 (0.17%) |
| Duration if resident time is billed | 331,776 GB-s (83% of allowance) | ~550 GB-s |
| Duration if it is free | 4,000–11,000 GB-s | ~550 GB-s |

**Caveats.** Local `workerd` on Linux, not Cloudflare's fleet: eviction timing could differ in
production under memory pressure. The likely direction of that difference is safe — more eviction,
not less — but 10s is not a contract. Nothing here measures billing. The alarm handler does a ~9ms
stub query rather than a real Neon round trip, so per-wake duration is a floor. Re-check against a
real account once #7's access exists.

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
3. **Batch the event ingest path.** ~~`sendBatch` from the SNS route;~~ one multi-row INSERT per
   consumer batch. Cuts queue operations and Neon write load together. → Phase 8, **not done**.
   The `sendBatch` half is **impossible**: SNS HTTP/S delivery posts exactly one notification per
   request, so the producer never has more than one message to send. Batching on `Publish` is a
   different thing and is not what SES uses here. The consumer-side INSERT is the whole win, and
   the consumer already receives batches of up to 100 (`max_batch_size`, `max_batch_timeout: 5`).
4. **~~Cache API key verification.~~ Done — #48.** `scryptSync` was 18.7ms of synchronous CPU on
   *every* public-API request, 97% of a transactional send. Two options were on the table: cache
   the verified `clientId → team` mapping, or move to a keyed HMAC over a high-entropy token (these
   are generated secrets, not passwords — scrypt was protecting against an attack the threat model
   does not have). The HMAC won outright, because the cache would have needed to be KV or a DO
   (§8) and still could not have fixed the p99 — every cold isolate is a miss. Shipping no cache
   also keeps revocation immediate. → landed
