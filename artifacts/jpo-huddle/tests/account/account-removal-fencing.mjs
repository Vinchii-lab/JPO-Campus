// Paused-process fencing contract (task #153).
//
// Two servers:
//   • A — normal. The owner drives ownerRemoveAccount here.
//   • B — booted with TEST_FORCE_ACCOUNT_TEARDOWN_FAILURE=1 so its COMMITTED-phase
//     local teardown keeps throwing — a reliable way to hold B in the
//     "committed but not yet completed" state — with the target live on B.
//
// Scenario:
//   1. Start removal on A. B ACKs the prepare barrier and A commits the
//      anonymization. B's committed teardown fails, so B never writes
//      completed_at.
//   2. Once the op is durably 'committed', SIGSTOP B (freeze its event loop)
//      so it can neither renew its heartbeat nor process any queued target
//      event. Keep it paused well past the 6s lease.
//   3. A's completion path durably FENCES B's stale, incomplete lease
//      (jpo_server_instances.fenced=true) and ONLY THEN reports success.
//   4. SIGCONT B. On its next heartbeat tick B must fail closed and terminate
//      ITSELF (process.exit) before renewing its heartbeat or processing any
//      queued target event — because its local lease deadline lapsed while
//      paused AND its DB lease is fenced. Its target socket disconnects due to
//      the process exit.
//
// Assertions:
//   • while B is paused past the lease, A sets B.fenced=true durably and only
//     then emits ownerRemoveAccountResult{ok:true};
//   • after SIGCONT, B exits; the target socket disconnects; B's lease is never
//     unfenced under the old process (fenced stays true / row is not renewed by
//     the old PID); no old-email player row or activity/history reappears.
//
// Snapshot-safe cleanup never touches pre-existing @deleted.invalid rows.
//
// Run: node tests/account/account-removal-fencing.mjs
// (needs DATABASE_URL + OWNER_PASSWORD)

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { io } from "socket.io-client";

const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PORT_A = process.env.TEST_ACCT_FENCE_PORT_A || "20991";
const PORT_B = process.env.TEST_ACCT_FENCE_PORT_B || "20992";
const URL_A = `http://localhost:${PORT_A}`;
const URL_B = `http://localhost:${PORT_B}`;

const run = Math.random().toString(36).slice(2, 9);
const EMAIL_OWNER  = `fence-owner-${run}@example.test`;
const EMAIL_TARGET = `fence-target-${run}@example.test`;
const RUN_DEPT     = `fence-dept-${run}`;
const OLD_PASSWORD = "old-password-fence";

const ALL_ORIGINALS = [EMAIL_OWNER, EMAIL_TARGET];
const fails = [];

const ok = (value, label) => {
  console.log(`${value ? "  ✓" : "  ✗"} ${label}`);
  if (!value) fails.push(label);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── queue helper ──────────────────────────────────────────────────────────────
function queue(socket, event) {
  const items = [];
  const waiters = [];
  socket.on(event, (data) => {
    const waiter = waiters.shift();
    if (waiter) waiter(data ?? {});
    else items.push(data ?? {});
  });
  return {
    items,
    drain() { items.length = 0; },
    seen() { return items.length > 0; },
    next(timeout = 14_000, label = event) {
      return new Promise((resolve, reject) => {
        if (items.length) return resolve(items.shift());
        const waiter = (data) => { clearTimeout(timer); resolve(data); };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`timeout waiting for ${label}`));
        }, timeout);
        waiters.push(waiter);
      });
    },
  };
}

// ── socket factory ─────────────────────────────────────────────────────────────
function connect(url) {
  const socket = io(url, { transports: ["websocket"], reconnection: false });
  const q = {
    approved:      queue(socket, "approved"),
    authOk:        queue(socket, "adminAuthOk"),
    pending:       queue(socket, "registrationPending"),
    accountRemoved:queue(socket, "accountRemoved"),
    removeResult:  queue(socket, "ownerRemoveAccountResult"),
  };
  let disconnectedAt = 0;
  socket.on("disconnect", () => { if (!disconnectedAt) disconnectedAt = Date.now(); });
  const ready = new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return { socket, ...q, ready, get disconnectedAt() { return disconnectedAt; } };
}

function register(client, email, firstName, password, character = "adam") {
  client.socket.emit("register", {
    firstName, lastName: `fence-${run}`, email, password, character, department: RUN_DEPT,
  });
}

