// Cross-process account-removal REVOCATION contract (task #153, final companion).
//
// The server fans an account removal across every running instance over
// PostgreSQL LISTEN/NOTIFY: the owner's instance publishes phase:"prepare" on
// channel jpo_account_removal, every instance runs teardownAccountLocally
// (emit "accountRemoved" → force-disconnect the live socket → ack), the owner's
// instance waits for the acks, THEN anonymizes + commits + reports success
// (server.js ~9130-9166). So a target that is actively logged in on a DIFFERENT
// instance must be signalled and dropped BEFORE the owner instance reports ok.
//
// Two throwaway servers share the one dev DB:
//
//   PHASE 1 — cross-process fanout revocation
//     Target is actively logged in on server B. Owner (on server A) removes it.
//     Assert: B's socket receives "accountRemoved" and disconnects BEFORE A's
//     ownerRemoveAccountResult{ok:true} arrives; and afterwards no old-email row
//     and no late activity write reappears under the old identity.
//
//   PHASE 2 — deterministic concurrent-auth interleaving
//     A second target is logged in on B. A blocker transaction holds
//     `SELECT ... FOR UPDATE` on that target's row so server A's removal wedges
//     inside anonymizeAccountTx AFTER taking the email advisory lock. While
//     wedged, an OLD-password login and an OLD resume token are fired at server
//     B — both must block on the advisory lock and NOT restore a session. Then
//     the blocker releases: removal completes, the live target is forced out,
//     and both the OLD-password login and OLD resume token fail.
//
// Snapshot-safe cleanup: pre-existing @deleted.invalid rows are never deleted.
//
// Run: node tests/account/account-removal-revocation.mjs
// (needs DATABASE_URL + OWNER_PASSWORD; the resume-token half of PHASE 2 also
//  needs SESSION_SECRET — it is skipped with a note when unset.)

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import { io } from "socket.io-client";

const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PORT_A = process.env.TEST_ACCT_REVOKE_PORT_A || "20985";
const PORT_B = process.env.TEST_ACCT_REVOKE_PORT_B || "20986";
const URL_A = `http://localhost:${PORT_A}`;
const URL_B = `http://localhost:${PORT_B}`;

const run = Math.random().toString(36).slice(2, 9);
const EMAIL_OWNER   = `revoke-owner-${run}@example.test`;
const EMAIL_TARGET1 = `revoke-t1-${run}@example.test`;   // PHASE 1 live target
const EMAIL_TARGET2 = `revoke-t2-${run}@example.test`;   // PHASE 2 live target
const RUN_DEPT      = `revoke-dept-${run}`;
const OLD_PASSWORD  = "old-password-abc";

const ALL_ORIGINALS = [EMAIL_OWNER, EMAIL_TARGET1, EMAIL_TARGET2];
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
    authFailed:    queue(socket, "authFailed"),
    loginFailed:   queue(socket, "loginFailed"),
    pending:       queue(socket, "registrationPending"),
    accountRemoved:queue(socket, "accountRemoved"),
    sessionToken:  queue(socket, "sessionToken"),
    removeResult:  queue(socket, "ownerRemoveAccountResult"),
    resumeFailed:  queue(socket, "resumeFailed"),
  };
  // Timestamp the disconnect so we can order it against A's success report.
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
    firstName, lastName: `revoke-${run}`, email, password, character, department: RUN_DEPT,
  });
}

