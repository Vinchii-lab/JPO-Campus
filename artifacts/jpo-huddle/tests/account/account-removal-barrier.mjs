// Durable account-removal BARRIER contract (task #153, reviewer cases).
//
// The removal barrier is durable, not just a NOTIFY: the owner instance writes a
// jpo_account_removal_ops row plus one jpo_account_removal_targets row per live
// instance, publishes a NOTIFY as a mere wake-up, and then fails closed unless
// EVERY leased target writes a durable ACK into jpo_account_removal_acks. Every
// instance also polls jpo_account_removal_ops every ~200ms, so teardown/ACK does
// not depend on the LISTEN/NOTIFY wake-up at all. A starting process takes the
// SHARED form of an advisory membership lock before it registers/listens/serves,
// while a removal holds the EXCLUSIVE form across its whole transaction — so a
// process cannot appear halfway through a removal barrier.
//
// This test exercises the two reviewer cases with throwaway servers on one DB:
//
//   CASE 1 — durable-poll teardown with the NOTIFY listener disabled
//     Boot server B with TEST_DISABLE_ACCOUNT_REMOVAL_LISTENER=1 (server.js
//     ~13256 skips startAccountRemovalListener but still runs the poll+heartbeat
//     background work). Keep a target live on B, remove it from A, and assert B
//     still tears down its live session AND writes its durable ACK — proving A
//     succeeds through the poll path, not the NOTIFY path.
//
//   CASE 2 — membership lock blocks a starting instance until commit
//     Hold a FOR UPDATE row blocker so A's removal wedges inside anonymizeAccountTx
//     AFTER it has taken the exclusive membership lock. Start server C during that
//     window and assert C does NOT begin serving (its HTTP port never opens) until
//     A commits. Then C boots and cannot restore the now-removed old account.
//
// Snapshot-safe cleanup: pre-existing @deleted.invalid rows are never deleted.
//
// Run: node tests/account/account-removal-barrier.mjs
// (needs DATABASE_URL + OWNER_PASSWORD)

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import { io } from "socket.io-client";

const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PORT_A = process.env.TEST_ACCT_BARRIER_PORT_A || "20971";
const PORT_B = process.env.TEST_ACCT_BARRIER_PORT_B || "20972";
const PORT_C = process.env.TEST_ACCT_BARRIER_PORT_C || "20973";
const URL_A = `http://localhost:${PORT_A}`;
const URL_B = `http://localhost:${PORT_B}`;
const URL_C = `http://localhost:${PORT_C}`;

const run = Math.random().toString(36).slice(2, 9);
const EMAIL_OWNER   = `barrier-owner-${run}@example.test`;
const EMAIL_TARGET1 = `barrier-t1-${run}@example.test`;   // CASE 1 live target on B
const EMAIL_TARGET2 = `barrier-t2-${run}@example.test`;   // CASE 2 removed target
const EMAIL_TARGET3 = `barrier-t3-${run}@example.test`;   // CASE 3 fail-closed target (must survive)
const RUN_DEPT      = `barrier-dept-${run}`;
const OLD_PASSWORD  = "old-password-xyz";
const FAKE_INSTANCE_ID = `fake-ghost-instance-${run}`;    // a lease with no process behind it

const ALL_ORIGINALS = [EMAIL_OWNER, EMAIL_TARGET1, EMAIL_TARGET2, EMAIL_TARGET3];
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
    approved:       queue(socket, "approved"),
    authOk:         queue(socket, "adminAuthOk"),
    authFailed:     queue(socket, "authFailed"),
    loginFailed:    queue(socket, "loginFailed"),
    pending:        queue(socket, "registrationPending"),
    accountRemoved: queue(socket, "accountRemoved"),
    removeResult:   queue(socket, "ownerRemoveAccountResult"),
  };
  const ready = new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return { socket, ...q, ready };
}

function register(client, email, firstName, password, character = "adam") {
  client.socket.emit("register", {
    firstName, lastName: `barrier-${run}`, email, password, character, department: RUN_DEPT,
  });
}

// TCP probe: is anything accepting connections on this port yet?
function portOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port: Number(port) });
    const done = (val) => { sock.destroy(); resolve(val); };
    sock.once("connect", () => done(true));
    sock.once("error", () => resolve(false));
    sock.setTimeout(1_000, () => done(false));
  });
}

