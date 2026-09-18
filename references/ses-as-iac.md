# SES as declared infrastructure

Status: **design only. Nothing here is implemented.** It supersedes the one line in
`references/serverless-migration.md` §1 that records "IaC: **wrangler**" — true for Cloudflare,
and the AWS side has no IaC at all.

**The decision this writes down:** the SNS topic, its subscription and the four SES configuration
sets stop being created at runtime by an admin filling in a form, and become resources declared in
the repository and created at deploy time. `SesSetting` — the database row that remembers what that
form created — is deleted. What the Worker needs to know about SES becomes Worker configuration.

**What it does not change:** domains stay a runtime action (§4), SES stays the delivery path,
and `wrangler.jsonc` stays the Cloudflare source of truth (§6).

**Context.** This fork runs **one instance per domain, one SES region, one SNS topic**, with
dev/staging/production pointing at **the same AWS account**. Upstream is multi-tenant SaaS, which is
why the resources are runtime-provisioned: a hosted useSend onboards its own SES account through the
UI. That requirement does not exist here. There is no production deployment and no users, so this
prefers a clean design over a compatible one.

---

## 1. Inventory: what is created at runtime today

All of it comes from one function, `SesSettingsService.createSesSetting`
(`apps/web/src/server/service/ses-settings-service.ts:81`), called from one server function
(`server/functions/admin.ts:132`), driven by one form (`routes/_dashboard/admin/-ses-settings-form.tsx`).
One `SesSetting` row per region; the fork will have exactly one.

| # | AWS resource | Created by | Keyed by today | As declared config |
|---|---|---|---|---|
| 1 | SNS topic | `sns.createTopic` (`server/aws/sns.ts:18`), name `${idPrefix}-${region}-unsend` (`ses-settings-service.ts:117`) | random `idPrefix` | `${prefix}-${region}` where `prefix = usesend-{env}` |
| 2 | SNS subscription, protocol `https` | `sns.subscribeEndpoint` (`sns.ts:33`), endpoint `${usesendUrl}/api/ses_callback` | the URL typed into the form | `${APP_URL}/api/ses_callback`, a stack parameter |
| 3 | Configuration set `-general` | `ses.addWebhookConfiguration` (`aws/ses.ts:277`) | `${idPrefix}-${region}-unsend-general` | `${prefix}-${region}-general` |
| 4 | Configuration set `-click` | same | `…-unsend-click` | `${prefix}-${region}-click` |
| 5 | Configuration set `-open` | same | `…-unsend-open` | `${prefix}-${region}-open` |
| 6 | Configuration set `-full` | same | `…-unsend-full` | `${prefix}-${region}-full` |
| 3a–6a | One event destination per set, named `usesend_destination`, SNS → topic #1 | `CreateConfigurationSetEventDestination` (`ses.ts:290`) | — | inline in the same declaration |

Ten CloudFormation-shaped resources, not six: each configuration set and its event destination are
separate API calls and separate resource types.

**The four configuration sets all point at the same topic.** They exist only to select event types.
`GENERAL_EVENTS` (`ses-settings-service.ts:38-45`) is `BOUNCE, COMPLAINT, DELIVERY, DELIVERY_DELAY,
REJECT, RENDERING_FAILURE`; `-click` adds `CLICK`, `-open` adds `OPEN`, `-full` adds both. The
choice is per send: `getConfigurationSetName(clickTracking, openTracking, region)`
(`src/utils/ses-utils.ts:3`) picks one from the domain's tracking flags — **and reads `SesSetting`
out of the database to do it, on every send**.

### `idPrefix` becomes deterministic

`const idPrefix = smallNanoid(10)` (`ses-settings-service.ts:111`), with a unique index on it
(`schema.ts:234`). It is random for a real reason: upstream's hosted instances share nothing, and two
useSend installations pointed at one AWS account must not collide on a configuration set name.

Under IaC that property is wrong. A deploy has to be able to *re-derive* the names it created, or it
cannot converge — and the Worker has to derive them too, which is the whole point (§2). So:

```
prefix = usesend-{env}          env ∈ { local, dev, staging, prod, … }
topic  = {prefix}-{region}      e.g. usesend-prod-us-east-1
config = {prefix}-{region}-{general|click|open|full}
```

