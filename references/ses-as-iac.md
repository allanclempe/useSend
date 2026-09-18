# SES as declared infrastructure

Status: **design only. Nothing here is implemented.** It supersedes the one line in
`references/serverless-migration.md` §1 that records "IaC: **wrangler**" — true for Cloudflare,
and the AWS side has no IaC at all.

**The decision this writes down:** the SNS topic, its subscription and the four SES configuration
sets stop being created at runtime by an admin filling in a form, and become resources declared in
the repository and created at deploy time. `SesSetting` — the database row that remembers what that
form created — is deleted. What the Worker needs to know about SES becomes a linked resource.

**What it does not change:** domains stay a runtime action (§4), and SES stays the delivery path.

> ## Revision note: the tool recommendation in this document is reversed
>
> The first revision of this document (commit `0659d55`, PR #129) recommended **wrangler for
> Cloudflare and AWS CDK for AWS**, and rejected SST. **That recommendation was wrong.** Its load-
> bearing claim — "no single tool covers both without one of them being wrong" — is false, and two
> of the three supporting arguments were factual errors. §6 now recommends **SST for both clouds**
> and explains what the earlier pass got wrong and how. §2, §5, §7 and §8 are rewritten to match.
> §1, §3 and §4 are unchanged; so is the Neon-branch argument in §2, which was and remains the
> strongest reason to move SES configuration out of the database.
>
> The second decision recorded here, and the one with a real cost: **development now runs against a
> sandbox Cloudflare account.** `apps/web/wrangler.jsonc:9-10` currently promises that "everything
> here runs under `wrangler dev` with no Cloudflare account". Under SST that promise cannot be kept
> in full. §8 states exactly how much of it is lost, how much is recoverable, and at what price.

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
| 1 | SNS topic | `sns.createTopic` (`server/aws/sns.ts:18`), name `${idPrefix}-${region}-unsend` (`ses-settings-service.ts:117`) | random `idPrefix` | `${prefix}-${region}` where `prefix = usesend-{stage}` |
| 2 | SNS subscription, protocol `https` | `sns.subscribeEndpoint` (`sns.ts:33`), endpoint `${usesendUrl}/api/ses_callback` | the URL typed into the form | `${site.url}/api/ses_callback`, a graph dependency |
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
cannot converge — and the Worker has to be told them, which is the whole point (§2). So the names
become a function of the SST stage:

```
prefix = {$app.name}-{$app.stage}     e.g. usesend-production, usesend-clempe
topic  = {prefix}-{region}            e.g. usesend-production-us-east-1
config = {prefix}-{region}-{general|click|open|full}
```

`usesend-production-ap-southeast-4-general` is 41 characters against SES's 64-character limit and
uses only `[A-Za-z0-9_-]`. `$app.stage` is a free-form string, so per-developer stages
(`usesend-clempe-…`) coexist in the same AWS account by construction — which is the isolation the
nanoid used to give by accident, now given on purpose. Two people deploying the same stage name into
one account is the same collision it always was, and the answer is the same: use your own stage.

**This is also the moment the names stop saying "unsend".** Configuration set names are immutable
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

**Decision: one `sst.Linkable` named `Ses`, read through `Resource.Ses` in the Worker.** Not a
generated file, not the database, and — unlike the first revision — not a hand-derived name built
from a `SES_RESOURCE_PREFIX` var plus an `AWS_ACCOUNT_ID` secret.

The first revision proposed this table:

| Name | Kind | Example |
|---|---|---|
| `SES_REGION` | `vars`, per env | `us-east-1` |
| `SES_RESOURCE_PREFIX` | `vars`, per env | `usesend-prod` |
| `AWS_ACCOUNT_ID` | secret, per env | 12 digits |

All three exist only so the Worker can rebuild strings the deploy already knows. Under SST it knows
them as values, so it can simply hand them over:

```ts
// sst.config.ts
const ses = new sst.Linkable("Ses", {
  properties: {
    region,
    topicArn: topic.arn,                       // the real ARN, from the resource
    configurationSets: {
      general: general.configurationSetName,
      click:   click.configurationSetName,
      open:    open.configurationSetName,
      full:    full.configurationSetName,
    },
  },
});
```

```ts
// apps/web/src/utils/ses-utils.ts
import { Resource } from "sst";
const name = Resource.Ses.configurationSets[key];   // pure, synchronous, no derivation
```

Three things follow from that, and two of them are strictly better than the first revision:

1. **`SES_RESOURCE_PREFIX` never exists.** Names are computed once, in `sst.config.ts`, from
   `$app.name` and `$app.stage`, and travel to the Worker as values. Nothing derives a name twice,
   so nothing can derive it differently. The first revision's `sesResourceNames()` shared module and
   the unit test asserting the stack agrees with it both become unnecessary — the class of bug they
   guarded against is structurally absent.
2. **`AWS_ACCOUNT_ID` is not needed at all.** The first revision introduced it as a secret purely so
   `checkEventValidity` could rebuild the topic ARN. `topic.arn` is an output of the resource, so the
   real ARN is linked directly. One fewer secret to set per stage, and no risk of a stage having the
   right prefix and the wrong account.
3. **`getAccountId` (`aws/ses.ts:26`) and its `STSClient` still delete.** Same reasoning as before:
   it calls `GetCallerIdentity` and caches the answer in a module-level `let`, which on Workers is
   per-isolate, so it is a subrequest on every cold isolate — exactly the module-level-state hazard
   §8 of the migration plan warns about. `getIdentityArn` needs the account id too; get it from a
   linked `aws.getCallerIdentity()` output in `sst.config.ts` rather than at runtime.
   `@aws-sdk/client-sts` leaves `apps/web/package.json`.

The two hot-path wins from the first revision are unchanged and are still the point of the whole
exercise:

- **`getConfigurationSetName` stops touching the database and stops being `async`.** Today it is one
  `SELECT` (behind a per-isolate cache that a cold isolate misses) on the hot path of every single
  send. It becomes a property read.
- **`checkEventValidity` (`server/service/ses-callback.ts:130`) compares against `Resource.Ses.topicArn`**
  instead of reading `SesSettingsService.getTopicArns()`. Same removal, on the event ingest path —
  which §12 of the migration plan measures at 78% of request and queue load.

`SES_REGION` survives as an input, but as a value in `sst.config.ts` rather than a Worker var: the
stage's region is what the SES resources are created in, and the Worker receives it as
`Resource.Ses.region`.

### Why a linked resource and not the database: the Neon branch problem

**This argument is unchanged from the first revision and is the strongest thing in this document.**
It is a silent failure and it is live today.

`SesSetting` is a row. The dev and preview databases are **Neon branches** — `docker/dev/compose.yml`
pins `BRANCH_ID` (`:28`), and a branch is a copy-on-write clone of another branch's data. So the SES
configuration **follows the data, not the deployment**.

Restore or branch production into staging and staging silently inherits production's `topicArn`,
production's `callbackUrl` and production's four configuration set names. Staging then sends through
production's configuration sets, production's SNS topic fans the resulting events out to
production's callback URL, and staging's `checkEventValidity` accepts production's topic ARN as its
own. Nothing errors. The first sign is production `EmailEvent` rows for emails production never sent.

A linked resource follows the **deployment**. `sst deploy --stage staging` cannot pick up
production's topic ARN, because the value is an output of the staging stage's own topic resource and
nothing copies it across stages. Moving this out of the database fixes a real bug, not just a
layering complaint. Nothing about SST versus CDK versus Terraform changes this; what matters is only
that the value stops being a row.

### What this replaces in `wrangler.jsonc`

`apps/web/wrangler.jsonc` (456 lines) declares **no environments** — no `env.*` blocks at all
(verified: there is no `"env"` key in the file), and `"vars": {}` at `:455` is empty with a comment
saying deployed values are secrets. The first revision's answer was to add `env.*` blocks, and noted
that this would give each environment its own copy of all 31 queues and 4 Durable Objects.

Under SST that problem disappears rather than being solved: **a stage is the unit of isolation**, and
every resource SST creates is already stage-scoped by name. There are no `env.*` blocks to add
because there is no shared file to add them to. The queue-per-stage multiplication still happens —
`sst deploy --stage staging` really does create 32 more queues — but it happens as a consequence of
`--stage`, not as a structural edit somebody has to review.

**A related cleanup this unlocks.** `SUPPORTED_SES_REGIONS` (`server/queue/ses-regions.ts:21`) lists
thirteen regions and generates 26 send queues, because upstream lets a tenant add any region at
runtime. With the region declared per stage, the list collapses to the region that stage actually
uses — 24 queues and 24 consumers stop being created. The migration plan flags the contents of that
list as "a product decision that has not been made" (§8, leftover 2); this change makes the decision
unnecessary. Do it last (§7, PR G), not first.

---

## 3. What deletes

Every entry below was checked against the code, not inferred. Line numbers are against `main` at
`1d70ab8`. **This section is unchanged from the first revision.**

**Deletes outright**

| Thing | Location | Notes |
|---|---|---|
| `SesSettingsService` | `server/service/ses-settings-service.ts` (whole file, 350 lines) | cache, `getSetting`, `getAllSettings`, `getTopicArns`, `createSesSetting`, `updateSesSetting`, `checkInitialized`, `invalidateCache`, `registerConfigurationSet`, `isValidUsesendUrl` |
| `isValidUsesendUrl` | `ses-settings-service.ts:334` | `fetch`es `{url}/api/ses_callback` and requires 200 before saving — the reason local dev needs a publicly reachable URL or a tunnel |
| `server/aws/sns.ts` | whole file | `createTopic`, `deleteTopic`, `subscribeEndpoint`. **Verified sole importer** is `ses-settings-service.ts:7`. `@aws-sdk/client-sns` leaves `package.json` |
| `ses.addWebhookConfiguration` | `aws/ses.ts:277` | **verified**: four call sites, all in `registerConfigurationSet` |
| `ses.getAccount` | `aws/ses.ts:270` | **verified**: one caller, `getQuotaForRegion` |
| `getAccountId`, `getIdentityArn`, the STS client | `aws/ses.ts:26-45` | replaced by a linked account id (§2) |
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
  `domainSchema` (`:44`). `createDomain` takes `Resource.Ses.region`. ~70 lines, and the dead-end
  that #126 fixed stops being possible rather than being handled.
- **`ses-callback.ts` `handleSubscription` (`:103`)** keeps the `fetch(message.SubscribeURL)` — that
  is what confirms the subscription — and loses the `SesSetting` lookup by `topicArn` (`:109-114`)
  and the `callbackSuccess` write (`:121`). It should gain the topic-ARN check that
  `checkEventValidity` does, which it does not have today. Note that this auto-confirmation is what
  makes `endpointAutoConfirms: true` legitimate in §5.
- **`env.js`**: `AWS_DEFAULT_REGION` (`:143-146`) is currently doing two jobs — a default for the
  admin form and the region for AWS clients. With the form gone it has one job, and that job is now
  `Resource.Ses.region`. It should be deleted rather than renamed. `AWS_SES_ENDPOINT`,
  `AWS_SNS_ENDPOINT` and `AWS_ALLOW_REAL_ENDPOINTS` all stay (§8).

**Does not delete**

- `GENERAL_EVENTS` (`ses-settings-service.ts:38-45`) and its long comment about why `SEND` and
  `SUBSCRIPTION` are excluded. It **moves** to a shared module that `sst.config.ts` imports, so the
  deploy declares the same list the comment describes. That comment is the reasoning behind the
  single biggest cost lever in §12 and must not be lost in a file deletion.
- **The `SesSetting` migration.** The table is in `migrations/0000_baseline.sql:198` with its indexes
  at `:389-390` — the **baseline**, which also creates all 23 other tables. It cannot be edited or
  removed. This needs a **new** migration, `0002_drop_ses_setting.sql`.
  (`0001_email_usage_counted_at.sql` is the only non-baseline migration today.)

**Nothing in the test suite blocks any of this.** There is no `SesSetting` factory, no integration
fixture and no mock of `SesSettingsService` — searched across `src/test/`, all `*.test.ts` and
`*.test.tsx`. The only test mentioning it is `env.public.unit.test.ts`, in a comment. The suite mocks
`~/server/aws/ses` wholesale. (The tests that *do* stand in the way are about `wrangler.jsonc`, not
about SES; see §6.)

---

## 4. Domains: stay runtime

**Recommendation: adding a domain stays a runtime action.** Not close. **This section is unchanged
from the first revision**, and SST does not disturb it — if anything it sharpens the argument, since
`sst.aws.Email` is exactly the "declare the identity" component that does not fit (§6).

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
  key in the IaC program or reading a public key back out as an output and writing it to the
  database anyway. You would have IaC *and* the row.
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

The first revision spent most of this section on a manual runbook: create the Cloudflare resources
wrangler cannot derive, paste their ids into the config, put six secrets, deploy the Worker, then
deploy the AWS stack, in that order, "each step gates the next". Two of those steps exist only
because `wrangler.jsonc` carries `REPLACE_WITH_HYPERDRIVE_ID` (`:53`) and
`REPLACE_WITH_KV_NAMESPACE_ID` (`:75`) and nothing fills them in.

**Under SST that runbook collapses to two commands**, because SST creates the KV namespace, the R2
bucket, the Hyperdrive config and the queues, and knows their ids without anyone pasting anything.

```
sst secret set DatabaseUrl '...' --stage {stage}        # once per stage, per secret
sst deploy --stage {stage}
pnpm db:migrate                                          # against that stage's Neon branch
```

Then sign in, add a domain, publish the DNS records. That is the whole sequence.

### Does the Worker-then-subscription ordering still hold?

**Yes, and it stops being a rule somebody has to follow.** In the first revision the ordering was a
numbered step in a runbook, enforced by the human. Under SST it is a dependency in the Pulumi graph:

```ts
new aws.sns.TopicSubscription("SesCallback", {
  topic: topic.arn,
  protocol: "https",
  endpoint: $interpolate`${site.url}/api/ses_callback`,   // ← depends on `site`
  endpointAutoConfirms: true,
});
```

`endpoint` reads `site.url`, so Pulumi cannot create the subscription until the Worker exists and has
a URL. The ordering is derived from the data, not asserted in prose.

**The first revision's open question is now answered.** It asked whether CloudFormation blocks on
HTTPS subscription confirmation or completes with the subscription `PendingConfirmation`, and said to
settle it by watching a stack event stream. The Pulumi/Terraform AWS provider makes it an explicit
flag: `endpointAutoConfirms` (verified in `@pulumi/aws@7.20.0` `sns/topicSubscription.d.ts:325-327`)
defaults to `false`, and for an HTTP(S) endpoint that value decides whether the provider waits for
the endpoint to confirm. useSend's `handleSubscription` (`ses-callback.ts:103`) does auto-confirm —
it GETs the `SubscribeURL` — so `endpointAutoConfirms: true` is correct here, and the apply blocks
until the subscription is confirmed.

That is the desirable behaviour: a Worker that is deployed but broken fails the deploy instead of
leaving a silently unconfirmed subscription that drops every delivery event. **Residual uncertainty:**
how long the provider waits before giving up, and what the failure reads like. Settle it by deploying
one throwaway stage with `/api/ses_callback` returning 500 and timing the apply — not by reading more
documentation.

### Which Cloudflare resources SST does *not* create

Honest gap, and it is the same class of gap `REPLACE_WITH_*` represented: `@pulumi/cloudflare` does
not cover every Cloudflare product. `petrochem-ai/sst.config.ts` carries a comment recording exactly
this for Vectorize ("Pulumi cloudflare v6 doesn't expose a Vectorize resource yet"), with an
out-of-band `wrangler vectorize create` in its place. useSend uses KV, R2, Queues, Hyperdrive,
Durable Objects and Cron Triggers, all of which `@pulumi/cloudflare` covers — but the pattern to
expect is "an out-of-band create plus a comment", not "SST covers everything".

---

## 6. Tool evaluation

### The first revision's recommendation, and why it was wrong

The first revision recommended **wrangler for Cloudflare, AWS CDK for AWS — two tools, on purpose**,
and justified it with one sentence: *"No single tool covers both without one of them being wrong."*

That sentence is false, and the three arguments under it fail as follows.

**Error 1 — "SST is rejected on a primary source."** The quoted source was real (`sst.dev/docs/cloudflare/`:
"Do not include any Wrangler configuration files… SST manages these for you"), but it was read as a
pure cost. It is not a cost, it is the mechanism: SST generates the wrangler config *because* it
holds the resource ids, which is the same reason `REPLACE_WITH_HYPERDRIVE_ID` exists in the
hand-maintained file and has to be filled in by a human. The first revision treated deleting
`wrangler.jsonc` as a risk to be avoided and never priced the thing that deletion buys.

**Error 2 — the proportion argument counted the wrong thing.** "A large, risky rewrite of the part
that works, bought in order to declare ten AWS resources." But SST does not only declare the ten AWS
resources; it also removes `SES_RESOURCE_PREFIX`, `AWS_ACCOUNT_ID`, the `sesResourceNames()` shared
module, the synth-output unit test that revision proposed, the `REPLACE_WITH_*` paste step, and the
`env.*` blocks §2 was about to add to `wrangler.jsonc`. §2 above is measurably smaller than the §2 it
replaces. That is not a rounding error against ten resources.

**Error 3 — an unverified claim about Durable Objects, which was version-bound.** The first revision
said SST's `platform/src/components/cloudflare/` exports `durable-object`. It does — **now**. The
working reference project at `/home/clempe/Projects/petrochem-ai` pins SST **4.14.1**
(`pnpm-workspace.yaml:11`) and at that version there is no `durable-object.ts` in that directory at
all. It first appears in **4.15.0**: verified by listing
`github.com/anomalyco/sst/platform/src/components/cloudflare` at `v4.14.3` (absent) and `v4.15.0`
(present). The first revision happened to state the right conclusion from the wrong evidence, which
is why the version floor below matters.

### Recommendation: **SST, for both clouds**

One TypeScript program at the repo root declaring the Cloudflare Worker, its bindings, its queues and
its crons, *and* the SNS topic, its subscription and the four SES configuration sets. `home:
"cloudflare"` for state, with the `aws` provider added alongside (`platform/src/config.ts:220`
declares `providers?: Record<string, any>` independently of `home`).

**Version floor: SST ≥ 4.15.0. Do not pin 4.14.1.** The reference project's pin is not a
recommendation, it is where that project happens to be. At 4.14.1:

- `sst.cloudflare.DurableObject` does not exist, and useSend has four DO classes
  (`src/worker/{campaign-scheduler,idempotency-keeper,rate-limiter,webhook-dispatcher}.ts`).
- `sst.cloudflare.Worker` has no `migrations` field, and useSend has three migration tags
  (`wrangler.jsonc:118-131`).

Latest at time of writing is **4.17.1**. Take the latest; the floor is 4.15.0.

**What the evidence for SST actually is.** `/home/clempe/Projects/petrochem-ai` is a working
SST + Cloudflare deployment with the same stack shape as useSend's target: `sst.cloudflare.TanStackStart`
for the app, `sst.cloudflare.Queue` with `.subscribe()`, `sst.cloudflare.Bucket` for R2, Neon behind a
secret, better-auth, per-stage secrets, `home: "cloudflare"`, and `$app.stage` driving
domain-versus-`workers.dev` selection. It is not a proof by documentation.

### How SST handles Durable Object migrations, and why that is the good news

`sst.cloudflare.DurableObject` (`platform/src/components/cloudflare/durable-object.ts` at v4.17.1)
takes only `className` and contributes a `durableObjectNamespaceBindings` link. The migration history
lives on the Worker, in a `migrations` field that takes **Wrangler's ordered array verbatim** — the
same `[{tag, newSqliteClasses}, …]` shape as `wrangler.jsonc:118-131`.

SST then reimplements Wrangler's reconciliation, correctly (`cloudflare/worker.ts:705-785`):

1. `GET /accounts/{id}/workers/scripts`, find this script, read its `migration_tag`.
2. Treat error codes `10090` (service not found) and `10092` (environment not found) as "first
   deploy, no remote tag" and rethrow anything else — the same suppression Wrangler does.
3. If the deployed tag is already the last tag in the array, send `migrations: undefined`. **No
   no-op migration is uploaded.**
4. Otherwise send `{oldTag: currentTag, newTag: latest.tag, steps: migrations.slice(foundIndex + 1)}`
   — and if the deployed tag is not in the array at all (`foundIndex === -1`), send every step with
   the deployed tag as `oldTag`, so the server rejects rather than the client guessing.
5. On a first deploy send `{newTag, steps: <all>}` with `migrationTag: ""` and no `oldTag`.

That is the whole algorithm, and it is why Durable Objects are first-class on current SST rather than
something to work around.

### Rejected alternative: `transform.worker`

**This is the most valuable finding in this section, because it is the approach a reader will reach
for first and it does not work.** A spike proved two independent hazards.

**Hazard 1 — the object form of `transform` is a shallow spread.** SST's `transform()` helper
(`platform/src/components/component.ts:34-49`) is:

```ts
if (typeof transform === "function") { transform(args, opts, name); return [name, args, opts]; }
return [name, { ...args, ...transform }, opts];
```

`bindings` is a **top-level key** of the args object SST passes to `cf.WorkersScript`
(`cloudflare/worker.ts:853`), computed from the component's links. So
`transform: { worker: { bindings: [...] } }` does not merge into that array, it **replaces** it. In
the spike that silently removed `SST_RESOURCE_App` (the var that carries `$app.name`/`$app.stage`,
`worker.ts:585-595`), the R2 bucket, the queue and the KV namespace. Nothing errors; the bindings are
simply gone, and the failure surfaces at runtime as `undefined` bindings.

The general rule this yields, and the reason `transform` is not useless: **the object form is safe
only for keys the component does not itself compute.** `sst.cloudflare.TanStackStart` never sets
`migrations` on its inner Worker (`ssr-site.ts` builds `{environment, link, url, dev, domain,
handler, assets}`), so `transform: { server: { migrations: [...] } }` *is* additive and safe. The
function form (`(args) => { args.bindings.push(...) }`) is safe for anything.

**Hazard 2 — `WorkersScriptArgs.migrations` is not Wrangler's ledger.** It is a stateful wire delta.
Verified in `@pulumi/cloudflare@6.20.0` (`types/input.d.ts:15935-15963`): `WorkersScriptMigrations`
is `{oldTag?, newTag?, steps?, newClasses?, newSqliteClasses?, deletedClasses?, renamedClasses?, …}`,
and `oldTag` is documented as *"Tag used to verify against the latest migration tag for this Worker.
If they don't match, the upload is rejected."*

So pasting `wrangler.jsonc`'s static three-entry array through `transform.worker.migrations` fails in
two different ways depending on the stage:

- Against a stage whose deployed tag is already `v3`, the upload is rejected with
  `Actor migration tag precondition failed` (HTTP 412).
- Against a **fresh** stage there is no deployed tag, the static block's `oldTag` does not match,
  and the older classes never get their namespaces created — Cloudflare then rejects the bindings
  with code **10061**, because the script binds DO namespaces that do not exist.

There is no single static value that is correct for both. Correctness requires reading the deployed
tag first, which is precisely what `worker.ts:705-785` does. **Use the first-class component.**

### What SST does *not* give useSend, stated up front

Recommending SST is not the same as claiming it covers this app's shape. Four gaps, all verified
against v4.17.1 source, all with the same remedy — drop to the raw Pulumi resource inside `run()`,
which SST is designed to allow:

| Gap | Evidence | Remedy |
|---|---|---|
| `sst.aws.Email` is **one identity + one configuration set, 1:1** | `aws/email.ts:352-456` — the identity's `configurationSetName` is the set it just created | Don't use it. useSend needs four standalone configuration sets over one topic, and its identities are runtime (§4). Use `@pulumi/aws` `sesv2.ConfigurationSet` + `sesv2.ConfigurationSetEventDestination` directly |
| `sst.aws.SnsTopic` has **no HTTPS subscriber** | `aws/sns-topic.ts` — `subscribe()` returns `SnsTopicLambdaSubscriber`, `subscribeQueue()` is SQS. Those are the only two | `aws.sns.TopicSubscription` with `protocol: "https"` (§5) |
| `Queue.subscribe()` **always builds a new Worker** | `cloudflare/queue.ts:243-269` takes `string \| WorkerArgs` and hands it to `workerBuilder` (`queue-worker-subscriber.ts:135-142`); there is no "point at an existing Worker" form | useSend has **one** Worker with a `queue` handler serving all 32 consumers (`src/server.ts:49-55`). Create `cloudflare.QueueConsumer` directly, with `scriptName` from `site.nodes.server.nodes.worker.scriptName` and `queueId` from `queue.nodes.queue.id` |
| `sst.cloudflare.Cron` **also builds its own Worker** | `cloudflare/cron.ts:167-178` — `workerBuilder`, then `WorkersCronTrigger` with that script's name | useSend's six crons are the one Worker's `scheduled` handler (`src/server.ts:57-63`). Create `cloudflare.WorkersCronTrigger` directly against the site's script name |

The shape of the resulting `sst.config.ts` is therefore: SST components for the site, the bucket, the
KV namespace, Hyperdrive, the queues themselves and the four Durable Objects; raw `@pulumi/cloudflare`
for the queue consumers and cron triggers; raw `@pulumi/aws` for everything SES and SNS. That is a
real cost and it should be visible before anyone starts, not discovered in week two. It is still much
less than maintaining two tools and a 456-line hand-kept config.

### The tests that read `wrangler.jsonc`

The first revision used these as an argument *against* SST. They are now a cost to plan for, and the
first revision **undercounted them**: it named two test files. There are **three**.

| File | Reads | Asserts |
|---|---|---|
| `server/queue/queue-registry.unit.test.ts` | `queues.producers`, `queues.consumers` | 4 tests (`:78`, `:92`, `:105`, `:132`): every registered queue has a producer binding in order; every consumer's `max_batch_size` / `max_batch_timeout` / `max_retries` / `max_concurrency` / `dead_letter_queue` matches the registry; the DLQ consumes itself with `max_retries: 0`; no consumer exists that is not in the registry |
| `server/queue/cron-registry.unit.test.ts` | `triggers.crons` | 1 test (`:60`): the sorted cron list equals `CRON_EXPRESSIONS`, bidirectionally |
| `server/binding-registry.unit.test.ts` | `kv_namespaces`, `durable_objects`, `migrations` | 4 tests (`:27`, `:33`, `:41`, `:52`): KV bindings match `KV_BINDINGS`; DO binding→class map matches `DURABLE_OBJECT_BINDINGS`; every DO class is covered by exactly one migration entry; every migration tag is distinct |

All three go through `src/test/wrangler-config.ts` (93 lines: a hand-written JSONC stripper written
because a regex eats the `postgresql://` inside `localConnectionString`). Nothing in production code
reads it.

**Concretely, what happens to them.**

1. **`sst.config.ts` imports the registries and loops.** `QUEUES`, `CRON_EXPRESSIONS`,
   `KV_BINDINGS` and `DURABLE_OBJECT_BINDINGS` stay exactly where they are and become the input to
   the IaC program:

   ```ts
   import { QUEUES, DEAD_LETTER_QUEUE_NAME } from "./apps/web/src/server/queue/queue-registry";
   for (const q of QUEUES) { /* new sst.cloudflare.Queue(...) + a QueueConsumer */ }
   ```

   The moment that happens, **the bug these tests exist to catch becomes unrepresentable.** A queue
   in the registry and not in the deploy config cannot occur, because there is only one list. This is
   strictly better than a test, and it is the single strongest practical argument for SST in this
   repo — better than anything in the "two tools" framing it replaces.

2. **Delete the config-reading tests in `queue-registry.unit.test.ts` and `cron-registry.unit.test.ts`.**
   That is the whole `describe("wrangler.jsonc agrees with the registry")` block (4 tests) and the
   one test at `cron-registry.unit.test.ts:60`. They assert a hand-copy that no longer exists. The
   other five and four tests in those files are registry-only and are unaffected — including
   `queue-registry.unit.test.ts:113`, which despite sitting in that describe block never reads the
   config.

3. **Keep the substance of `binding-registry.unit.test.ts:41` and `:52`, re-pointed.** "Every DO
   class is covered by exactly one migration entry" and "every migration tag is distinct" are *not*
   made unrepresentable by SST: the migration array is still a hand-maintained, append-only history,
   and getting it wrong is exactly what §6's Hazard 2 punishes. Move that array out of
   `wrangler.jsonc` into `src/server/durable-object-migrations.ts`, export it, have `sst.config.ts`
   pass it to `Worker.migrations`, and have the test import it directly. No file parsing. The two
   tests at `:27` and `:33` (KV and DO bindings) fall to argument 1 and delete.

4. **`src/test/wrangler-config.ts` deletes entirely**, along with `parseJsonc`. It has no other
   consumer.

Net: one new 30-line module, two tests kept with their file-reading removed, seven tests deleted
because what they guarded is now structural, 93 lines of JSONC parser deleted.

### Where `wrangler.jsonc`'s commentary goes

Roughly 90 of the file's 456 lines are explanatory comments, and the first revision was right that
this is design documentation rather than decoration. It does not all have one destination:

| Block | Lines | Goes to |
|---|---|---|
| Why JSONC over TOML | 1–8 | **Dies with the file.** It argues for a file format that no longer exists. Nothing is lost |
| No Cloudflare account needed | 9–10 | **Dies, and is replaced by its opposite** — §8, and AGENTS.md's "Running the Worker locally" |
| One Worker carries everything | 16–21 | `sst.config.ts`, on the `TanStackStart` component. Still true and still the thing a reader needs first |
| `nodejs_compat`, and why `process.env` gets populated | 25–28 | `sst.config.ts`, on the worker's `compatibilityFlags`. Load-bearing for `src/env.js` |
| Hyperdrive `localConnectionString` ↔ `.env.example` | 33–49 | **AGENTS.md**, "Running the Worker locally". Under SST this becomes the `WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` escape hatch it already names at 44–49, which is now the primary mechanism rather than the fallback (§8) |
| R2 replaces the S3 client | 58–59 | `sst.config.ts`, on the `Bucket` |
| **KV is not idempotency** | 68–71 | `server/binding-registry.ts`, next to `KV_BINDINGS`. It explains a *code* decision, not a config one, and it is better placed there than it is today |
| Why each DO exists (`CAMPAIGN_SCHEDULER` sub-minute alarms, `RATE_LIMITER` not the rate-limit binding, `IDEMPOTENCY_KEEPER` not KV) | 79–113 | `server/binding-registry.ts`, next to `DURABLE_OBJECT_BINDINGS`. Same reasoning |
| SQLite-backed storage is the only option | 116–117 | `server/durable-object-migrations.ts`, the new module from the previous subsection |
| **The scheduler's deliberate absence from the cron list** | 133–140 | `server/queue/cron-registry.ts`. It already says that file is the source of truth; this makes it so |
| Per-cron trailing comments | 143–148 | `server/queue/cron-registry.ts`, per entry |
| Queue settings are deploy-time-only | 152–163 | `server/queue/queue-registry.ts` |
| `vars` are secrets, nothing committed | 453–454 | **Dies**, replaced by `sst secret set` |

The pattern: **the commentary that explains a code decision moves into the code**, where it is closer
to what it describes and harder to lose. Only the two blocks about the file's own existence die. Do
this move as its own commit inside PR B so it is reviewable as a move rather than buried in a delete.

### The three fixture wrangler configs stay

`apps/web/` has **four** `wrangler*.jsonc` files, not one. `wrangler.compat-check.jsonc`,
`wrangler.queue-check.jsonc` and `wrangler.binding-check.jsonc` back `pnpm compat:check`,
`queue:check` and `bindings:check` (ports 8790–8792). AGENTS.md:247: "All three are fixture Workers
with their own `wrangler.*.jsonc` and are never deployed."

They are unaffected. SST's "do not include wrangler config files" rule is about the file
`@cloudflare/vite-plugin` *discovers*; the fixtures are passed explicitly with `-c` and are the only
remaining users of plain `wrangler dev` in the repo. Say so in AGENTS.md when the main config goes,
or somebody will delete them on sight.

### The alternatives, re-judged

- **AWS CDK (the first revision's recommendation) — rejected.** Its best argument was "CloudFormation
  holds the state, no backend to provision". SST's `home: "cloudflare"` holds the state too, in an R2
  bucket it creates, and it does so for *both* clouds. CDK's cost was always `cdk bootstrap` (a
  `CDKToolkit` stack, an S3 bucket, five IAM roles) plus tens of megabytes of `aws-cdk-lib`, and none
  of that buys anything on the Cloudflare side.
- **Terraform / OpenTofu — still viable, still second.** Mature providers on both sides. The state
  backend objection stands, and so does the sharper one: HCL cannot import `queue-registry.ts`. The
  argument in "The tests that read `wrangler.jsonc`" above — that a TypeScript IaC program consuming
  the registries makes a whole class of bug unrepresentable — is exactly what a language boundary
  costs you.
- **Alchemy — not yet, for the same reason as before.** Wide Cloudflare and AWS coverage and
  `alchemy dev` runs workerd with local simulators, which would address §8 head-on. It is still
  `2.0.0-beta`. Revisit if §8's dev-config friction proves worse in practice than it looks on paper —
  that is the one thing that would make it worth the beta.
- **wrangler + an idempotent script — still the honest baseline, still not the pick.** Every
  operation in `createSesSetting` already converges: `CreateTopic` is idempotent by name, `Subscribe`
  by (topic, protocol, endpoint), `CreateConfigurationSet` throws `AlreadyExists` which you catch.
  Zero new tooling. What it still does not give you is **delete**: rename a set or retire a stage and
  the old resources stay in the account forever, unreferenced and indistinguishable from live ones.

**Out of scope, flagged (unchanged):** the IAM user and policy the Worker's SES credentials belong to
are not in this design. They could be — an IAM policy scoped to `{prefix}-{region}-*` configuration
sets would be a genuine security improvement over a broad SES policy — but the access key itself must
not be an IaC output. If it is added, create the key out of band and `sst secret set` it. Note that
`sst.cloudflare.Worker` will happily mint and inject AWS credentials for you
(`worker.ts:853-872` injects `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` from `iamCredentials`); that
path is worth evaluating separately and is not assumed here.

### A future simplification, not a plan

Cloudflare now documents a **declarative `exports` map** as the successor to the imperative
`migrations` array:

```jsonc
"exports": { "WebhookDispatcher": { "type": "durable-object", "storage": "sqlite" } }
```

No tags, no ordering, no preconditions — the whole class of problem in Hazard 2 above disappears. The
Cloudflare docs say the `exports` field "replaces the imperative `migrations` array used by older
Workers" and has moved the old reference page to `durable-object-class-migrations-legacy`, while
noting both flows remain supported and a Worker can use only one at a time. Wrangler **4.134.0**
supports it (verified in that release's `config-schema.json`: `RawConfig.exports` → `Exports` →
`ConfiguredExport` → `DurableObjectExport` with a `DurableObjectExportStorage` enum of
`sqlite | legacy-kv`).

**It is not reachable from SST today.** `@pulumi/cloudflare@6.20.0` does expose an `exports` field on
`WorkersScript`, but its type is only `{type, cache?}` (`types/input.d.ts:15909-15918`) — there is no
`storage`, no `state`, no `renamedTo`, so a `durable-object` export cannot be declared through it. The
full DO lifecycle is on **`WorkerVersion`** (`WorkerVersionExports`, `types/input.d.ts:15399+`),
which is not the resource SST's Worker uses. And SST v4.17.1 pins `@pulumi/cloudflare` **6.15.0**
(`platform/package.json`), a further step back.

So: note it, do not plan around it. Two things would have to happen first — Pulumi exposing DO
exports on `WorkersScript`, and SST switching to `WorkerVersion` or picking that field up. When they
do, `durable-object-migrations.ts` and the two tests kept above become deletable.

---

## 7. Migration path

There is no production deployment and no users, so this does not need to be reversible in operation
— but every PR must leave `main` working, which is the same constraint Phase 7 met by keeping
Next.js serving until the last PR (§9 of the migration plan). Stack each branch on the previous one.

**This is a bigger change than the first revision's A–F, and the reason is that it now contains a
change that has nothing to do with SES.** Adopting SST for the Cloudflare side deletes
`apps/web/wrangler.jsonc`, re-points `vite.config.ts` and reworks three test files. That work is
independent of everything in §1–§5 and should not be reviewed alongside it.

| PR | Change | Risk |
|---|---|---|
| **A** | `sst.config.ts` at the repo root, declaring the Cloudflare side only, generated by looping over `queue-registry.ts`, `cron-registry.ts` and `binding-registry.ts`. New `src/server/durable-object-migrations.ts`. `sst` in `devDependencies` at **≥ 4.15.0**. **Nothing consumes it and `sst deploy` is never run.** `wrangler.jsonc` still drives the app | None. Additive. The whole point is that this is reviewable as "does this program describe the same Worker the file does" |
| **B** | Cut over. `vite.config.ts` gains `configPath: process.env.SST_WRANGLER_PATH`; `apps/web/wrangler.jsonc` is deleted; the commentary moves per §6's table; the seven config-reading tests go and two move to the new module; `src/test/wrangler-config.ts` deletes; the dev overlay from §8 lands; AGENTS.md is rewritten for `sst dev` | **The largest PR here and the only one that can break local development for everyone.** Not revertable in practice once anyone has re-onboarded. Land it with a working `sst dev` demonstrated, not just a green suite |
| **C** | The AWS half of `sst.config.ts`: topic, HTTPS subscription, four configuration sets and their event destinations, the `Ses` linkable, the `$dev` branch (§8). `GENERAL_EVENTS` moves to the shared module. Nothing in the app reads `Resource.Ses` yet | Low. Additive to a program that already deploys |
| **D** | Flip the readers. `getConfigurationSetName` becomes pure and synchronous; `checkEventValidity` and `handleSubscription` use `Resource.Ses.topicArn`; `createDomain` drops the `getSetting` lookup and takes `Resource.Ses.region` | **The only PR that changes send-path behaviour**, and it is three functions. Revertable by reverting one commit |
| **E** | Delete the onboarding: six server functions, `getAvailableRegions`, five query factories, four admin components, `admin/index.tsx`, the `_dashboard.tsx` gate, the `-add-domain.tsx` region machinery, `aws/sns.ts`, `getAccount`, `addWebhookConfiguration`, `SesSettingsService`. Decide `/admin`'s fate (§3) | Wide but mechanical. The table still exists and is still readable |
| **F** | `0002_drop_ses_setting.sql`, `schema.ts`, `types/db.ts` | Irreversible in data terms — which is why it is last and separate |
| **G** | Shrink `SUPPORTED_SES_REGIONS` to the declared region | Independent of A–F. Can be skipped or deferred indefinitely |

**The ordering that matters:** A before B (describe before cut over); B before C only because C's
`$dev` branch wants somewhere to live; D before E (all readers moved before any writer is deleted);
E before F (code before schema). The domain rollback fix from §4 is orthogonal and can land at any
point.

**Mid-way state is coherent at every step.** After D the admin form still works and still writes rows
— it just writes rows nobody reads, which is a harmless no-op, not a divergence.

**If B looks too big, the split is horizontal, not vertical:** land the commentary move and the new
`durable-object-migrations.ts` as B1 against the still-present `wrangler.jsonc` (with the existing
tests re-pointed at the new module and still passing), then delete the file in B2. Do not split B by
resource type — a half-SST, half-wrangler config is the one state that is genuinely hard to reason
about.

---

## 8. Local development: the offline guarantee ends

This section is a rewrite, and it records a **cost the user has accepted**, not an open question.

`apps/web/wrangler.jsonc:9-10` says:

> Everything here runs under `wrangler dev` with no Cloudflare account: KV, R2 and Hyperdrive are all
> simulated locally. See AGENTS.md.

AGENTS.md:70 says the same thing more strongly: "No Cloudflare account and no `wrangler login` are
needed… Only `wrangler deploy` needs an account." **Every phase of the serverless migration was
verified offline that way.** Under SST that is no longer true in full.

**Decision: accept it. Development runs `sst dev` against a sandbox Cloudflare account**, separate
from the account that will hold staging and production, with each developer on their own stage.

### Exactly what is lost, and why

SST hands `@cloudflare/vite-plugin` a config it generates at `.sst/wrangler/<stage>/<Name>.jsonc`,
via `SST_WRANGLER_PATH` (`cloudflare/ssr-site.ts:157-205`). That generator is
`cloudflare/helpers/wrangler.ts`, and it is 222 lines with a twelve-case switch. Two properties of it
are the whole problem, and both were verified in source at **v4.17.1** and against the real generated
file at `petrochem-ai/.sst/wrangler/clempe/Admin.jsonc`:

1. **It emits no Durable Objects at all.** The twelve handled binding kinds are `aiBindings`,
   `kvNamespaceBindings`, `secretTextBindings`, `plainTextBindings`, `serviceBindings`,
   `queueBindings`, `r2BucketBindings`, `d1DatabaseBindings`, `hyperdriveBindings`,
   `versionMetadataBindings`, `workflowBindings`, `rateLimitBindings`
   (`helpers/wrangler.ts:74-145`). `durableObjectNamespaceBindings` — the kind
   `sst.cloudflare.DurableObject` contributes (`durable-object.ts:130`) — is **not among them**. The
   deploy path handles it fine (`worker.ts:614` maps it to `durable_object_namespace`); only the
   generated config does not. So under `sst dev`, `env.WEBHOOK_DISPATCHER` and the other three are
   not remote — they are *absent*.
2. **Every remote-backed binding it emits carries `remote: true`**, hard-coded:
   `kv_namespaces` (`:84`), `r2_buckets` (`:109`), `queues.producers` (`:102`), `services` (`:95`),
   `ai` (`:77`), `d1_databases` (`:116`), `workflows` (`:136`). **`hyperdrive` is the exception**
   (`:119-123` emits `{binding, id}` with no `remote`). The real file confirms it: three bindings,
   all `remote: true`, no `durable_objects` block.
3. **It emits queue producers but no consumers.** `queues.producers` is set (`:167-171`); there is no
   `queues.consumers` branch. SST's model is one consumer Worker per queue, built by
   `Queue.subscribe()`; useSend's model is one Worker with a `queue` handler for all 32.

So a naive `sst dev` on useSend gives you: four missing Durable Object bindings, remote KV and R2, a
producer that enqueues into a real Cloudflare queue, and **nothing consuming it**, because the
consumer script for that stage was never deployed. That is not "development against real resources",
it is a partly non-functional app.

### What the sandbox account actually buys, and what it does not

Worth separating, because the answer is narrower than "we now need an account for everything":

| Binding | Under `sst dev` | Can it be local? |
|---|---|---|
| R2, KV | Real, `remote: true`, hard-coded | **No.** Would need SST to stop hard-coding it |
| Queues | Real producer, no consumer | **No**, not without an overlay |
| Hyperdrive | `{binding, id}`, no `remote` | **Yes** — `WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` still points at Neon Local on 54320, which is exactly the escape hatch `wrangler.jsonc:44-49` and AGENTS.md:88-95 already document. Neon Local is unaffected by any of this |
| Durable Objects | Absent | **Yes, in principle.** DO classes in the same script are simulated by workerd with no account. The obstacle is a ten-line omission in a generator, not a Cloudflare limitation |

That last row is the important one and the brief version of this story understates it: **the Durable
Object gap is a generator omission, not a property of remote development.** Adding a
`durableObjectNamespaceBindings` case to `createWranglerConfig` that emits
`durable_objects.bindings` plus the `migrations` array would restore full local DO simulation. That
is worth upstreaming to `anomalyco/sst` and is the cleanest long-term fix.

**Until then, ship a dev overlay.** A small Vite plugin, ordered before `cloudflare()`, that reads
`process.env.SST_WRANGLER_PATH`, merges in `durable_objects`, `migrations` and `queues.consumers`
from the same three registries `sst.config.ts` uses, and writes the merged file back before the
Cloudflare plugin reads it. ~40 lines. It is also where `wrangler.jsonc`'s ~290 mechanical lines
actually go: they are *generated* from the registries rather than copied, which is the same win as
§6's argument 1.

Whether that overlay should also strip `remote: true` from KV and R2 is a judgement call. **Recommend
leaving them remote:** that is the behaviour the sandbox account was accepted for, it catches
binding-shape mistakes that local simulation hides, and mixing local DOs with remote R2 is an
unusual configuration to be debugging. Strip it only if R2 latency makes the dev loop painful.

### What happens to `local-ses-sns` and `docker/dev/compose.yml`

**Recommendation: both stay, unchanged.** A sandbox *Cloudflare* account says nothing about AWS, and
three separate things argue against real SES in development:

1. **SES sandbox is a real constraint, not a billing one.** A fresh SES account can only send to
   verified addresses. The simulator has no such restriction, which is why the end-to-end loop works
   at all.
2. **The SNS subscription cannot confirm against `sst dev`.** `sst.cloudflare.TanStackStart` runs the
   site as a **local** dev server under `sst dev` (`ssr-site.ts:99-121`: `command` defaults to
   `npm run dev`, `autostart: true`). There is no public URL for SNS to POST a
   `SubscriptionConfirmation` to. Creating real SES resources for a dev stage would therefore hang
   the apply on `endpointAutoConfirms` (§5) or leave an unconfirmed subscription — either way the
   loop does not close.
3. Every identity created is real and billable, in whatever account the credentials belong to.

So `sst.config.ts` gates its AWS half on `$dev` and substitutes a simulator-shaped `Ses` link:

```ts
const ses = $dev
  ? new sst.Linkable("Ses", { properties: {
      region: "us-east-1",
      topicArn: "arn:aws:sns:us-east-1:000000000000:usesend-local-us-east-1",
      configurationSets: { general: "usesend-local-us-east-1-general", /* … */ },
    }})
  : /* the real topic, subscription and four configuration sets */;
```

`Resource.Ses` then has the same shape in both worlds, and no code branches on the environment.

**`AWS_ALLOW_REAL_ENDPOINTS` becomes more important, not less** (#126, PR #127). Two reasons:

- The names are now deterministic, so a dev stage's configuration set names *look* valid. Point a
  dev Worker at real AWS with `usesend-clempe-us-east-1-general` and SES rejects the send with
  "configuration set does not exist" — a clean failure. But `SendEmail` against a real account is
  still a real, billable identity away from working, and the guard is the thing standing between
  "I set my own credentials for one experiment" and a live send.
- Its mechanism survives the change intact. `env.js:14-33` decides the *shape* of the schema before
  parsing: `realAwsAllowed` is `NODE_ENV === "production" || AWS_ALLOW_REAL_ENDPOINTS === "true"`,
  and when false, `AWS_SES_ENDPOINT` and `AWS_SNS_ENDPOINT` become **required**. Note the precise
  claim, because it is easy to overstate: the parsed value of `AWS_ALLOW_REAL_ENDPOINTS` is never
  read by anything (`env.js:133-141` says so explicitly); it is declared so the one variable that can
  point local dev at a billable account is documented rather than hidden in a conditional. Nothing in
  this design touches that, and nothing should.

Note the cosmetic defect if you go editing that file: the compose service key is `local-sen-sns`
(`docker/dev/compose.yml:37`) while its `container_name` is `local-ses-sns` (`:39`).

### What still gets better

The first revision's gains here are real and survive:

- **`isValidUsesendUrl` goes, and with it the reachability requirement.** Today `createSesSetting`
  refuses to save unless `{url}/api/ses_callback` returns 200 *to the app*, while SNS separately
  confirms by POSTing *to the container's view of the same URL*. `localhost` is the container itself,
  so AGENTS.md:138-145 documents using the Docker bridge address (`172.17.0.1:8788`), running the dev
  server with `--host`, and opening the bridge in `ufw`. All of that exists to satisfy a check in a
  form that no longer exists.
- **The "SES setting must exist before a domain can" gate goes** (AGENTS.md:133-137). No `/admin`
  visit, no `ADMIN_EMAIL` on a cloud-flavoured local install, no full-screen onboarding form before
  the dashboard renders (`_dashboard.tsx:85`).
- **The subscription was never what wired the callback locally.** The simulator posts to
  `WEBHOOK_URL` from `compose.yml:48`, a fixed environment variable. Deleting `sns.subscribeEndpoint`
  removes a step that was already a no-op here.

Net, AGENTS.md's six-step "getting to a first send" collapses to "`sst dev`, sign in, add a domain" —
at the price of `sst dev` needing an account. That is the trade, stated plainly.

### Still broken, still not ours

`GetEmailIdentity` against the simulator fails to deserialise (ISO-8601 where SESv2 specifies epoch
seconds), so **Verify domain** still fails locally and `Domain.status` still has to be set by hand
(AGENTS.md:149-155). Upstream image, `:latest`, no source here. This design does not touch it — but
note that §4's compensating-action fix depends on that call, so it cannot be exercised locally until
it is fixed.

### One thing to check, unchanged

**Does the simulator reject a `SendEmail` whose `ConfigurationSetName` it has never seen?** PR #127's
end-to-end run created the four configuration sets through the admin form first, so the question was
never asked. With the form gone, nothing creates them locally.

- If the simulator ignores unknown configuration set names: nothing to do.
- If it rejects them: ship a ~20-line seed calling `CreateConfigurationSet` against `localhost:5350`
  with the same names the `$dev` linkable declares. Under SST it has a natural home:
  `sst.x.DevCommand`, alongside the `docker compose up` that `petrochem-ai` already runs that way.

Settle it by sending one email against the container with a made-up configuration set name. **Ship
the seed either way** — it costs almost nothing and it keeps local and deployed parity explicit
rather than accidental.

Finally: `checkEventValidity` short-circuits on `NODE_ENV === "development"` (`ses-callback.ts:132`),
so the topic ARN is never checked locally. Cover the comparison with a unit test rather than assuming
a local run exercises it.
