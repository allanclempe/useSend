/**
 * Durable Object residency probe — issue #7.
 *
 * Question: a Durable Object that re-arms its own alarm every ~1.5s (the shape
 * the campaign scheduler takes on Cloudflare — see
 * `apps/web/src/server/jobs/campaign-scheduler-job.ts`, `SCHEDULER_TICK_MS`)
 * — does it get evicted from memory between alarms, or does it sit resident?
 *
 * Durable Object *duration* is billed for wall-clock time while the object is
 * in memory, so "resident forever" and "evicted between alarms" differ by ~30x
 * on a fixed monthly cost that does not depend on email volume.
 *
 * How residency is observed: each DO instance mints an `instanceId` in its
 * constructor and keeps an in-memory counter of the alarms *that instance* has
 * handled. Every alarm appends an observation to DO storage. If alarm N is
 * handled by an instance that has handled no previous alarm, the object was
 * torn down and re-constructed since alarm N-1 — i.e. it was evicted. If one
 * instanceId handles every alarm, it never left memory.
 *
 * The DO's name carries the scenario: `<mode>:<intervalMs>:<runId>`, read back
 * via `ctx.id.name`, so a re-constructed instance knows which variant it is
 * without a storage read racing the constructor.
 *
 * The variant modes each probe one documented hibernation-eligibility rule
 * (https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/):
 *   baseline          — handler does its work and re-arms. The control.
 *   block-concurrency — constructor hydrates state via `blockConcurrencyWhile`,
 *                       as a real scheduler DO would.
 *   set-interval      — a `setInterval` heartbeat is left running.
 *   set-timeout       — an unawaited long `setTimeout` spans the idle gap.
 *   pending-fetch     — an unawaited in-flight `fetch()` spans the idle gap.
 *   open-socket       — an outbound TCP socket is held open across alarms.
 *                       This is the one that matters for useSend: a pooled
 *                       Postgres connection to Neon is exactly this.
 */

import { connect } from "cloudflare:sockets";

type Env = {
  PROBE: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
  /** Base URL of the stub "database" run.mjs starts. */
  STUB_URL?: string;
  /** host:port of the TCP sink run.mjs starts, for the open-socket mode. */
  TCP_SINK?: string;
};

type Mode =
  | "baseline"
  | "block-concurrency"
  | "set-interval"
  | "set-timeout"
  | "pending-fetch"
  | "open-socket";

type Observation = {
  tick: number;
  mode: Mode;
  /** Wall clock at the top of the alarm handler. */
  at: number;
  /** Gap since the previous alarm, ms. ~= the configured interval. */
  gapMs: number | null;
  instanceId: string;
  /** True when this instance had handled no earlier alarm => it was evicted. */
  freshInstance: boolean;
  /** How long this instance has existed when the alarm fired, ms. */
  instanceAgeMs: number;
  /** Nth constructor call inside this isolate. */
  constructionOrdinal: number;
  isolateId: string;
  /** Duration of the alarm handler's simulated scheduler work, ms. */
  workMs: number;
  /** Did the representative work reach the service binding, or fall back? */
  workKind: "subrequest" | "timer";
  /** Whatever the pinning variant has to say for itself, if anything. */
  variantNote: string | null;
};

/**
 * Fresh per isolate, so isolate recycling is distinguishable from actor
 * eviction. Lazy because workerd forbids generating randomness in global scope.
 */
let isolateId: string | null = null;
let constructionsInThisIsolate = 0;

function shortId(): string {
  return crypto.randomUUID().slice(0, 8);
}