// ── snapshot-protected cleanup ────────────────────────────────────────────────
let preExistingAnonEmails = new Set();
const runAnonEmails = new Set();

async function snapshotPreExistingAnon() {
  const { rows } = await pool.query(
    `SELECT email FROM jpo_players WHERE email LIKE '%@deleted.invalid'`,
  ).catch(() => ({ rows: [] }));
  preExistingAnonEmails = new Set(rows.map((r) => r.email));
}

async function locateNewAnonEmail() {
  const { rows } = await pool.query(
    `SELECT email FROM jpo_players WHERE email LIKE '%@deleted.invalid'`,
  ).catch(() => ({ rows: [] }));
  for (const r of rows) {
    if (!preExistingAnonEmails.has(r.email) && !runAnonEmails.has(r.email)) {
      runAnonEmails.add(r.email);
      return r.email;
    }
  }
  return "";
}

async function cleanup() {
  const emails = [...ALL_ORIGINALS, ...runAnonEmails];
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
  let bootLog = "";
  let ready = false;
  server.stdout.on("data", (d) => {
    bootLog += String(d);
    if (bootLog.includes("running on port")) ready = true;
  });
  const booted = new Promise((resolve, reject) => {
    const timer = setInterval(() => { if (ready) { clearInterval(timer); resolve(); } }, 50);
    timer.unref?.();
    const hardTimer = setTimeout(() => { clearInterval(timer); reject(new Error(`server ${port} did not boot\n${bootLog}`)); }, 30_000);
    hardTimer.unref?.();
    server.once("exit", (code) => { if (!ready) reject(new Error(`server ${port} exited during boot (${code})\n${bootLog}`)); });
  });
  return { server, booted, isReady: () => ready };
}

// ── main ──────────────────────────────────────────────────────────────────────
let serverA, serverB, serverC;
let owner, t1onB, restoreProbe;
let blocker;