// Craft a resume token exactly as the server signs one (fallback only).
function craftToken(email, iat) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return "";
  const payload = Buffer.from(JSON.stringify({ email, iat })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
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

function bootServer(port) {
  const server = spawn("node", ["server.js"], {
    cwd: "/home/runner/workspace/artifacts/jpo-huddle",
    env: { ...process.env, PORT: port },
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
    server.once("exit", (code) => reject(new Error(`server ${port} exited during boot (${code})\n${boot}`)));
  });
  return { server, booted };
}

// ── main ──────────────────────────────────────────────────────────────────────
let serverA, serverB;
let owner, t1onB, t2onB, authProbe, resumeProbe;
let blocker;

try {
  // Boot sequentially: both processes run the same startup migrations against
  // the shared DB, and racing them there can deadlock on the ledger tables.
  const a = bootServer(PORT_A);
  serverA = a.server;
  await a.booted;
  const b = bootServer(PORT_B);
  serverB = b.server;
  await b.booted;

  await snapshotPreExistingAnon();
  await cleanup();

  // ── seed disposable accounts (no password → established over a socket) ────
  await pool.query(
    `INSERT INTO jpo_players
       (email, first_name, last_name, name, character, department, approved, coins, cosmetics, last_daily_bonus, password_hash)
     VALUES
       ($1, 'OwnerP', $4, 'Owner Test', 'amelia', $5, true, 500, ARRAY[]::text[], CURRENT_DATE, NULL),
       ($2, 'T1',     $4, 'T1 Test',    'adam',   $5, true, 321, ARRAY[]::text[], CURRENT_DATE, NULL),
       ($3, 'T2',     $4, 'T2 Test',    'bob',    $5, true, 654, ARRAY[]::text[], CURRENT_DATE, NULL)`,
    [EMAIL_OWNER, EMAIL_TARGET1, EMAIL_TARGET2, `revoke-${run}`, RUN_DEPT],
  );
  await pool.query(
    `INSERT INTO jpo_activity_daily (day, email, active_seconds, idle_seconds, meaningful_actions, passive_coins)
     VALUES (CURRENT_DATE - 1, $1, 300, 60, 4, 11)`,
    [EMAIL_TARGET1],
  );

  // ── owner authenticates on server A ──────────────────────────────────────
  owner = connect(URL_A);
  await owner.ready;
  register(owner, EMAIL_OWNER, "OwnerP", OLD_PASSWORD, "amelia");
  await owner.approved.next(18_000, "owner approved");
  owner.socket.emit("adminAuth", { password: process.env.OWNER_PASSWORD });
  const ownerAuth = await owner.authOk.next(10_000, "owner auth");
  ok(ownerAuth.owner === true, "owner authenticates on server A (owner tier)");

  // ════════════════════════════════════════════════════════════════════════
  //  PHASE 1 — cross-process fanout revocation
  // ════════════════════════════════════════════════════════════════════════
  console.log("― PHASE 1: cross-process fanout revocation");

  // Target 1 logs in and stays live on server B (establishes its password too).
  t1onB = connect(URL_B);
  await t1onB.ready;
  register(t1onB, EMAIL_TARGET1, "T1", OLD_PASSWORD, "adam");
  await t1onB.approved.next(18_000, "T1 live on server B");
  ok(t1onB.socket.connected, "PHASE1 target is actively logged in on server B");

  // Owner removes target 1 from server A. Capture the exact ordering of B's
  // "accountRemoved" vs A's success report.
  owner.removeResult.drain();
  t1onB.accountRemoved.drain();
  let removedAtB = 0;
  const removedAtBP = t1onB.accountRemoved.next(15_000, "B accountRemoved").then(() => { removedAtB = Date.now(); });

  owner.socket.emit("ownerRemoveAccount", { email: EMAIL_TARGET1, confirmEmail: EMAIL_TARGET1 });
  const t1result = await owner.removeResult.next(20_000, "A removal result");
  const okAtA = Date.now();
  ok(t1result.ok === true, "owner removal of the live target succeeds on server A");

  await Promise.race([removedAtBP, sleep(5_000)]);
  ok(removedAtB > 0, "server B's live target received 'accountRemoved' (cross-process fanout)");
  ok(removedAtB > 0 && removedAtB <= okAtA,
     "server B was signalled BEFORE server A reported success (fanout precedes commit)");

  await Promise.race([
    new Promise((r) => t1onB.socket.on("disconnect", r)),
    sleep(6_000),
  ]);
  ok(!t1onB.socket.connected, "server B's target socket is force-disconnected by the revocation");

  const anon1 = await locateNewAnonEmail();
  ok(anon1 !== "", "PHASE1 removal produced an anonymous identity");

  // No old-email row, and give any late async activity flush a chance to fire —
  // it must NOT recreate the old email.
  await sleep(2_500);
  const oldRow1 = (await pool.query(`SELECT email FROM jpo_players WHERE email = $1`, [EMAIL_TARGET1])).rows[0];
  ok(!oldRow1, "no old-email player row reappears after the live target is revoked");
  const lateActivity1 = Number((await pool.query(
    `SELECT count(*)::int AS c FROM jpo_activity_daily WHERE email = $1`, [EMAIL_TARGET1],
  )).rows[0].c);
  ok(lateActivity1 === 0, "no late history write reappears under the removed old email");
  if (anon1) {
    const anonActivity1 = Number((await pool.query(
      `SELECT count(*)::int AS c FROM jpo_activity_daily WHERE email = $1`, [anon1],
    )).rows[0].c);
    ok(anonActivity1 >= 1, "retained history is owned only by the anonymous identity");
  }

  // ════════════════════════════════════════════════════════════════════════
  //  PHASE 2 — deterministic concurrent-auth interleaving (row blocker)
  // ════════════════════════════════════════════════════════════════════════
  console.log("― PHASE 2: concurrent OLD-password login + OLD resume token during removal");

  // Target 2 logs in on server B; capture its real resume token if issued.
  t2onB = connect(URL_B);
  await t2onB.ready;
  register(t2onB, EMAIL_TARGET2, "T2", OLD_PASSWORD, "bob");
  await t2onB.approved.next(18_000, "T2 live on server B");
  let resumeToken = "";
  const tok = await t2onB.sessionToken.next(4_000, "T2 sessionToken").catch(() => null);
  if (tok?.token) resumeToken = tok.token;
  if (!resumeToken) resumeToken = craftToken(EMAIL_TARGET2, Date.now());  // needs SESSION_SECRET
  ok(t2onB.socket.connected, "PHASE2 target is actively logged in on server B");

  // Wedge server A's removal: hold FOR UPDATE on target 2's row so removal
  // blocks inside anonymizeAccountTx AFTER acquiring the email advisory lock.
  blocker = await pool.connect();
  await blocker.query("BEGIN");
  await blocker.query(`SELECT * FROM jpo_players WHERE email = $1 FOR UPDATE`, [EMAIL_TARGET2]);
  ok(true, "blocker holds FOR UPDATE on the PHASE2 target row");

  owner.removeResult.drain();
  owner.socket.emit("ownerRemoveAccount", { email: EMAIL_TARGET2, confirmEmail: EMAIL_TARGET2 });
  await sleep(1_500);
  ok(!owner.removeResult.seen(),
     "removal is wedged (has the advisory lock, blocked on FOR UPDATE) — not yet complete");

  // While wedged, attempt OLD-password login on a fresh B socket.
  authProbe = connect(URL_B);
  await authProbe.ready;
  authProbe.socket.emit("login", { email: EMAIL_TARGET2, password: OLD_PASSWORD });

  // And attempt an OLD resume token on another fresh B socket (if we have one).
  const haveToken = !!resumeToken;
  if (haveToken) {
    resumeProbe = connect(URL_B);
    await resumeProbe.ready;
    resumeProbe.socket.emit("resumeSession", { token: resumeToken });
  } else {
    console.log("  ℹ  SESSION_SECRET not set — skipping the resume-token half of PHASE 2");
  }

  // Neither may restore a session while removal holds the identity lock.
  await sleep(1_500);
  ok(!authProbe.approved.seen() && !authProbe.pending.seen(),
     "OLD-password login does NOT restore a session while removal holds the lock");
  if (haveToken) {
    ok(!resumeProbe.approved.seen() && !resumeProbe.pending.seen(),
       "OLD resume token does NOT restore a session while removal holds the lock");
  }

  // Release the blocker → removal completes → live target forced out, auth fails.
  console.log("― releasing the PHASE2 blocker");
  await blocker.query("ROLLBACK");
  blocker.release();
  blocker = null;

  const t2result = await owner.removeResult.next(15_000, "PHASE2 removal result");
  ok(t2result.ok === true, "PHASE2 removal completes once the blocker releases");
  await locateNewAnonEmail();

  // The live PHASE2 target must be forced out by the revocation fanout.
  await Promise.race([
    new Promise((r) => t2onB.socket.on("disconnect", r)),
    (async () => { for (let i = 0; i < 60 && t2onB.socket.connected; i++) await sleep(100); })(),
  ]);
  ok(!t2onB.socket.connected, "the live PHASE2 target is forced out after removal completes");

  // OLD-password login ultimately fails (row gone / password scrubbed).
  const loginOutcome = await Promise.race([
    authProbe.loginFailed.next(10_000, "login failed").then(() => "failed"),
    authProbe.approved.next(10_000, "login approved").then(() => "restored"),
    authProbe.pending.next(10_000, "login pending").then(() => "restored"),
  ]).catch(() => "failed");
  ok(loginOutcome === "failed", "OLD-password login fails after removal completes");

  if (haveToken) {
    const resumeOutcome = await Promise.race([
      resumeProbe.resumeFailed.next(10_000, "resume failed").then(() => "failed"),
      resumeProbe.approved.next(10_000, "resume approved").then(() => "restored"),
      resumeProbe.pending.next(10_000, "resume pending").then(() => "restored"),
    ]).catch(() => "failed");
    ok(resumeOutcome === "failed", "OLD resume token fails after removal completes");
  }

  // Old identity fully gone.
  const oldRow2 = (await pool.query(`SELECT email FROM jpo_players WHERE email = $1`, [EMAIL_TARGET2])).rows[0];
  ok(!oldRow2, "PHASE2 old-email row is gone after removal");

} catch (err) {
  console.error("TEST ERROR:", err.stack || err.message);
  fails.push(err.message);
} finally {
  try { if (blocker) { await blocker.query("ROLLBACK").catch(() => {}); blocker.release(); } } catch {}
  for (const c of [owner, t1onB, t2onB, authProbe, resumeProbe]) c?.socket.close();
  serverA?.kill();
  serverB?.kill();
  await cleanup().catch(() => {});
  await pool.end();
}

console.log(fails.length ? `RESULT: FAIL (${fails.length})` : "RESULT: PASS");
process.exit(fails.length ? 1 : 0);