Staging and production coexist in one AWS account because `{env}` differs, not because a nanoid did.
`usesend-prod-ap-southeast-2-general` is 35 characters against SES's 64-character limit and uses only
`[A-Za-z0-9_-]`; the longest supported region leaves ~25 characters of headroom.

Two things follow, and both are deliberate:

- **Determinism is also collision-by-design.** Two people both deploying `env=dev` into one account
  now share resources, where the nanoid gave them accidental isolation. `{env}` is a free-form
  string precisely so that the answer is `env=dev-allan`, not a scheme change.
- **This is the moment the names stop saying "unsend".** Configuration set names are immutable
  identifiers — renaming means new sets — so a rename is free now and expensive after a first
  production send. Take it now.

### What the row stores that is not an AWS resource

`SesSetting` also carries `sesEmailRateLimit` and `transactionalQuota`
(`schema.ts:229`, `:232`) — sizing for the send queues. These are **already dead as inputs**:
§4.1/§11 decision 1 of the migration plan made `max_concurrency` deploy-time, and
`EmailQueueService.initializeQueue` (`email-queue-service.ts:82`) is now a log line and nothing else.
They do not become AWS config; they are already `SEND_QUEUE_MAX_CONCURRENCY` in
`server/queue/ses-regions.ts:62`. They delete with the row.

`callbackSuccess`, `configGeneralSuccess`, `configClickSuccess`, `configOpenSuccess`,
`configFullSuccess` are per-resource "did this API call return 200" flags, rendered in a status table
(`-ses-configurations.tsx:67`). Under IaC a failed create fails the deploy. They delete.

---

## 2. What becomes configuration, and where it lives

**Decision: Worker `vars` in `wrangler.jsonc` per environment, plus one secret.** Not a generated
file, not the database.

| Name | Kind | Example | Read by |
|---|---|---|---|
| `SES_REGION` | `vars`, per env | `us-east-1` | `getConfigurationSetName`, `createDomain`, the SES client |
| `SES_RESOURCE_PREFIX` | `vars`, per env | `usesend-prod` | name derivation |
| `AWS_ACCOUNT_ID` | secret, per env | 12 digits | topic ARN and identity ARN derivation |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | secrets, already exist | | `server/aws/credentials.ts` |
| `APP_URL` | already exists | `https://mail.example.com` | the callback URL the stack subscribes |

Everything the app needs about SES is then a **pure function** of those:

```ts
// server/aws/ses-resources.ts — new, and the single source of truth
sesResourceNames({ prefix, region }) -> {
  topicName, topicArn(accountId), general, click, open, full
}
```

Three consequences, in descending order of importance:

1. **`getConfigurationSetName` stops touching the database and stops being `async`.** Today it is one
   `SELECT` (behind a per-isolate cache that a cold isolate misses) on the hot path of every single
   send. It becomes string concatenation. This is the largest behavioural win in the whole change and
   it is free.
2. **`checkEventValidity` (`server/service/ses-callback.ts:130`) derives the topic ARN** instead of
   reading `SesSettingsService.getTopicArns()`. Same removal, on the event ingest path — which §12 of
   the migration plan measures at 78% of request and queue load.
3. **`getAccountId` (`aws/ses.ts:26`) and its `STSClient` delete.** It calls `GetCallerIdentity` and
   caches the answer in a module-level `let` — which on Workers is per-isolate, so it is a subrequest
   on every cold isolate, and it is exactly the module-level-state hazard §8 of the migration plan
   warns about. With `AWS_ACCOUNT_ID` in config, `getIdentityArn` is a template string.
   `@aws-sdk/client-sts` leaves `apps/web/package.json`.

### Why bindings and not the database: the Neon branch problem

This is the part worth being explicit about, because it is a silent failure and it is live today.

`SesSetting` is a row. The dev and preview databases are **Neon branches** — `docker/dev/compose.yml`
pins `BRANCH_ID`, and a branch is a copy-on-write clone of another branch's data. So the SES
configuration **follows the data, not the deployment**.

Restore or branch production into staging and staging silently inherits production's `topicArn`,
production's `callbackUrl` and production's four configuration set names. Staging then sends through
production's configuration sets, production's SNS topic fans the resulting events out to
production's callback URL, and staging's `checkEventValidity` accepts production's topic ARN as its
own. Nothing errors. The first sign is production `EmailEvent` rows for emails production never sent.

