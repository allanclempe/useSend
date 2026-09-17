#!/usr/bin/env node
/**
 * Drives the residency probe: boots `wrangler dev` in local mode (real workerd,
 * no Cloudflare account), runs each scenario, prints the residency table.
 *
 *   pnpm install --ignore-workspace && pnpm experiment
 *   pnpm experiment -- --scenarios=tick-1500,baseline-15000
 *
 * Never contacts Cloudflare: local mode only, metrics off, no deploy.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const PORT = Number(process.env.PROBE_PORT ?? 8799);
const STUB_PORT = Number(process.env.PROBE_STUB_PORT ?? 8797);
const TCP_SINK_PORT = Number(process.env.PROBE_TCP_PORT ?? 8798);
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * `ticks` is chosen so each scenario is conclusive: the 1.5s one over many
 * wakes, the rest over idle gaps that bracket the documented 10s threshold.
 */
const SCENARIOS = [
  {
    id: "tick-1500",
    mode: "baseline",
    intervalMs: 1500,
    ticks: 40,
    why: "The real thing: campaign scheduler at SCHEDULER_TICK_MS = 1500.",
  },
  {
    id: "control-30000",
    mode: "baseline",
    intervalMs: 30_000,
    ticks: 4,
    why: "Control. 30s idle is far past any plausible eviction threshold; if this does not evict, the harness cannot see eviction at all.",
  },
  // Bisect the interval at which eviction starts — that is the number the
  // scheduler design has to be built around.
  {
    id: "interval-3000",
    mode: "baseline",
    intervalMs: 3_000,
    ticks: 8,
    why: "Sweep: 3s.",
  },
  {
    id: "interval-6000",
    mode: "baseline",
    intervalMs: 6_000,
    ticks: 6,
    why: "Sweep: 6s.",
  },
  {
    id: "interval-9000",
    mode: "baseline",
    intervalMs: 9_000,
    ticks: 5,
    why: "Sweep: 9s, just under the documented 10s inactivity mark.",
  },
  {
    id: "interval-11000",
    mode: "baseline",
    intervalMs: 11_000,
    ticks: 5,
    why: "Sweep: 11s, just over it.",
  },
  // The pinning variants run at 15s — an interval at which baseline *does*
  // evict — so that "still resident" can only mean the variant pinned it.
  {
    id: "baseline-15000",
    mode: "baseline",
    intervalMs: 15_000,
    ticks: 4,
    why: "Reference for the pinning variants below: plain baseline at 15s.",
  },
  {
    id: "open-socket-15000",
    mode: "open-socket",
    intervalMs: 15_000,
    ticks: 4,
    why: "The one that decides useSend's design: does a held-open outbound TCP socket — a pooled Neon connection — pin the object?",
  },
  {
    id: "pending-fetch-15000",
    mode: "pending-fetch",
    intervalMs: 15_000,
    ticks: 4,
    why: "Does an in-flight unawaited fetch() pin an otherwise-evictable object?",
  },
  {
    id: "set-timeout-15000",
    mode: "set-timeout",
    intervalMs: 15_000,
    ticks: 4,
    why: "Does a pending setTimeout pin an otherwise-evictable object?",
  },
  {
    id: "set-interval-15000",
    mode: "set-interval",
    intervalMs: 15_000,
    ticks: 4,
    why: "Does a setInterval heartbeat pin an otherwise-evictable object?",
  },
  {
    id: "block-concurrency-15000",
    mode: "block-concurrency",
    intervalMs: 15_000,
    ticks: 4,
    why: "Does blockConcurrencyWhile in the constructor pin it?",
  },
  {
    id: "block-concurrency-1500",
    mode: "block-concurrency",
    intervalMs: 1500,
    ticks: 20,
    why: "Does hydrating state in blockConcurrencyWhile change residency at the real 1.5s tick?",
  },
];

const requested = (process.argv.find((a) => a.startsWith("--scenarios=")) ?? "")
  .replace("--scenarios=", "")
  .split(",")
  .filter(Boolean);
const scenarios = requested.length
  ? SCENARIOS.filter((s) => requested.includes(s.id))
  : SCENARIOS;

const runId = Date.now().toString(36);
const workerLog = [];
let child = null;

function spawnDev() {
  const proc = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1"],
    {
      cwd: import.meta.dirname,
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        CLOUDFLARE_API_TOKEN: "",
        CI: "1",
      },
      // stdin must stay open: wrangler dev shuts down when it reaches EOF.
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  for (const stream of [proc.stdout, proc.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      workerLog.push(chunk);
      if (process.env.PROBE_VERBOSE) process.stdout.write(chunk);
    });
  }
  return proc;
}

async function waitForHealth(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await delay(500);
  }
  throw new Error("wrangler dev never became healthy");
}

/**
 * `wrangler dev` has been seen to exit on its own during long runs. Durable
 * Object storage lives on disk under `.wrangler/state`, so a restart loses no
 * observations — retry through it rather than losing the scenario. A restart
 * does reset in-memory instances, so it is recorded in the log: it would
 * otherwise look exactly like an eviction.
 */