try {
  // Boot A then B sequentially (shared startup migrations can deadlock if raced).
  const a = bootServer(PORT_A);
  serverA = a.server;
  await a.booted;
  // Server B runs with the NOTIFY listener DISABLED — the test-only hook at
  // server.js ~13256. Poll + heartbeat background work still run.
  const b = bootServer(PORT_B, { TEST_DISABLE_ACCOUNT_REMOVAL_LISTENER: "1" });
  serverB = b.server;
  await b.booted;

  await snapshotPreExistingAnon();
  await cleanup();

  // ── seed disposable accounts (no password → established over a socket) ────
  await pool.query(
    `INSERT INTO jpo_players
       (email, first_name, last_name, name, character, department, approved, coins, cosmetics, last_daily_bonus, password_hash)
     VALUES
       ($1, 'OwnerP', $5, 'Owner Test', 'amelia', $6, true, 500, ARRAY[]::text[], CURRENT_DATE, NULL),
       ($2, 'T1',     $5, 'T1 Test',    'adam',   $6, true, 210, ARRAY[]::text[], CURRENT_DATE, NULL),
       ($3, 'T2',     $5, 'T2 Test',    'bob',    $6, true, 220, ARRAY[]::text[], CURRENT_DATE, NULL),
       ($4, 'T3',     $5, 'T3 Test',    'alex',   $6, true, 230, ARRAY[]::text[], CURRENT_DATE, NULL)`,
    [EMAIL_OWNER, EMAIL_TARGET1, EMAIL_TARGET2, EMAIL_TARGET3, `barrier-${run}`, RUN_DEPT],
  );
  // A history row for the fail-closed target — it must stay keyed to the ORIGINAL
  // email (no rekey to any anonymous identity) because that removal must abort.
  await pool.query(
    `INSERT INTO jpo_activity_daily (day, email, active_seconds, idle_seconds, meaningful_actions, passive_coins)
     VALUES (CURRENT_DATE - 1, $1, 250, 40, 3, 7)`,
    [EMAIL_TARGET3],
  );

  // Owner authenticates on server A.
  owner = connect(URL_A);
  await owner.ready;
  register(owner, EMAIL_OWNER, "OwnerP", OLD_PASSWORD, "amelia");
  await owner.approved.next(18_000, "owner approved");
  owner.socket.emit("adminAuth", { password: process.env.OWNER_PASSWORD });
  const ownerAuth = await owner.authOk.next(10_000, "owner auth");
  ok(ownerAuth.owner === true, "owner authenticates on server A (owner tier)");

  // Sanity: both instances are registered as live in jpo_server_instances.
  await sleep(500);
  const liveInstances = Number((await pool.query(
    `SELECT count(*)::int AS c FROM jpo_server_instances WHERE heartbeat_at > now() - interval '6 seconds'`,
  )).rows[0].c);
  ok(liveInstances >= 2, "both throwaway instances are registered live for the barrier");

  // ════════════════════════════════════════════════════════════════════════
  //  CASE 1 — durable-poll teardown/ACK with B's NOTIFY listener disabled
  // ════════════════════════════════════════════════════════════════════════
  console.log("― CASE 1: durable-poll teardown with NOTIFY listener disabled on B");

  t1onB = connect(URL_B);
  await t1onB.ready;
  register(t1onB, EMAIL_TARGET1, "T1", OLD_PASSWORD, "adam");
  await t1onB.approved.next(18_000, "T1 live on server B");
  ok(t1onB.socket.connected, "CASE1 target is live on server B (listener disabled)");

  // Count ACK rows before, so we can prove a NEW durable ACK from B's instance.
  owner.removeResult.drain();
  t1onB.accountRemoved.drain();

  owner.socket.emit("ownerRemoveAccount", { email: EMAIL_TARGET1, confirmEmail: EMAIL_TARGET1 });

  // B must receive accountRemoved via its own poll-driven teardown (no NOTIFY).
  const t1removed = await t1onB.accountRemoved.next(15_000, "B accountRemoved via poll").catch(() => null);
  ok(t1removed !== null, "server B tears down its live target via the durable poll path (no NOTIFY)");

  const t1result = await owner.removeResult.next(20_000, "A removal result");
  ok(t1result.ok === true,
     "owner removal succeeds — every leased instance ACKed through the durable barrier");

  await Promise.race([
    new Promise((r) => t1onB.socket.on("disconnect", r)),
    (async () => { for (let i = 0; i < 60 && t1onB.socket.connected; i++) await sleep(100); })(),
  ]);
  ok(!t1onB.socket.connected, "server B's target socket is force-disconnected under the poll path");

  const anon1 = await locateNewAnonEmail();
  ok(anon1 !== "", "CASE1 removal produced an anonymous identity");
  const oldRow1 = (await pool.query(`SELECT email FROM jpo_players WHERE email = $1`, [EMAIL_TARGET1])).rows[0];
  ok(!oldRow1, "CASE1 old-email row is gone after the poll-path removal");

  // ════════════════════════════════════════════════════════════════════════
  //  CASE 2 — membership lock blocks a starting instance until commit
  // ════════════════════════════════════════════════════════════════════════
  console.log("― CASE 2: starting server C is blocked until the removal commits");

  // Wedge A's removal AFTER it holds the exclusive membership lock: a FOR UPDATE
  // row lock on target 2 stalls A inside anonymizeAccountTx (which runs after the
  // membership lock at server.js ~9259 and after the barrier wait).
  blocker = await pool.connect();
  await blocker.query("BEGIN");
  await blocker.query(`SELECT * FROM jpo_players WHERE email = $1 FOR UPDATE`, [EMAIL_TARGET2]);
  ok(true, "blocker holds FOR UPDATE on the CASE2 target row");

  owner.removeResult.drain();
  owner.socket.emit("ownerRemoveAccount", { email: EMAIL_TARGET2, confirmEmail: EMAIL_TARGET2 });
  // Let A take the membership lock, create the barrier, collect ACKs from A+B,
  // then wedge on the FOR UPDATE inside anonymizeAccountTx.
  await sleep(2_000);
  ok(!owner.removeResult.seen(),
     "removal is wedged holding the exclusive membership lock (not yet committed)");

  // Start server C during the removal window. Its startup calls
  // registerAccountRemovalInstance() (shared membership lock) BEFORE
  // httpServer.listen(), so it must block — its port must NOT open yet.
  const c = bootServer(PORT_C);
  serverC = c.server;
  // Watch the port for ~2.5s while removal is still wedged: it must stay closed.
  let openedWhileWedged = false;
  for (let i = 0; i < 12; i++) {
    await sleep(200);
    if (await portOpen(PORT_C)) { openedWhileWedged = true; break; }
  }
  ok(!openedWhileWedged && !c.isReady(),
     "server C does NOT begin serving while the removal holds the membership lock");

  // Release the blocker → A commits → membership lock frees → C can register+serve.
  console.log("― releasing the CASE2 blocker");
  await blocker.query("ROLLBACK");
  blocker.release();
  blocker = null;

  const t2result = await owner.removeResult.next(15_000, "CASE2 removal result");
  ok(t2result.ok === true, "CASE2 removal commits once the blocker releases");
  await locateNewAnonEmail();

  // Now C should finish booting and open its port.
  await c.booted;
  ok(c.isReady(), "server C begins serving only AFTER the removal committed");
  // Confirm the port is actually accepting connections.
  let cPortOpen = false;
  for (let i = 0; i < 20 && !cPortOpen; i++) { cPortOpen = await portOpen(PORT_C); if (!cPortOpen) await sleep(150); }
  ok(cPortOpen, "server C's HTTP port is open after the removal committed");

  // C cannot restore the now-removed old account (OLD password login fails).
  restoreProbe = connect(URL_C);
  await restoreProbe.ready;
  restoreProbe.socket.emit("login", { email: EMAIL_TARGET2, password: OLD_PASSWORD });
  const loginOutcome = await Promise.race([
    restoreProbe.loginFailed.next(10_000, "C login failed").then(() => "failed"),
    restoreProbe.approved.next(10_000, "C login approved").then(() => "restored"),
    restoreProbe.pending.next(10_000, "C login pending").then(() => "restored"),
  ]).catch(() => "failed");
  ok(loginOutcome === "failed", "freshly-started server C cannot restore the removed old account");

  const oldRow2 = (await pool.query(`SELECT email FROM jpo_players WHERE email = $1`, [EMAIL_TARGET2])).rows[0];
  ok(!oldRow2, "CASE2 old-email row is gone after removal");

  // ════════════════════════════════════════════════════════════════════════
  //  CASE 3 — fail closed when a leased instance never ACKs
  // ════════════════════════════════════════════════════════════════════════
  // Insert a fresh-looking lease into jpo_server_instances with NO process
  // behind it. createAccountRemovalBarrier leases every instance whose
  // heartbeat is within 6s (server.js ~3524), so this ghost becomes a barrier
  // target that can never write a durable ACK. waitForAccountRemovalBarrier must
  // time out and the whole removal must abort — the account stays registered and
  // nothing is anonymised.
  console.log("― CASE 3: fail closed on a ghost lease that never ACKs");

  const anonBeforeCase3 = (await pool.query(
    `SELECT count(*)::int AS c FROM jpo_players WHERE email LIKE '%@deleted.invalid'`,
  )).rows[0].c;

  await pool.query(
    `INSERT INTO jpo_server_instances (instance_id, started_at, heartbeat_at)
     VALUES ($1, now(), now())
     ON CONFLICT (instance_id) DO UPDATE SET heartbeat_at = now()`,
    [FAKE_INSTANCE_ID],
  );
  ok(true, "inserted a fresh ghost lease with no process behind it");

  // Keep the ghost lease looking alive across the barrier wait: the removal's
  // 10s barrier timeout is longer than the 6s heartbeat freshness window, so
  // without this the ghost would age out and stop being a required ACKer.
  const ghostHeartbeat = setInterval(() => {
    pool.query(
      `UPDATE jpo_server_instances SET heartbeat_at = now() WHERE instance_id = $1`,
      [FAKE_INSTANCE_ID],
    ).catch(() => {});
  }, 1_000);

  owner.removeResult.drain();
  const t3start = Date.now();
  owner.socket.emit("ownerRemoveAccount", { email: EMAIL_TARGET3, confirmEmail: EMAIL_TARGET3 });
  // The barrier waits up to ~10s; allow generous headroom for the ok:false.
  const t3result = await owner.removeResult.next(25_000, "CASE3 fail-closed result");
  const t3elapsed = Date.now() - t3start;
  clearInterval(ghostHeartbeat);

  ok(t3result.ok === false, "ownerRemoveAccount returns ok:false when a leased instance never ACKs");
  ok(t3elapsed >= 8_000, `removal fails closed only after the barrier timeout (waited ${t3elapsed}ms)`);

  // The original account must remain fully intact.
  const t3row = (await pool.query(
    `SELECT approved, dismissed, first_name FROM jpo_players WHERE email = $1`, [EMAIL_TARGET3],
  )).rows[0];
  ok(!!t3row, "the fail-closed target remains registered (row still present)");
  ok(t3row && t3row.approved === true && t3row.dismissed === false,
     "the fail-closed target is still approved and not dismissed");
  ok(t3row && t3row.first_name === "T3",
     "the fail-closed target's profile was not scrubbed/anonymised");

  // No NEW anonymous identity was created for this aborted removal.
  const anonAfterCase3 = (await pool.query(
    `SELECT count(*)::int AS c FROM jpo_players WHERE email LIKE '%@deleted.invalid'`,
  )).rows[0].c;
  ok(Number(anonAfterCase3) === Number(anonBeforeCase3),
     "no anonymous identity is created for the failed removal");

  // History was NOT rekeyed away from the original email.
  const t3activity = Number((await pool.query(
    `SELECT count(*)::int AS c FROM jpo_activity_daily WHERE email = $1`, [EMAIL_TARGET3],
  )).rows[0].c);
  ok(t3activity === 1, "the fail-closed target's history is still keyed to the original email (no rekey)");

  // The transient barrier op/targets/acks for this op were cleaned up on abort.
  const t3ops = Number((await pool.query(
    `SELECT count(*)::int AS c FROM jpo_account_removal_ops WHERE email = $1`, [EMAIL_TARGET3],
  )).rows[0].c);
  ok(t3ops === 0, "the transient removal op row is cleaned up after the failed removal");
  const t3targets = Number((await pool.query(
    `SELECT count(*)::int AS c FROM jpo_account_removal_targets t
       WHERE NOT EXISTS (SELECT 1 FROM jpo_account_removal_ops o WHERE o.op_id = t.op_id)`,
  )).rows[0].c);
  ok(t3targets === 0, "no orphan barrier target rows survive the failed removal");
  const t3acks = Number((await pool.query(
    `SELECT count(*)::int AS c FROM jpo_account_removal_acks a
       WHERE NOT EXISTS (SELECT 1 FROM jpo_account_removal_ops o WHERE o.op_id = a.op_id)`,
  )).rows[0].c);
  ok(t3acks === 0, "no orphan barrier ack rows survive the failed removal");

  // Remove the fake lease now that the assertions are done.
  await pool.query(`DELETE FROM jpo_server_instances WHERE instance_id = $1`, [FAKE_INSTANCE_ID]);
  ok(true, "deleted the fake ghost lease");

  // No orphan barrier op rows left behind by any case.
  const orphanOps = Number((await pool.query(
    `SELECT count(*)::int AS c FROM jpo_account_removal_ops
      WHERE email = ANY($1::text[])`, [[EMAIL_TARGET1, EMAIL_TARGET2, EMAIL_TARGET3]],
  )).rows[0].c);
  ok(orphanOps === 0, "no durable barrier op rows survive for the removed emails");

} catch (err) {
  console.error("TEST ERROR:", err.stack || err.message);
  fails.push(err.message);
} finally {
  try { if (blocker) { await blocker.query("ROLLBACK").catch(() => {}); blocker.release(); } } catch {}
  for (const c of [owner, t1onB, restoreProbe]) c?.socket.close();
  serverA?.kill();
  serverB?.kill();
  serverC?.kill();
  await sleep(300);
  // Belt-and-suspenders: drop the ghost lease even if an assertion threw first.
  await pool.query(`DELETE FROM jpo_server_instances WHERE instance_id = $1`, [FAKE_INSTANCE_ID]).catch(() => {});
  await cleanup().catch(() => {});
  await pool.end();
}

console.log(fails.length ? `RESULT: FAIL (${fails.length})` : "RESULT: PASS");
process.exit(fails.length ? 1 : 0);