Worker `vars` follow the **deployment**. `wrangler deploy --env staging` cannot pick up production's
topic ARN, because the value is in the `env.staging` block of `wrangler.jsonc` and nothing copies it.
Moving this out of the database fixes a real bug, not just a layering complaint.

### What `wrangler.jsonc` needs that it does not have

`apps/web/wrangler.jsonc` (456 lines) declares **no environments** — no `env.*` blocks at all, and
`"vars": {}` is empty with a comment saying deployed values are secrets. Per-environment SES config
requires adding them. That is a structural change to a file the repo treats carefully, and it has a
second consequence: Cloudflare Queues and Durable Objects are **per-environment** resources, so
`env.staging` and `env.prod` get their own copies of all 31 queues. That is fine (idle queues cost
nothing) but it should be a decision rather than a surprise.

**A related cleanup this unlocks.** `SUPPORTED_SES_REGIONS` (`server/queue/ses-regions.ts:21`) lists
thirteen regions and generates 26 send queues, because upstream lets a tenant add any region at
runtime. With the region declared per environment, the list collapses to the region that environment
actually uses — 24 queues and 24 consumers leave `wrangler.jsonc`. The migration plan flags the
contents of that list as "a product decision that has not been made" (§8, leftover 2); this change
makes the decision unnecessary. Do it last (§7, PR F), not first.

---

## 3. What deletes

Every entry below was checked against the code, not inferred. Line numbers are against `main` at
`1d70ab8`.

**Deletes outright**

| Thing | Location | Notes |
|---|---|---|
| `SesSettingsService` | `server/service/ses-settings-service.ts` (whole file, 350 lines) | cache, `getSetting`, `getAllSettings`, `getTopicArns`, `createSesSetting`, `updateSesSetting`, `checkInitialized`, `invalidateCache`, `registerConfigurationSet`, `isValidUsesendUrl` |
| `isValidUsesendUrl` | `ses-settings-service.ts:334` | `fetch`es `{url}/api/ses_callback` and requires 200 before saving — the reason local dev needs a publicly reachable URL or a tunnel |
| `server/aws/sns.ts` | whole file | `createTopic`, `deleteTopic`, `subscribeEndpoint`. **Verified sole importer** is `ses-settings-service.ts:7`. `@aws-sdk/client-sns` leaves `package.json` |
| `ses.addWebhookConfiguration` | `aws/ses.ts:277` | **verified**: four call sites, all in `registerConfigurationSet` |
| `ses.getAccount` | `aws/ses.ts:270` | **verified**: one caller, `getQuotaForRegion` |
| `getAccountId`, `getIdentityArn`, the STS client | `aws/ses.ts:26-45` | replaced by `AWS_ACCOUNT_ID` (§2) |
| `EmailQueueService.initializeQueue` | `email-queue-service.ts:82` | already inert; after this it has no caller |
| Server functions | `functions/admin.ts:103` `getSesSettings`, `:107` `getDefaultSesRegion`, `:116` `getQuotaForRegion`, `:124` `getSetting`, `:132` `addSesSettings`, `:150` `updateSesSettings` | |
| `getAvailableRegions` | `functions/domain.ts:39` | its only body is `SesSettingsService.getAllSettings()` |
| Query factories | `queries/admin.ts` — `sesSettings`, `defaultSesRegion`, `sesSetting`, `quota`, `quotas` keys | `emailAnalytics` stays |
| Admin UI | `-add-ses-configuration.tsx` (39), `-edit-ses-configuration.tsx` (150), `-ses-settings-form.tsx` (272), `-ses-configurations.tsx` (86) | 547 lines |
| The onboarding gate | `routes/_dashboard.tsx:71-87` | `mayConfigureSes`, the `sesSettings` query, and `return <SesSettingsScreen />` when the list is empty — today **the entire dashboard is blocked** until a region exists |
| `getValidSesRegions` | `lib/zod/ses-setting-schema.ts:5` | `sesRegionSchema` stays: `Domain.region` still needs validating |
| `sesSetting` table + type | `server/drizzle/schema.ts:213-236`, `types/db.ts` | |

**Changes shape**

