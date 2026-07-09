#!/usr/bin/env node
// JPO Huddle load-test coordinator.
//
//   node loadtest/loadtest.mjs --n 100 --duration 75
//
// By default it spawns its OWN server instance (node server.js) on --port with
// LOADTEST_METRICS=1, so the dev workflow and anyone playing in the preview are
// untouched; --attach <url> targets an already-running server instead (no
// server-side metrics/CPU in that mode).
//
// Flags:
//   --n <players>          total simulated players            (default 50)
//   --duration <s>         measured run length                (default 75 — spans a coin tick)
//   --duty <0..1>          fraction of time each player walks (default 0.5)
//   --workers <k>          harness worker processes           (default 2)
//   --port <p>             port for the spawned server        (default 21999)
//   --attach <url>         use an existing server instead of spawning one
//   --email-backed         register real DB-backed accounts (exercises the coin-tick DB path)
//   --keep-rows            skip the loadtest.* row cleanup after an --email-backed run
//   --no-duels             disable the RPS duel pair per worker
//   --chat-interval <s>    average seconds between chats per player (default 25)
//
// Requires ADMIN_PASSWORD in the env (the coordinator runs the approving admin
// socket) and DATABASE_URL (the server needs it; also used for row cleanup).
import { spawn, fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { io as ioc } from "socket.io-client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, "..");
const CLK_TCK = 100;

const args = process.argv.slice(2);
const argVal = (name, dflt) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : dflt; };
const argFlag = (name) => args.includes("--" + name);

const N = Number(argVal("n", 50));
const durationS = Number(argVal("duration", 75));
const duty = Number(argVal("duty", 0.5));
const workers = Math.max(1, Number(argVal("workers", 2)));
const port = Number(argVal("port", 21999));
const attach = argVal("attach", "");
const emailBacked = argFlag("email-backed");
const keepRows = argFlag("keep-rows");
const duels = !argFlag("no-duels");
const chatIntervalMs = Number(argVal("chat-interval", 25)) * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (msg) => console.log(`[loadtest +${((Date.now() - T0) / 1000).toFixed(1)}s] ${msg}`);

// Never leave orphans: kill the spawned server and workers on any signal.
const children = [];
function killChildren() {
  for (const c of children) { try { if (c.exitCode === null) c.kill("SIGKILL"); } catch {} }
}
process.on("SIGTERM", () => { killChildren(); process.exit(2); });
process.on("SIGINT", () => { killChildren(); process.exit(2); });

// ── Server (spawned mode) ──────────────────────────────────────────────────
let serverProc = null;
const serverLines = [];
const metricsSamples = [];   // { t, clients, players, lagP50, lagP99, lagMax, rssMb, coinTickMs }

function parseMetricsLine(line) {
  const g = (k) => { const m = line.match(new RegExp(k + "=([\\d.]+)")); return m ? Number(m[1]) : null; };
  return {
    t: Date.now(), clients: g("clients"), players: g("players"),
    lagP50: g("lag_p50"), lagP99: g("lag_p99"), lagMax: g("lag_max"),
    rssMb: g("rss_mb"), coinTickMs: g("coin_tick_ms"),
    mvOk: g("mv_ok"), mvThr: g("mv_thr"), mvRej: g("mv_rej"),
  };
}

async function startServer() {
  serverProc = spawn(process.execPath, ["server.js"], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(port), LOADTEST_METRICS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(serverProc);
  let buf = "";
  serverProc.stdout.on("data", (c) => {
    buf += c.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      serverLines.push(line);
      if (line.startsWith("[metrics]")) metricsSamples.push(parseMetricsLine(line));
    }
  });
  serverProc.stderr.on("data", (c) => serverLines.push("[stderr] " + c.toString().trimEnd()));
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (serverLines.some((l) => l.includes("running on port"))) return;
    if (serverProc.exitCode !== null) {
      throw new Error("server exited early:\n" + serverLines.slice(-25).join("\n"));
    }
    await sleep(200);
  }
  throw new Error("server did not start within 20s");
}

// CPU% of the spawned server (of ONE core), sampled from /proc.
const cpuSamples = [];
let cpuTimer = null;
function readCpuSeconds(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const parts = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return (Number(parts[11]) + Number(parts[12])) / CLK_TCK;   // utime + stime
  } catch {
    return null;
  }
}
function startCpuSampling(pid) {
  let last = readCpuSeconds(pid), lastT = Date.now();
  cpuTimer = setInterval(() => {
    const cur = readCpuSeconds(pid), t = Date.now();
    if (cur !== null && last !== null && t > lastT) {
      cpuSamples.push((100 * (cur - last)) / ((t - lastT) / 1000));
    }
    last = cur;
    lastT = t;
  }, 2000);
}

