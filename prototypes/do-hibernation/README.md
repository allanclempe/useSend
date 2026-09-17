# Durable Object residency probe

Throwaway prototype for [#7](https://github.com/allanclempe/useSend/issues/7). Not part of the
app, not deployed, not in the pnpm workspace. It exists to answer one question before the Phase 8
scheduler design is committed:

> The campaign scheduler ticks every 1.5s (`SCHEDULER_TICK_MS`,
> `apps/web/src/server/jobs/campaign-scheduler-job.ts`). As a Durable Object alarm, does the object
> get evicted from memory between ticks, or does it sit resident?

Durable Object *duration* is billed in GB-s of wall-clock time. A scheduler DO that is resident and
ineligible for hibernation burns ~332,000 GB-s/month — 83% of the 400,000 GB-s included on Workers
Paid, at zero email volume. One that hibernates between alarms is ~11,000 GB-s. See
`references/serverless-migration.md` §12.

## Running it

```sh
cd prototypes/do-hibernation
pnpm install --ignore-workspace   # --ignore-workspace: this is not a workspace package
pnpm experiment                   # ~13 minutes, prints a table, writes results/<runId>.json
```

One scenario at a time:

```sh
pnpm experiment -- --scenarios=tick-1500,baseline-15000,open-socket-15000
PROBE_VERBOSE=1 pnpm experiment   # stream the Worker's own logs too
```

`run.mjs` boots `wrangler dev` in local mode — real `workerd`, **no Cloudflare account, no login,
no deploy** — alongside two throwaway servers: an HTTP stub standing in for the Neon query the
alarm handler makes, and a TCP sink the `open-socket` scenario holds a connection to. Then it runs
each scenario and prints a residency table.

## How residency is measured

Each DO instance mints an `instanceId` in its constructor and keeps an in-memory count of the
alarms *it* has handled. Every alarm appends an observation to DO storage.

- One `instanceId` across every alarm → the object never left memory.
- A fresh `instanceId` per alarm → it was evicted and re-constructed each time.

The alarm handler stands in for a real scheduler tick: a subrequest for the "which campaigns are
due" query, plus an enqueue subrequest on every tenth tick. The scenario (mode and interval) is
carried in the DO's name so a re-constructed instance knows which variant it is without a storage
read racing the constructor.

The runner only polls `/report` *after* a scenario's alarms should be done — polling mid-run would
itself be a request to the DO, which would keep it resident and destroy the measurement.

## Scenarios

| Scenario | What it asks |
|---|---|
| `tick-1500` | The real thing: 40 alarms at the production 1.5s cadence. |
| `interval-3000` … `interval-11000`, `control-30000` | Where does eviction start? Brackets the documented 10s inactivity threshold. |
| `baseline-15000` | Reference point for the variants below: plain, at an interval that does evict. |
| `open-socket-15000` | Does a held-open outbound TCP socket pin the object? **A pooled Postgres connection to Neon is exactly this.** |
| `pending-fetch-15000` | Does an in-flight unawaited `fetch()` pin it? |
| `set-timeout-15000` | Does a pending `setTimeout` pin it? |
| `set-interval-15000` | Does a `setInterval` heartbeat pin it? |
| `block-concurrency-15000`, `block-concurrency-1500` | Does hydrating state in `blockConcurrencyWhile` change residency? |

The variants run at 15s — an interval at which the baseline *does* evict — so "still resident" can
only mean the variant pinned it.

## What this can and cannot tell you

**Can:** whether the object is evicted and re-constructed between alarms, and which coding patterns
prevent that. `workerd` implements the same eviction path as production — 10s of inactivity, 70s
expiry — and the numbers are in the source (`src/workerd/server/server.c++`, `ActorContainer`;
`workerd.capnp` `preventEviction`: *"By default, Durable Objects are evicted after 10 seconds of
inactivity, and expire 70 seconds after all clients have disconnected"*).

**Cannot:** billed GB-s. `workerd` implements eviction but not metering — there is no GB-s counter
in local dev. Worse, Cloudflare's pricing docs say idle time that is *eligible* for hibernation is
not billed even before the runtime actually hibernates the object, and that eligibility is not
observable locally at a 1.5s cadence, because the object never idles long enough to be evicted
either way. See the results comment on #7 for what that leaves unsettled and the one measurement
that would settle it.

## Results

At 1.5s the object is **never evicted** — one instance handled all 40 alarms. The eviction cliff
is between 9s and 11s, matching the documented 10s rule. At 15s, where the object otherwise evicts
between every alarm, a held-open TCP socket, an in-flight `fetch()` or a pending timer each keep it
resident; `blockConcurrencyWhile` does not. The scheduler therefore ticks at 30s and must not hold
a database connection — `references/serverless-migration.md` §4.2.

Full tables, the GB-s implications and what is still unsettled: the results comment on
[#7](https://github.com/allanclempe/useSend/issues/7) and §12. Raw observations from each run land
in `results/<runId>.json` (gitignored).