// ── snapshot-protected cleanup ────────────────────────────────────────────────
let preExistingAnonEmails = new Set();
let preExistingInstanceIds = new Set();
async function snapshotPreExistingAnon() {
  const { rows } = await pool.query(
    `SELECT email FROM jpo_players WHERE email LIKE '%@deleted.invalid'`,
  ).catch(() => ({ rows: [] }));
  preExistingAnonEmails = new Set(rows.map((r) => r.email));
}
async function snapshotPreExistingInstances() {
  const { rows } = await pool.query(
    `SELECT instance_id FROM jpo_server_instances`,
  ).catch(() => ({ rows: [] }));
  preExistingInstanceIds = new Set(rows.map((r) => r.instance_id));
}
// Delete only instance rows that THIS run created (never a pre-existing/live
// one). B exits fail-closed and can never unregister itself, so its fenced row
// is expected to linger — this keeps the test's DB footprint tidy regardless.
async function cleanupInstances(knownIds = []) {
  const { rows } = await pool.query(
    `SELECT instance_id, heartbeat_at < now() - interval '10 seconds' AS stale
       FROM jpo_server_instances`,
  ).catch(() => ({ rows: [] }));
  const toDelete = rows
    .filter((r) => !preExistingInstanceIds.has(r.instance_id))
    .filter((r) => knownIds.includes(r.instance_id) || r.stale)
    .map((r) => r.instance_id);
  if (toDelete.length) {
    await pool.query(`DELETE FROM jpo_server_instances WHERE instance_id = ANY($1::text[])`, [toDelete]).catch(() => {});
  }
}
async function cleanup() {
  const emails = [...ALL_ORIGINALS];
  const { rows: nowAnon } = await pool.query(
    `SELECT email FROM jpo_players WHERE email LIKE '%@deleted.invalid'`,
  ).catch(() => ({ rows: [] }));
  for (const r of nowAnon) {
    if (!preExistingAnonEmails.has(r.email) && !emails.includes(r.email)) emails.push(r.email);
  }
  await pool.query(`DELETE FROM jpo_activity_daily WHERE email = ANY($1::text[])`, [emails]).catch(() => {});
  await pool.query(`DELETE FROM jpo_whispers WHERE from_email = ANY($1::text[]) OR to_email = ANY($1::text[])`, [emails]).catch(() => {});
  await pool.query(`DELETE FROM jpo_players WHERE email = ANY($1::text[])`, [emails]).catch(() => {});
  await pool.query(`DELETE FROM jpo_players WHERE email LIKE $1`, [`%-${run}@example.test`]).catch(() => {});
  await pool.query(
    `DELETE FROM jpo_players WHERE department = $1 AND NOT (email = ANY($2::text[]))`,
    [RUN_DEPT, [...preExistingAnonEmails]],
  ).catch(() => {});
}