// ── Admin socket (approves every pending registrant) ───────────────────────
async function startAdmin(url) {
  if (!process.env.ADMIN_PASSWORD) throw new Error("ADMIN_PASSWORD is not set — the harness needs it to approve players");
  const sock = ioc(url, { transports: ["websocket"], reconnection: false, forceNew: true });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("admin auth timeout")), 10000);
    sock.on("connect", () => sock.emit("adminAuth", { password: process.env.ADMIN_PASSWORD }));
    sock.on("adminAuthOk", () => { clearTimeout(to); resolve(); });
    sock.on("adminAuthFail", () => { clearTimeout(to); reject(new Error("adminAuthFail — wrong ADMIN_PASSWORD?")); });
    sock.on("connect_error", (e) => { clearTimeout(to); reject(e); });
  });
  // Approve everything, every time the pending list updates. approvePlayer on
  // an already-approved id is a no-op server-side, and every approval triggers
  // a fresh pendingList, so this converges even under registration races.
  sock.on("pendingList", (list) => {
    for (const p of list || []) sock.emit("approvePlayer", p.id);
  });
  return sock;
}

// ── Workers ────────────────────────────────────────────────────────────────
function pct(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;
}

async function main() {
  console.log(`[loadtest] n=${N} duration=${durationS}s duty=${duty} workers=${workers} ` +
    `${emailBacked ? "email-backed" : "session-only"} duels=${duels} ${attach ? "attach=" + attach : "port=" + port}`);

  let url = attach;
  if (!attach) {
    await startServer();
    url = `http://127.0.0.1:${port}`;
    log(`server spawned (pid ${serverProc.pid}) on ${url}`);
  }

  const admin = await startAdmin(url);
  log("admin authed — approvals live");

  const per = Math.floor(N / workers);
  const counts = Array.from({ length: workers }, (_, w) => per + (w < N % workers ? 1 : 0)).filter((c) => c > 0);
  let offset = 0;
  const procs = [];
  const readies = [];
  const results = [];
  for (const count of counts) {
    const wcfg = {
      url, count, offset, durationMs: durationS * 1000, duty, emailBacked,
      chatIntervalMs, duels, staggerMs: 30, wanderR: 350,
    };
    offset += count;
    const child = fork(path.join(__dirname, "worker.mjs"), [JSON.stringify(wcfg)], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    procs.push(child);
    children.push(child);
    readies.push(new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("worker ready timeout")), 60000);
      child.on("message", (m) => {
        if (m && m.type === "ready") { clearTimeout(to); resolve(m); }
      });
      child.on("exit", (code) => { if (code !== 0) reject(new Error(`worker exited ${code} before ready`)); });
    }));
    results.push(new Promise((resolve, reject) => {
      let done = false;
      const to = setTimeout(() => reject(new Error("worker result timeout")), durationS * 1000 + 45000);
      child.on("message", (m) => {
        if (m && m.type === "result") { done = true; clearTimeout(to); resolve(m.stats); }
      });
      child.on("exit", (code) => {
        if (!done) { clearTimeout(to); reject(new Error(`worker exited ${code} before sending result`)); }
      });
    }));
  }

  const readyInfos = await Promise.all(readies);
  const approvedTotal = readyInfos.reduce((s, r) => s + r.approved, 0);
  const failedTotal = readyInfos.reduce((s, r) => s + r.failed, 0);
  log(`ready: ${approvedTotal}/${N} approved (${failedTotal} failed) — starting ${durationS}s run`);

  const startAt = Date.now() + 1500;
  const endAt = startAt + durationS * 1000;
  for (const p of procs) p.send({ type: "start", at: startAt });
  if (serverProc) startCpuSampling(serverProc.pid);

  const stats = await Promise.all(results);
  if (cpuTimer) clearInterval(cpuTimer);
  log("all worker results in — aggregating");

  // ── Aggregate ────────────────────────────────────────────────────────────
  const agg = stats.reduce((a, s) => {
    for (const k of ["approved", "failed", "movesSent", "movedRecv", "pairRecv", "chatSent", "chatRecv", "duelsStarted", "duelsDone", "unexpectedDisconnects"]) {
      a[k] = (a[k] || 0) + s[k];
    }
    a.latencies.push(...s.latencies);
    return a;
  }, { latencies: [] });
  agg.latencies.sort((x, y) => x - y);
  const L = agg.latencies;

  const win = metricsSamples.filter((m) => m.t >= startAt && m.t <= endAt + 5000);
  const worst = (k) => (win.length ? Math.max(...win.map((m) => m[k] ?? 0)) : null);
  const cpuAvg = cpuSamples.length ? cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length : null;

  // Server-side move accounting over the window (counters are cumulative):
  // mv_thr counts by-design throttle drops (two 50ms-cadence sends bunched by
  // TCP into a <33ms arrival gap) — those never broadcast, so delivery is
  // judged against ACCEPTED moves. mv_rej (teleport rejects) should be 0.
  let acceptRatio = null, mvDelta = null;
  if (win.length >= 2) {
    const a = win[0], b = win[win.length - 1];
    mvDelta = { ok: b.mvOk - a.mvOk, thr: b.mvThr - a.mvThr, rej: b.mvRej - a.mvRej };
    const total = mvDelta.ok + mvDelta.thr + mvDelta.rej;
    acceptRatio = total > 0 ? mvDelta.ok / total : null;
  }

  const report = {
    config: { n: N, durationS, duty, workers, emailBacked, duels, mode: attach ? "attach" : "spawn" },
    clients: {
      approved: agg.approved, failed: agg.failed,
      unexpectedDisconnects: agg.unexpectedDisconnects,
      movesSent: agg.movesSent,
      movedRecvTotal: agg.movedRecv,
      movedRecvPerSec: Math.round(agg.movedRecv / durationS),
      deliveryRatio: agg.movesSent ? +(agg.pairRecv / agg.movesSent).toFixed(4) : null,
      // delivery of moves the server actually accepted+broadcast (see mvDelta)
      deliveryOfAccepted: agg.movesSent && acceptRatio
        ? +Math.min(1, agg.pairRecv / (agg.movesSent * acceptRatio)).toFixed(4)
        : null,
      echoLatencyMs: {
        count: L.length,
        p50: pct(L, 0.5), p90: pct(L, 0.9), p95: pct(L, 0.95), p99: pct(L, 0.99),
        max: L.length ? L[L.length - 1] : null,
      },
      chat: { sent: agg.chatSent, recv: agg.chatRecv },
      duels: { started: agg.duelsStarted, resultsSeen: agg.duelsDone },
    },
    server: attach ? null : {
      lagP50Worst: worst("lagP50"), lagP99Worst: worst("lagP99"), lagMaxWorst: worst("lagMax"),
      rssMbMax: worst("rssMb"), coinTickMsMax: worst("coinTickMs"),
      clientsMax: worst("clients"),
      moveCounters: mvDelta,
      moveAcceptRatio: acceptRatio !== null ? +acceptRatio.toFixed(4) : null,
      cpuPctAvg: cpuAvg !== null ? Math.round(cpuAvg) : null,
      cpuPctMax: cpuSamples.length ? Math.round(Math.max(...cpuSamples)) : null,
    },
  };

  // ── Verdict ──────────────────────────────────────────────────────────────
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  add("all approved", agg.approved === N, `${agg.approved}/${N}`);
  add("no unexpected disconnects", agg.unexpectedDisconnects === 0, String(agg.unexpectedDisconnects));
  add("echo p95 < 250ms", (report.clients.echoLatencyMs.p95 ?? Infinity) < 250, `${report.clients.echoLatencyMs.p95}ms`);
  const effDelivery = report.clients.deliveryOfAccepted ?? report.clients.deliveryRatio;
  add("delivery of accepted moves > 98%", (effDelivery ?? 0) > 0.98,
    `${effDelivery}${report.clients.deliveryOfAccepted === null || report.clients.deliveryOfAccepted === undefined ? " (raw — no server counters)" : ""}`);
  if (report.server) {
    // A tiny reject fraction is expected under CPU jitter: a delayed client tick
    // produces one oversized step the server drops (documented residual — same
    // as a lagging real browser). Systematic harness bugs would reject far more.
    const mvTotal = mvDelta ? mvDelta.ok + mvDelta.thr + mvDelta.rej : 0;
    const rejFrac = mvTotal > 0 ? (mvDelta.rej / mvTotal) : 0;
    add("teleport rejects < 0.1%", rejFrac < 0.001, `${mvDelta?.rej ?? 0} (${(rejFrac * 100).toFixed(3)}%)`);
    add("server lag p99 < 200ms", (report.server.lagP99Worst ?? Infinity) < 200, `${report.server.lagP99Worst}ms`);
  }
  report.checks = checks;
  report.pass = checks.every((c) => c.ok);

  console.log("\n──────── LOAD TEST REPORT ────────");
  console.log(JSON.stringify(report, (k, v) => (k === "latencies" ? undefined : v), 2));
  for (const c of checks) console.log(`${c.ok ? "  PASS" : "  FAIL"}  ${c.name}  (${c.detail})`);
  console.log(report.pass ? `\nVERDICT: PASS at ${N} players` : `\nVERDICT: FAIL at ${N} players`);

  // Persist the run for RESULTS.md.
  const outDir = path.join(__dirname, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-n${N}${emailBacked ? "-email" : ""}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`[loadtest] report saved: ${outFile}`);

  // ── Teardown ─────────────────────────────────────────────────────────────
  admin.close();
  for (const p of procs) { if (p.exitCode === null) p.kill(); }
  if (serverProc && serverProc.exitCode === null) {
    serverProc.kill("SIGTERM");
    await new Promise((r) => { serverProc.on("exit", r); setTimeout(r, 5000); });
  }
  if (emailBacked && !keepRows) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const res = await pool.query(`DELETE FROM jpo_players WHERE email LIKE 'loadtest.%@lt.local'`);
    await pool.end();
    console.log(`[loadtest] cleaned up ${res.rowCount} loadtest rows`);
  }
  process.exit(report.pass ? 0 : 1);
}

main().catch(async (e) => {
  console.error("[loadtest] fatal:", e);
  if (serverProc && serverProc.exitCode === null) serverProc.kill("SIGKILL");
  process.exit(2);
});