- **`routes/_dashboard/admin/index.tsx` is 100% SES** — its loader is `adminQueries.sesSettings()`
  and its body is the add dialog plus the table. The route deletes, which leaves `/admin` with no
  index. And `admin.tsx:43-51` shows "SES Configurations" unconditionally while the other three tabs
  are `isCloud()`-only — **so on a self-hosted install `/admin` becomes empty**, along with the
  sidebar entry at `-app-sidebar.tsx:124-131` which is `isSelfHosted: true`. Decide one of: make
  `/admin` cloud-only and drop the self-hosted sidebar entry, or redirect `/admin` → `/admin/teams`.
  Recommend the former: with SES gone there is nothing for a self-hosted admin to administer.
- **`-add-domain.tsx` loses its whole region machinery**: `regionQuery` (`:53`), `singleRegion`
  (`:82`), `showRegionSelect` (`:85`), `hasNoRegions` (`:96`), the "no sending region is configured"
  branch (`:157-172`) added by PR #127, the region `FormField` (`:199-224`), and `region` in
  `domainSchema` (`:44`). `createDomain` takes `env.SES_REGION`. ~70 lines, and the dead-end that
  #126 fixed stops being possible rather than being handled.
- **`ses-callback.ts` `handleSubscription` (`:103`)** keeps the `fetch(message.SubscribeURL)` — that
  is what confirms the subscription — and loses the `SesSetting` lookup by `topicArn` (`:109-114`)
  and the `callbackSuccess` write (`:121`). It should gain the topic-ARN check that
  `checkEventValidity` does, which it does not have today.
- **`env.js`**: add `SES_REGION`, `SES_RESOURCE_PREFIX`, `AWS_ACCOUNT_ID`. `AWS_DEFAULT_REGION` is
  currently doing two jobs — a default for the admin form and the region for AWS clients — and
  should become `SES_REGION` alone.

**Does not delete**

- `GENERAL_EVENTS` (`ses-settings-service.ts:38-45`) and its long comment about why `SEND` and
  `SUBSCRIPTION` are excluded. It **moves** to the shared names module: the stack declares the same
  list. That comment is the reasoning behind the single biggest cost lever in §12 and must not be
  lost in a file deletion.
- **The `SesSetting` migration.** The table is in `migrations/0000_baseline.sql:198` with its indexes
  at `:389-390` — the **baseline**, which also creates all 23 other tables. It cannot be edited or
  removed. This needs a **new** migration, `0002_drop_ses_setting.sql`.
  (`0001_email_usage_counted_at.sql` is the only non-baseline migration today.)

**Nothing in the test suite blocks any of this.** There is no `SesSetting` factory, no integration
fixture and no mock of `SesSettingsService` — searched across `src/test/`, all `*.test.ts` and
`*.test.tsx`. The only test mentioning it is `env.public.unit.test.ts`, in a comment. The suite mocks
`~/server/aws/ses` wholesale.

---

## 4. Domains: stay runtime

**Recommendation: adding a domain stays a runtime action.** Not close.

A domain is per-tenant application data. `createDomain` (`domain-service.ts:428`) checks a plan limit
(`LimitService.checkDomainLimit`), writes a `Domain` row, emits a `domain.created` webhook, and
returns DNS records the user must publish before anything verifies. An hourly cron re-checks them
(§4.3 of the migration plan). None of that is deploy-time-shaped, and declaring domains would mean a
deploy per customer domain plus a second source of truth racing the `Domain` table.

Even at one-domain-per-instance, where "declare it" is superficially tempting, it does not work:

- **The DKIM keypair is generated in the app** (`generateKeyPairSync`, `aws/ses.ts:57`) and the
  **public key is the return value of `CreateEmailIdentity`** — `addDomain` returns it and it is
  stored on `Domain.publicKey`, which is where the DKIM TXT record comes from
  (`buildDnsRecords`, `domain-service.ts:79`). Declaring the identity means either putting a private
  key in a CloudFormation template or reading a public key back out as a stack output and writing it
  to the database anyway. You would have IaC *and* the row.
- **`sesTenantId` is per-team** (`Team.sesTenantId`, used at `ses.ts:105`). Tenants are a runtime
  concept here by construction.

### Fix the no-rollback bug instead