function getIsolateId(): string {
  if (!isolateId) isolateId = shortId();
  return isolateId;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseName(name: string | undefined): {
  mode: Mode;
  intervalMs: number;
} {
  const [mode, interval] = (name ?? "baseline:1500:x").split(":");
  return {
    mode: (mode as Mode) ?? "baseline",
    intervalMs: Number(interval) || 1500,
  };
}

export class SchedulerProbe {
  private ctx: any;
  private env: Env;
  private mode: Mode;
  private intervalMs: number;
  private instanceId = shortId();
  private constructedAt = Date.now();
  private constructionOrdinal: number;
  /** In-memory, deliberately not persisted: the residency signal. */
  private alarmsHandledByThisInstance = 0;
  private heartbeats = 0;
  private danglingPromise: Promise<unknown> | null = null;
  private timer: unknown = null;
  private socket: any = null;
  private socketNote: string | null = null;

  constructor(ctx: any, env: Env) {
    this.ctx = ctx;
    this.env = env;
    constructionsInThisIsolate += 1;
    this.constructionOrdinal = constructionsInThisIsolate;

    const { mode, intervalMs } = parseName(ctx.id?.name);
    this.mode = mode;
    this.intervalMs = intervalMs;

    log("construct", {
      mode: this.mode,
      instanceId: this.instanceId,
      constructionOrdinal: this.constructionOrdinal,
      isolateId: getIsolateId(),
    });

    if (this.mode === "block-concurrency") {
      // What a real scheduler DO does: hydrate state before serving anything.
      ctx.blockConcurrencyWhile(async () => {
        await ctx.storage.get("tick");
        await sleep(5);
      });
    }

    if (this.mode === "set-interval") {
      this.timer = setInterval(() => {
        this.heartbeats += 1;
      }, 250);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/start") {
      const { stopAfterTicks } = (await request.json()) as {
        stopAfterTicks: number;
      };
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.put({
        tick: 0,
        stopAfterTicks,
        startedAt: Date.now(),
      });
      await this.ctx.storage.setAlarm(Date.now() + this.intervalMs);
      return json({
        started: true,
        mode: this.mode,
        intervalMs: this.intervalMs,
        stopAfterTicks,
      });
    }

    if (url.pathname === "/report") {
      return json(await this.report());
    }

    if (url.pathname === "/stop") {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.put("stopped", true);
      return json({ stopped: true });
    }

    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const at = Date.now();
    const tick = ((await this.ctx.storage.get("tick")) ?? 0) + 1;
    const lastAlarmAt = (await this.ctx.storage.get("lastAlarmAt")) as
      | number
      | undefined;
    const stopAfterTicks = ((await this.ctx.storage.get("stopAfterTicks")) ??
      0) as number;

    const freshInstance = this.alarmsHandledByThisInstance === 0;
    this.alarmsHandledByThisInstance += 1;

    await this.applyPinningVariant();

    const work = await this.doSchedulerWork(tick);

    const observation: Observation = {
      tick,
      mode: this.mode,
      at,
      gapMs: lastAlarmAt ? at - lastAlarmAt : null,
      instanceId: this.instanceId,
      freshInstance,
      instanceAgeMs: at - this.constructedAt,
      constructionOrdinal: this.constructionOrdinal,
      isolateId: getIsolateId(),
      workMs: work.ms,
      workKind: work.kind,
      variantNote: this.variantNote(),
    };

    await this.ctx.storage.put({
      tick,
      lastAlarmAt: at,
      [`obs:${String(tick).padStart(6, "0")}`]: observation,
    });

    log("alarm", observation);

    if (tick < stopAfterTicks) {
      await this.ctx.storage.setAlarm(at + this.intervalMs);
    } else {
      await this.ctx.storage.put("finishedAt", Date.now());
      log("finished", { mode: this.mode, ticks: tick });
    }
  }

  private stubUrl(): string {
    return this.env.STUB_URL ?? "http://127.0.0.1:8797";
  }

  private variantNote(): string | null {
    if (this.mode === "open-socket") return `socket ${this.socketNote}`;
    if (this.mode === "set-interval") return `heartbeats ${this.heartbeats}`;
    if (this.mode === "set-timeout" || this.mode === "pending-fetch") {
      return this.danglingPromise ? "pending" : "none";
    }
    return null;
  }

  /**
   * Leaves behind whatever this mode's variant is supposed to leave behind:
   * a timer, an in-flight fetch, an open socket. Each is something the docs say
   * makes a Durable Object ineligible for hibernation — and therefore billed
   * for idle wall-clock rather than free.
   */
  private async applyPinningVariant(): Promise<void> {
    if (this.mode === "set-timeout" && !this.danglingPromise) {
      // Started, never awaited, resolves long after the run ends.
      this.danglingPromise = sleep(60 * 60 * 1000);
      return;
    }

    if (this.mode === "pending-fetch" && !this.danglingPromise) {
      // An in-flight subrequest that outlives the alarm handler. The docs call
      // this "waiting for I/O" and it blocks hibernation.
      this.danglingPromise = fetch(
        `${this.stubUrl()}/campaigns-due?delayMs=120000`,
      ).catch(() => undefined);
      return;
    }

    if (this.mode === "open-socket" && !this.socket) {
      // Stands in for a pooled Postgres connection to Neon held by the DO.
      try {
        const [hostname, port] = (this.env.TCP_SINK ?? "127.0.0.1:8798").split(
          ":",
        );
        this.socket = connect({ hostname, port: Number(port) });
        const writer = this.socket.writable.getWriter();
        await writer.write(new TextEncoder().encode("ping\n"));
        writer.releaseLock();
        this.socketNote = "open";
      } catch (err) {
        this.socketNote = `failed: ${String(err)}`;
      }
    }
  }

  /**
   * Stand-in for one campaign-scheduler tick: a query for due campaigns, and on
   * a minority of ticks an enqueue per due campaign. Modelled as subrequests so
   * the handler has realistic awaited I/O rather than being pure CPU.
   */
  private async doSchedulerWork(
    tick: number,
  ): Promise<{ ms: number; kind: "subrequest" | "timer" }> {
    const started = Date.now();
    // Most ticks find nothing due; every 10th stands in for one due campaign.
    const enqueues = tick % 10 === 0 ? 1 : 0;
    let kind: "subrequest" | "timer" = "subrequest";

    try {
      await fetch(`${this.stubUrl()}/campaigns-due?delayMs=8`);
      for (let i = 0; i < enqueues; i += 1) {
        await fetch(`${this.stubUrl()}/enqueue-batch?delayMs=4`);
      }
    } catch {
      kind = "timer";
      await sleep(8 + enqueues * 4);
    }

    return { ms: Date.now() - started, kind };
  }

  private async report() {
    const entries = await this.ctx.storage.list({ prefix: "obs:" });
    const observations = [...entries.values()] as Observation[];
    const startedAt = (await this.ctx.storage.get("startedAt")) as
      | number
      | undefined;
    const finishedAt = (await this.ctx.storage.get("finishedAt")) as
      | number
      | undefined;
    const stopAfterTicks = (await this.ctx.storage.get("stopAfterTicks")) as
      | number
      | undefined;

    const instanceIds = [...new Set(observations.map((o) => o.instanceId))];
    // Tick 1 is always "fresh" — the /start request created the instance — so
    // the eviction rate is measured over the alarms that follow it.
    const subsequent = observations.slice(1);
    const freshAlarms = subsequent.filter((o) => o.freshInstance).length;
    const gaps = observations
      .map((o) => o.gapMs)
      .filter((g): g is number => typeof g === "number");

    return {
      mode: this.mode,
      intervalMs: this.intervalMs,
      stopAfterTicks,
      startedAt,
      finishedAt,
      done: typeof finishedAt === "number",
      ticks: observations.length,
      distinctInstances: instanceIds.length,
      /** Alarms after the first handled by a never-before-used instance. */
      alarmsOnFreshInstance: freshAlarms,
      /** 1.0 => re-instantiated every alarm. 0 => never left memory. */
      evictionRate: subsequent.length ? freshAlarms / subsequent.length : 0,
      maxInstanceAgeMs: observations.reduce(
        (max, o) => Math.max(max, o.instanceAgeMs),
        0,
      ),
      meanGapMs: gaps.length
        ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)
        : null,
      maxGapMs: gaps.length ? Math.max(...gaps) : null,
      meanWorkMs: observations.length
        ? Math.round(
            (observations.reduce((a, o) => a + o.workMs, 0) /
              observations.length) *
              10,
          ) / 10
        : null,
      workKind: observations[0]?.workKind ?? null,
      heartbeatsThisInstance: this.heartbeats,
      socketNote: this.socketNote,
      observations,
    };
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") return json({ ok: true });

    // /start, /report and /stop proxy straight through to the named DO.
    const name = url.searchParams.get("name");
    if (!name) return new Response("missing ?name=<mode>:<ms>:<run>", { status: 400 });
    const stub = env.PROBE.get(env.PROBE.idFromName(name));
    return stub.fetch(
      new Request(`https://probe.invalid${url.pathname}`, {
        method: request.method,
        body: request.method === "POST" ? await request.text() : undefined,
      }),
    );
  },
};