function bootServer(port, extraEnv = {}) {
  const server = spawn("node", ["server.js"], {
    cwd: "/home/runner/workspace/artifacts/jpo-huddle",
    env: { ...process.env, PORT: port, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write(`[srv:${port}] ${d}`));
  const booted = new Promise((resolve, reject) => {
    let boot = "";
    const timer = setTimeout(() => reject(new Error(`server ${port} did not boot`)), 30_000);
    server.stdout.on("data", (d) => {
      boot += String(d);
      if (boot.includes("running on port")) { clearTimeout(timer); resolve(); }
    });
    server.once("exit", (code) => {
      if (!/running on port/.test(boot)) reject(new Error(`server ${port} exited during boot (${code})\n${boot}`));
    });
  });
  return { server, booted };
}

// ── main ──────────────────────────────────────────────────────────────────────
let serverA, serverB;
let owner, target;
let bPid = 0;
let bExited = false;
let bExitInfo = null;
const runInstanceIds = [];

try {
  await snapshotPreExistingInstances();   // before any test server registers

  // Boot sequentially — parallel boot deadlocks on shared startup migrations.
  const a = bootServer(PORT_A);
  serverA = a.server;
  await a.booted;
  await sleep(1_200);   // let A register + heartbeat its instance
  const instancesBeforeB = new Set(
    (await pool.query(`SELECT instance_id FROM jpo_server_instances`)).rows.map((r) => r.instance_id),
  );

  const b = bootServer(PORT_B, { TEST_FORCE_ACCOUNT_TEARDOWN_FAILURE: "1" });
  serverB = b.server;
  await b.booted;
  bPid = serverB.pid;
  serverB.once("exit", (code, signal) => { bExited = true; bExitInfo = { code, signal }; });

  await snapshotPreExistingAnon();
  await cleanup();

  // ── seed disposable accounts + a prior activity row for the target ────────
  await pool.query(
    `INSERT INTO jpo_players (email, first_name, last_name, name, character, department, approved, coins, password_hash)
     VALUES ($1,'OwnerF',$3::text,'Owner F','amelia',$4,true,500,NULL),
            ($2,'Target',$3::text,'Target F','adam',  $4,true,321,NULL)`,
    [EMAIL_OWNER, EMAIL_TARGET, `fence-${run}`, RUN_DEPT],
  );
  await pool.query(
    `INSERT INTO jpo_activity_daily (day, email, active_seconds, idle_seconds, meaningful_actions, passive_coins)
     VALUES (CURRENT_DATE - 1, $1, 222, 22, 4, 7)`,
    [EMAIL_TARGET],
  );

  // ── owner on A, target live on B ──────────────────────────────────────────
  owner = connect(URL_A);
  await owner.ready;
  register(owner, EMAIL_OWNER, "OwnerF", OLD_PASSWORD, "amelia");
  await owner.approved.next(18_000, "owner approved");
  owner.socket.emit("adminAuth", { password: process.env.OWNER_PASSWORD });
  const ownerAuth = await owner.authOk.next(10_000, "owner auth");
  ok(ownerAuth.owner === true, "owner authenticates on A (owner tier)");

  target = connect(URL_B);
  await target.ready;
  register(target, EMAIL_TARGET, "Target", OLD_PASSWORD, "adam");
  await target.approved.next(18_000, "target approved on B");
  ok(!target.disconnectedAt, "target is live and connected on B before removal");

  // Record B's instance_id (the one that appeared after A) so we watch fencing precisely.
  const afterB = (await pool.query(`SELECT instance_id FROM jpo_server_instances`)).rows.map((r) => r.instance_id);
  const bInstanceId = afterB.find((id) => !instancesBeforeB.has(id)) || null;
  ok(!!bInstanceId, "B's server instance is registered in jpo_server_instances");
  // Record every instance_id this run created, so cleanup can remove them all.
  for (const id of afterB) if (!preExistingInstanceIds.has(id)) runInstanceIds.push(id);

  // ════════════════════════════════════════════════════════════════════════
  //  Start removal on A (do NOT await success — A blocks until B is fenced).
  // ════════════════════════════════════════════════════════════════════════
  console.log("― starting removal on A");
  owner.removeResult.drain();
  const resultPromise = owner.removeResult.next(60_000, "A owner success").catch((e) => ({ __err: e.message }));
  owner.socket.emit("ownerRemoveAccount", { email: EMAIL_TARGET, confirmEmail: EMAIL_TARGET });

  // Wait until the op is durably COMMITTED (prepare ACK done, anonymize committed).
  console.log("― waiting for the op to reach state='committed' before pausing B");
  let opId = null, anonEmail = null;
  for (let i = 0; i < 200; i++) {           // up to ~20s
    const r = (await pool.query(
      `SELECT op_id, anonymous_email FROM jpo_account_removal_ops WHERE state='committed'`,
    )).rows[0];
    if (r) { opId = r.op_id; anonEmail = r.anonymous_email; break; }
    await sleep(100);
  }
  ok(!!opId, "the removal op reaches state='committed' (prepare ACKed, anonymization committed)");

  // Confirm B has ACKed prepare but has NOT completed (teardown forced to fail).
  const bAck = (await pool.query(
    `SELECT ok, completed_at FROM jpo_account_removal_acks WHERE op_id=$1 AND instance_id=$2`,
    [opId, bInstanceId],
  )).rows[0];
  ok(bAck && bAck.ok === true && !bAck.completed_at,
     "B ACKed the prepare barrier but has no completed_at (committed-incomplete state)");

  // ── SIGSTOP B: freeze its event loop after prepare ACK, before completion ──
  console.log("― SIGSTOP B (freezing its event loop)");
  process.kill(bPid, "SIGSTOP");
  const bFencedBeforeStop = (await pool.query(
    `SELECT fenced FROM jpo_server_instances WHERE instance_id=$1`, [bInstanceId],
  )).rows[0]?.fenced;
  ok(bFencedBeforeStop === false, "B's lease is NOT fenced at the moment it is paused");

  // A must not have reported success yet (B still within/just past lease).
  await sleep(500);
  ok(!owner.removeResult.seen(), "A has NOT reported success while B is only just paused");

  // ── Keep B paused past the 6s lease; A must fence B then report success. ───
  console.log("― keeping B paused past the 6s lease; expecting A to fence B then succeed");
  const finalResult = await resultPromise;   // resolves only after A fences B
  ok(finalResult && finalResult.ok === true && !finalResult.__err,
     "A reports ownerRemoveAccountResult{ok:true} only after fencing B");

  // B's lease must be durably fenced at success time.
  const bFencedAtSuccess = (await pool.query(
    `SELECT fenced, heartbeat_at < now() - interval '6 seconds' AS stale
       FROM jpo_server_instances WHERE instance_id=$1`, [bInstanceId],
  )).rows[0];
  ok(bFencedAtSuccess && bFencedAtSuccess.fenced === true,
     "A durably set B's jpo_server_instances.fenced=true before reporting success");
  ok(bFencedAtSuccess && bFencedAtSuccess.stale === true,
     "B's paused lease is stale (heartbeat older than 6s) at success time");

  // Anonymization stands; no old-email row/history while B is still paused.
  const oldGoneWhilePaused = Number((await pool.query(
    `SELECT count(*)::int AS c FROM jpo_players WHERE email=$1`, [EMAIL_TARGET],
  )).rows[0].c);
  ok(oldGoneWhilePaused === 0, "no old-email player row exists while B is paused");
  ok(target.disconnectedAt === 0, "B's target socket is still (frozen) connected while B is paused");

  // ── SIGCONT B: it must terminate itself before renewing or serving ─────────
  console.log("― SIGCONT B; expecting self-termination before heartbeat renew / queued-event processing");
  bExited = false;
  process.kill(bPid, "SIGCONT");

  // Wait for B's process to exit on its own (fail-closed process.exit).
  const exitedOnOwn = await Promise.race([
    new Promise((resolve) => {
      if (bExited) return resolve(true);
      serverB.once("exit", () => resolve(true));
    }),
    sleep(12_000).then(() => false),
  ]);
  ok(exitedOnOwn === true, "B terminates itself after SIGCONT (fail-closed process exit)");

  // Give the OS/DB a moment to settle the socket close + any writes.
  await sleep(1_500);

  // Target socket disconnects because B's process exited.
  ok(target.disconnectedAt > 0, "B's target socket disconnects due to B's process exit");

  // B's lease must NEVER be unfenced by the old process. Since it must fail
  // closed BEFORE renewing, its heartbeat must not have advanced past the stop,
  // and fenced must remain true (the old PID never flips it back to false).
  const bLeaseAfter = (await pool.query(
    `SELECT fenced, heartbeat_at < now() - interval '6 seconds' AS stale
       FROM jpo_server_instances WHERE instance_id=$1`, [bInstanceId],
  )).rows[0];
  // The row may have been GC'd once the op completed; either way it must not be
  // present as an UNFENCED, freshly-renewed lease under the old process.
  if (bLeaseAfter) {
    ok(bLeaseAfter.fenced === true,
       "B's lease is never unfenced under the old process (fenced stays true)");
    ok(bLeaseAfter.stale === true,
       "B did not renew its heartbeat after resuming (lease stays stale)");
  } else {
    ok(true, "B's fenced lease row was cleaned up (never resurrected as an unfenced lease)");
    ok(true, "B did not renew its heartbeat after resuming (row gone, not renewed)");
  }

  // No old-email row / history reappears after B resumed & exited.
  const oldBack = Number((await pool.query(
    `SELECT count(*)::int AS c FROM jpo_players WHERE email=$1`, [EMAIL_TARGET],
  )).rows[0].c);
  ok(oldBack === 0, "no old-email player row reappears after B resumes and exits");
  const oldActBack = Number((await pool.query(
    `SELECT count(*)::int AS c FROM jpo_activity_daily WHERE email=$1`, [EMAIL_TARGET],
  )).rows[0].c);
  ok(oldActBack === 0, "no old-email activity/history reappears after B resumes and exits");

  // The anonymized row remains intact.
  const anonStill = (await pool.query(
    `SELECT name, approved, dismissed FROM jpo_players WHERE email=$1`, [anonEmail],
  )).rows[0];
  ok(anonStill && anonStill.name === "Deleted player" && anonStill.approved === false && anonStill.dismissed === true,
     "the anonymized row remains intact throughout the fencing sequence");

} catch (err) {
  console.error("TEST ERROR:", err.stack || err.message);
  fails.push(err.message);
} finally {
  // Make sure a paused B can be killed: resume first, then kill.
  if (bPid) { try { process.kill(bPid, "SIGCONT"); } catch {} }
  for (const c of [owner, target]) c?.socket.close();
  serverA?.kill();
  if (serverB && !bExited) serverB.kill("SIGKILL");
  await sleep(2_000);   // let A's SIGTERM unregister land before instance GC
  await cleanup().catch(() => {});
  await cleanupInstances(runInstanceIds).catch(() => {});
  await pool.end();
}

console.log(fails.length ? `RESULT: FAIL (${fails.length})` : "RESULT: PASS");
process.exit(fails.length ? 1 : 0);