`ses.addDomain` (`aws/ses.ts:81`) issues two sequential commands with no compensation:
`CreateEmailIdentityCommand` (`:98`) then `PutEmailIdentityMailFromAttributesCommand` (`:105`), and
`createDomain` inserts the `Domain` row only after both succeed. If the second fails you are left
with an SES identity that has no MAIL FROM, no database row, and a retry that hits
`AlreadyExistsException`.

**The retry cannot recover.** `GetEmailIdentity` does not return the BYODKIM public key — for a
bring-your-own-DKIM identity SES holds the private key and reports selector and status, not the key
material. The app generated that keypair in memory and threw it away. So the orphaned identity is
unusable: there is no way to reconstruct the DKIM record the user has to publish.

That makes the correct fix specific, and it is not "wrap it in a transaction":

1. On any failure after `CreateEmailIdentity` succeeded, issue `DeleteEmailIdentityCommand` as a
   compensating action, and let the original error propagate.
2. On `AlreadyExistsException` from `CreateEmailIdentity` **with no corresponding `Domain` row**,
   delete the identity and retry once. With a row, fail loudly — that is a real duplicate.
3. Leave the row insert where it is, after both calls.

This is a small, self-contained PR that is **independent of everything else in this document** and
should land on its own. Note that it cannot be exercised against the local simulator until
`GetEmailIdentity` is fixed upstream (PR #127, "What still does not work").

---

## 5. The deploy sequence

The chicken-and-egg looks bad — the Worker needs the topic ARN, the subscription needs the Worker's
URL — and **deterministic naming dissolves it**. The Worker derives the topic ARN from
`SES_RESOURCE_PREFIX`, `SES_REGION` and `AWS_ACCOUNT_ID`; it never has to be told. So the Worker can
go first, and the subscription lands on an endpoint that is already answering.

**A fresh environment, in order. Each step gates the next.**

1. Choose `{env}`, `{region}` and the public hostname.
2. Create the Cloudflare resources whose ids wrangler cannot derive: `wrangler kv namespace create`,
   `wrangler r2 bucket create`, `wrangler hyperdrive create`. Paste the ids into the `env.{env}`
   block. (`wrangler.jsonc` has `REPLACE_WITH_HYPERDRIVE_ID` and `REPLACE_WITH_KV_NAMESPACE_ID`
   today — this step exists already and is still manual.)
3. `wrangler secret put` — `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ACCOUNT_ID`,
   `APP_SECRET`, `BETTER_AUTH_SECRET`, `API_KEY_HMAC_SECRET`.
4. `pnpm --filter=web deploy --env {env}` (`wrangler deploy`). Queues, Durable Objects and crons are
   created by this. `GET /api/ses_callback` now answers.
5. `pnpm infra:deploy --env {env}` — topic, subscription, four configuration sets and their event
   destinations. SNS posts `SubscriptionConfirmation` to the Worker from step 4;
   `handleSubscription` GETs the `SubscribeURL` and the subscription confirms itself.
6. `pnpm db:migrate` against that environment's Neon branch.
7. Sign in, add a domain, publish the DNS records.

**Uncertain, and how to settle it.** CloudFormation's `AWS::SNS::Subscription` docs say "for a
subscription to be created, the owner of the endpoint must confirm the subscription", but do not say
whether the stack blocks on confirmation or completes with the subscription `PendingConfirmation`.
If it blocks, step 5 has a timeout risk when step 4's Worker is misconfigured. Settle it by deploying
the stack once with the endpoint deliberately returning 500 and watching the stack event stream — not
by reading more documentation.

**What a developer runs locally — the whole thing:**

```
pnpm dx        # Neon Local + local-ses-sns, migrations
pnpm dev       # vite dev on :8788
```

No AWS account, no CDK, no admin onboarding screen, no publicly reachable callback URL, no tunnel.
`.dev.vars` gets `SES_REGION=us-east-1`, `SES_RESOURCE_PREFIX=usesend-local`,
`AWS_ACCOUNT_ID=000000000000`. See §8.

---

## 6. Tool evaluation

Judged on four axes: does it cover both clouds or force two tools; does it fit a repo whose
Cloudflare config is a 456-line commented `wrangler.jsonc` that a unit test asserts against; state
management burden; and proportion — **this is ten AWS resources with no dependencies between
environments**.

### SST — rejected, on a primary source

SST is at **v4.17.1** (2026-07-12), and the repository moved from `sst/sst` to `anomalyco/sst`. Its
Cloudflare support is better than a search will tell you: `platform/src/components/cloudflare/`
exports `worker`, `queue`, `durable-object`, `hyperdrive`, `kv`, `bucket`, `cron`, `workflow`,
`rate-limit` and even `tan-stack-start` — so the widely repeated claim that Durable Objects and
Hyperdrive are unsupported is **wrong**, even though the docs sidebar omits both. On paper it is the
only candidate that covers Cloudflare and AWS in one TypeScript program.

It is still the wrong tool here, for one reason, stated by SST itself:

> **Do not include any Wrangler configuration files (`wrangler.toml`, `wrangler.json`) in your
> project. SST manages these for you and will generate them as needed.**
> — https://sst.dev/docs/cloudflare/

And for the Vite-based frameworks this repo uses, `@cloudflare/vite-plugin` must be pointed at
`process.env.SST_WRANGLER_CONFIG`.

Against this repository that means: delete `apps/web/wrangler.jsonc`; re-express 31 queue producers,
32 consumers with per-queue retry and concurrency, four Durable Object bindings with three migration
tags, six cron triggers, Hyperdrive, KV and R2 as SST components; rewrite
`queue-registry.unit.test.ts` and `cron-registry.unit.test.ts`, which read the file through
`src/test/wrangler-config.ts` to prove the code and the deploy config agree; and re-point
`vite.config.ts` at a generated file. The commentary in that file — why JSONC, why the scheduler is
absent from the cron list, why KV is not idempotency, why `localConnectionString` matches
`.env.example` — is design documentation, and it does not survive generation.

That is a large, risky rewrite of the part that works, bought in order to declare **ten AWS
resources**. Rejected on proportion.

### Terraform / OpenTofu — viable, second choice

Both providers are mature and both cover everything needed on both sides. Two objections, neither
fatal:

- **A state backend.** S3 + a lock table, or a hosted backend, per environment. That is
  infrastructure to provision before you can provision infrastructure, for ten resources.
- **HCL duplicates what TypeScript already owns.** The event-type list and the name derivation would
  live in `.tf` while the Worker derives the same names in `.ts`. The repo's established answer to
  exactly this problem is `queue-registry.ts` plus a unit test that reads `wrangler.jsonc` — a
  pattern that does not extend across a language boundary without codegen.

Take it if AWS grows past SES/SNS.

### Alchemy — not yet

Covers Cloudflare deeply (Workers, DOs, Queues, Hyperdrive, with `alchemy dev` running workerd and
local simulators) and, since `2.0.0-beta.64` in July 2026, a very wide AWS surface. It is also
**`2.0.0-beta`**, and it wants to own the Worker deploy the same way SST does. Adopting a beta tool
and handing it the Cloudflare side to manage ten AWS resources is the same trade as SST with less
maturity behind it. Revisit in a year.

### wrangler + a script — the honest baseline

Every operation in `createSesSetting` is already written and already converges if you squint:
`CreateTopic` is idempotent by name and returns the existing ARN; `Subscribe` is idempotent by
(topic, protocol, endpoint); `CreateConfigurationSet` throws `AlreadyExists`, which you catch. The
SDKs are already dependencies. Zero new tooling. It is `createSesSetting` with the database write
removed and CI as the caller.

What it does not give you: **delete**. Rename a configuration set or move an environment and the old
sets stay in the account forever, unreferenced, indistinguishable from live ones. There is no drift
detection and no plan output. Hand-rolled idempotency is the thing IaC exists to stop you writing.
For ten resources that will be edited perhaps five times ever, this is *defensible* — it is not what
I would pick.

### Recommendation: **wrangler for Cloudflare, AWS CDK for AWS. Two tools, on purpose.**

No single tool covers both without one of them being wrong, and the asymmetry is real: the
Cloudflare side already has an IaC tool that fits, is tested against, and drives the dev server. The
AWS side has ten resources and nothing.

AWS CDK, one stack per environment in one account (`usesend-ses-dev`, `usesend-ses-prod`):

- **CloudFormation holds the state.** No backend to provision, no lock table, no state file in a
  repo or a bucket. This is the single largest burden Terraform adds at this size, and CDK does not
  have it.
- **Real delete and drift.** `cdk destroy` removes a whole environment; `cdk diff` shows what a
  change will do before it does it. Both are what the script option lacks.
- **TypeScript, so there is one source of truth.** The stack imports `sesResourceNames` and
  `SES_EVENT_TYPES` from the same module the Worker imports, and a unit test asserts the synthesised
  template's configuration set names equal `sesResourceNames(...)` — the `queue-registry.unit.test.ts`
  pattern, extended to AWS. Neither HCL nor YAML can do that.
- **Every resource type exists.** `AWS::SNS::Topic`, `AWS::SNS::Subscription`,
  `AWS::SES::ConfigurationSet`, `AWS::SES::ConfigurationSetEventDestination` with `SnsDestination`
  and all ten `MatchingEventTypes` we use. `AWS::SES::Tenant` and `AWS::SES::EmailIdentity` exist
  too, if §4 is ever revisited.

**The strongest argument against it, stated plainly:** `cdk bootstrap` provisions a `CDKToolkit`
stack, an S3 bucket and five IAM roles into the account, and `aws-cdk-lib` is tens of megabytes of
`devDependency` — a disproportionate apparatus for ten resources that will be edited a handful of
times. If that ceremony is unacceptable, take a **hand-written ~90-line CloudFormation template plus
`aws cloudformation deploy`** instead: no bootstrap, no dependency, same stack-per-environment
design, same derived names, same delete and drift semantics. Only the authoring tool changes, and the
cost is that the event list is duplicated in YAML instead of imported. Everything else in this
document is unaffected.

**What would change the recommendation to Terraform/OpenTofu:** AWS growing past SES and SNS —
`apps/smtp-server` moving to ECS/Fargate, a VPC, IAM users per environment, an SQS DLQ for the SNS
subscription. At that point the state backend is amortised and provider breadth starts to matter.
**What would change it to SST or Alchemy:** deciding that `wrangler.jsonc` is not worth defending —
which would be a defensible call on a greenfield repo and is not one on this one.

**Out of scope, flagged:** the IAM user and policy the Worker's SES credentials belong to are not in
this design. They could be — an `AWS::IAM::Policy` scoped to `{prefix}-{region}-*` configuration sets
would be a genuine security improvement over a broad SES policy — but the access key itself must not
be a CloudFormation output. If it is added, create the key out of band and `wrangler secret put` it.

---

## 7. Migration path

There is no production deployment and no users, so this does not need to be reversible in operation
— but every PR must leave `main` working, which is the same constraint Phase 7 met by keeping
Next.js serving until the last PR (§9 of the migration plan).

| PR | Change | Risk |
|---|---|---|
| **A** | `server/aws/ses-resources.ts`: `sesResourceNames()` + `SES_EVENT_TYPES` (moved from `GENERAL_EVENTS`, comment intact). `registerConfigurationSet` uses it. New env vars declared **optional** in `env.js`. | None. Pure refactor, no behaviour change. |
| **B** | `infra/` — the CDK app, `pnpm infra:diff` / `infra:deploy`, and the unit test asserting the synth output against `sesResourceNames`. Nothing in the app reads it; nothing is deployed. | None. Additive. |
| **C** | Flip the readers. `getConfigurationSetName` becomes pure and synchronous; `checkEventValidity` and `handleSubscription` derive the topic ARN; `createDomain` drops the `getSetting` lookup and takes `env.SES_REGION`. Env vars become required. | **The only PR that changes send-path behaviour**, and it is three functions. Revertable by reverting one commit. |
| **D** | Delete the onboarding: six server functions, `getAvailableRegions`, five query factories, four admin components, `admin/index.tsx`, the `_dashboard.tsx` gate, the `-add-domain.tsx` region machinery, `aws/sns.ts`, `getAccount`, `addWebhookConfiguration`, `SesSettingsService`. Decide `/admin`'s fate (§3). | Wide but mechanical. The table still exists and is still readable. |
| **E** | `0002_drop_ses_setting.sql`, `schema.ts`, `types/db.ts`. | Irreversible in data terms — which is why it is last and separate. |
| **F** | Shrink `SUPPORTED_SES_REGIONS` to the declared regions; regenerate `wrangler.jsonc`. | Independent of A–E. Can be skipped or deferred indefinitely. |

**The ordering that matters:** C before D (all readers moved before any writer is deleted), D before
E (code before schema). A and B are independent of each other and of everything else. The domain
rollback fix from §4 is orthogonal and can land at any point.

**Mid-way state is coherent at every step.** After C the admin form still works and still writes rows
— it just writes rows nobody reads, which is a harmless no-op, not a divergence.

---

## 8. Local development and the simulator

`pnpm dx:up` starts `usesend/local-ses-sns` on **5350** (`docker/dev/compose.yml:38`), and PR #127
(merged, `1d70ab8`) made the whole loop work: it fixed the `@aws-sdk/client-*` `browser`-field
resolution bug that made **every** `new SESv2Client()`/`new SNSClient()` throw inside workerd —
including in a production build — added `AWS_SES_ENDPOINT`/`AWS_SNS_ENDPOINT` to
`.dev.vars.example`, moved the simulator's notification target from 3000 to 8788, and made both
endpoints **required** outside production with `AWS_ALLOW_REAL_ENDPOINTS=true` as the explicit
opt-out.

That guard and that fix are **load-bearing for this design and unaffected by it**. Everything below
sits on top of them.

### What gets better

The six steps under "Local SES and SNS" in `AGENTS.md` collapse. Specifically:

- **`isValidUsesendUrl` goes, and with it the reachability requirement.** Today
  `createSesSetting` refuses to save unless `{url}/api/ses_callback` returns 200 *to the app*, while
  SNS separately confirms by POSTing *to the container's view of the same URL*. `localhost` is the
  container itself, so `AGENTS.md` documents using the Docker bridge address (`172.17.0.1:8788`),
  running the dev server with `--host`, and opening the bridge in `ufw`. All of that exists to
  satisfy a check in a form that no longer exists.
- **The "SES setting must exist before a domain can" gate goes.** No `/admin` visit,
  no `ADMIN_EMAIL` on a cloud-flavoured local install, no full-screen onboarding form before the
  dashboard renders (`_dashboard.tsx:85`).
- **The simulator never needed the subscription anyway.** It posts to `WEBHOOK_URL` from
  `compose.yml:47`, a fixed environment variable. The `sns.subscribeEndpoint` call the app makes has
  never been what wires the callback locally. Deleting it removes a step that was already a no-op.

### What is unchanged

- `AWS_SES_ENDPOINT`/`AWS_SNS_ENDPOINT` still point at `localhost:5350`. `AWS_SNS_ENDPOINT` is now
  read by nothing in the app — the only SNS caller was `aws/sns.ts` — so it can be dropped from
  `.dev.vars.example` in PR D.
- `AWS_ALLOW_REAL_ENDPOINTS` stays and gets slightly better. Pointing a local Worker at real AWS now
  also requires `SES_RESOURCE_PREFIX` to match a deployed environment; get it wrong and SES rejects
  the send with "configuration set does not exist" rather than silently succeeding against whatever
  the database happened to contain.
- `GetEmailIdentity` against the simulator is still broken (ISO-8601 where SESv2 specifies epoch
  seconds), so **Verify domain** still fails locally and `Domain.status` still has to be set by hand.
  Upstream image, no source here. This design does not touch it — but note that §4's converge-on-
  retry fix depends on that call, so it cannot be tested locally until it is fixed.

### One thing to check, and it decides whether a script is needed

**Does the simulator reject a `SendEmail` whose `ConfigurationSetName` it has never seen?** PR #127's
end-to-end run created the four configuration sets through the admin form first, so the question was
never asked. With the form gone, nothing creates them locally.

- If the simulator ignores unknown configuration set names: nothing to do.
- If it rejects them: ship `pnpm dev:ses:seed`, ~20 lines calling `CreateConfigurationSet` against
  `localhost:5350` using the same `sesResourceNames` module, run once after `pnpm dx:up`.

Settle it by sending one email against the container with a made-up configuration set name. **Ship
the seed script either way** — it costs almost nothing and it keeps local and deployed parity
explicit rather than accidental.

Finally: `checkEventValidity` short-circuits on `NODE_ENV === "development"`
(`ses-callback.ts:132`), so the derived topic ARN is never checked locally. Cover the derivation with
a unit test rather than assuming a local run exercises it.