async function call(url, init) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${BASE}${url}`, init);
      if (!res.ok) throw new Error(`${url} -> ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= 3) throw err;
      process.stdout.write("  … dev server unreachable, restarting it\n");
      workerLog.push("\n[runner] restarted wrangler dev\n");
      child?.kill("SIGKILL");
      child = spawnDev();
      await waitForHealth();
    }
  }
}

function startScenario(name, ticks) {
  return call(`/start?name=${encodeURIComponent(name)}`, {
    method: "POST",
    body: JSON.stringify({ stopAfterTicks: ticks }),
  });
}

function report(name) {
  return call(`/report?name=${encodeURIComponent(name)}`, { method: "POST" });
}

/**
 * Polls only after the run should be over. Polling mid-run would be a request
 * to the DO, which would itself keep the object resident and destroy the
 * measurement.
 */
async function runScenario(scenario) {
  const name = `${scenario.mode}:${scenario.intervalMs}:${runId}`;
  const expectedMs = scenario.intervalMs * scenario.ticks;
  process.stdout.write(
    `\n▶ ${scenario.id} — ${scenario.ticks} alarms × ${scenario.intervalMs}ms ≈ ${Math.round(expectedMs / 1000)}s\n  ${scenario.why}\n`,
  );
  await startScenario(name, scenario.ticks);

  const deadline = Date.now() + expectedMs + 30_000;
  await delay(expectedMs + 2_000);
  let result = await report(name);
  while (!result.done && Date.now() < deadline) {
    await delay(2_000);
    result = await report(name);
  }
  return { scenario, result };
}

function verdictFor(result) {
  if (!result.ticks) return "no data";
  if (result.evictionRate >= 0.9) return "EVICTED between alarms";
  if (result.evictionRate <= 0.1) return "RESIDENT across alarms";
  return `mixed (${(result.evictionRate * 100).toFixed(0)}% fresh)`;
}

/** Stands in for Neon: answers the alarm handler's query after a small delay. */
const stubServer = createHttpServer(async (req, res) => {
  const delayMs = Number(
    new URL(req.url, "http://x").searchParams.get("delayMs") ?? 5,
  );
  await delay(delayMs);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, rows: [] }));
});
await new Promise((resolve) =>
  stubServer.listen(STUB_PORT, "127.0.0.1", resolve),
);

/** Accepts connections and never closes them, so the DO can hold one open. */
const tcpSink = createTcpServer((socket) => {
  socket.on("data", () => {});
  socket.on("error", () => {});
});
await new Promise((resolve) =>
  tcpSink.listen(TCP_SINK_PORT, "127.0.0.1", resolve),
);

const results = [];
try {
  process.stdout.write(`Booting wrangler dev (local workerd) on :${PORT}…\n`);
  child = spawnDev();
  await waitForHealth();
  process.stdout.write("Ready. No Cloudflare account involved.\n");

  for (const scenario of scenarios) {
    results.push(await runScenario(scenario));
  }
} finally {
  child?.kill("SIGTERM");
  tcpSink.close();
  stubServer.close();
}

process.stdout.write(
  "\n" +
    "scenario".padEnd(24) +
    "ticks".padStart(6) +
    "instances".padStart(11) +
    "fresh".padStart(7) +
    "meanGap".padStart(9) +
    "maxAge".padStart(9) +
    "work".padStart(7) +
    "  verdict\n",
);
for (const { scenario, result } of results) {
  const note = result.observations?.at(-1)?.variantNote;
  process.stdout.write(
    scenario.id.padEnd(24) +
      String(result.ticks).padStart(6) +
      String(result.distinctInstances).padStart(11) +
      String(result.alarmsOnFreshInstance).padStart(7) +
      `${result.meanGapMs ?? "-"}ms`.padStart(9) +
      `${result.maxInstanceAgeMs}ms`.padStart(9) +
      `${result.meanWorkMs ?? "-"}ms`.padStart(7) +
      `  ${verdictFor(result)}` +
      (note ? ` [${note}]` : "") +
      "\n",
  );
}

const outDir = `${import.meta.dirname}/results`;
mkdirSync(outDir, { recursive: true });
const outFile = `${outDir}/${runId}.json`;
writeFileSync(
  outFile,
  JSON.stringify(
    {
      runId,
      at: new Date().toISOString(),
      node: process.version,
      results: results.map(({ scenario, result }) => ({
        scenario,
        verdict: verdictFor(result),
        ...result,
      })),
      workerLog: workerLog.join(""),
    },
    null,
    2,
  ),
);
process.stdout.write(`\nRaw observations written to ${outFile}\n`);
process.stdout.write(
  "\nReading it: one instance id across every alarm means the object never left\nmemory. One fresh instance per alarm means it was evicted and re-constructed\nbetween alarms.\n",
);

// The open-socket scenario leaves a socket held open; do not wait on it.
process.exit(0);
