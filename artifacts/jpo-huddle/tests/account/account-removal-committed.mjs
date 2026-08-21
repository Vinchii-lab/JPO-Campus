// Committed-phase teardown-failure contract (task #153, TEST_FORCE hook).
//
// Two servers:
//   • A — normal. The owner drives ownerRemoveAccount here.
//   • B — booted with TEST_FORCE_ACCOUNT_TEARDOWN_FAILURE=1, and the target is
//     live (registered + approved) on B.
//
// server.js injects a failure INSIDE teardownAccountLocally(email, replacement)
// — i.e. only during the COMMITTED phase, when a replacement (anonymous) email
// is passed (server.js ~3449). The prepare phase and the anonymize COMMIT all
// succeed; the failure only prevents B from finishing its post-commit local
// teardown and writing completed_at.
//
// Contract while B is wedged (removal already committed, remote teardown stuck):
//   • the anonymization is durably COMMITTED: the row is anonymized, the
//     old-email row is gone, activity is rekeyed to the anonymous email;
//   • A does NOT emit ownerRemoveAccountResult{ok:true} yet — it blocks in
//     waitForAccountRemovalCompletion;
//   • the committed op row persists with expires_at IS NULL, and B keeps
//     heartbeating with an ACK whose completed_at IS NULL;
//   • B's live target stays event-guarded: an ordinary chat/game event is
//     silently dropped (a co-located observer never sees it), and neither the
//     OLD password nor a resume token can restore the identity on B.
//
// Then B is HARD-killed (SIGKILL, so it cannot unregister its instance row).
// After B's heartbeat lease goes stale (>6s), the contract completes:
//   • A finally emits ownerRemoveAccountResult{ok:true} (no live remote process
//     remains — the stale lease is treated as complete);
//   • the committed op row is cleaned up;
//   • no old-email player row or old-email activity/history reappears.
//
// Snapshot-safe cleanup never touches pre-existing @deleted.invalid rows.
//
// Run: node tests/account/account-removal-committed.mjs
// (needs DATABASE_URL + OWNER_PASSWORD; the resume-token probe also uses
//  SESSION_SECRET when set, else falls back to a real captured token.)

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import { io } from "socket.io-client";

const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PORT_A = process.env.TEST_ACCT_COMMITTED_PORT_A || "20987";
const PORT_B = process.env.TEST_ACCT_COMMITTED_PORT_B || "20988";
const URL_A = `http://localhost:${PORT_A}`;
const URL_B = `http://localhost:${PORT_B}`;

const run = Math.random().toString(36).slice(2, 9);
const EMAIL_OWNER  = `committed-owner-${run}@example.test`;
const EMAIL_TARGET = `committed-target-${run}@example.test`;
const EMAIL_OBS    = `committed-obs-${run}@example.test`;
const RUN_DEPT     = `committed-dept-${run}`;
const OLD_PASSWORD = "old-password-committed";

const ALL_ORIGINALS = [EMAIL_OWNER, EMAIL_TARGET, EMAIL_OBS];
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
    last() { return items.length ? items[items.length - 1] : null; },
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
    chat:          queue(socket, "chatMessage"),
  };
  let disconnected = false;
  socket.on("disconnect", () => { disconnected = true; });
  const ready = new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return { socket, ...q, ready, isDisconnected: () => disconnected };
}

function register(client, email, firstName, password, character = "adam") {
  client.socket.emit("register", {
    firstName, lastName: `committed-${run}`, email, password, character, department: RUN_DEPT,
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
async function snapshotPreExistingAnon() {
  const { rows } = await pool.query(
    `SELECT email FROM jpo_players WHERE email LIKE '%@deleted.invalid'`,
  ).catch(() => ({ rows: [] }));
  preExistingAnonEmails = new Set(rows.map((r) => r.email));
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
let owner, target, observer, loginProbe, resumeProbe;

try {
  // Boot sequentially — parallel boot deadlocks on shared startup migrations.
  const a = bootServer(PORT_A);
  serverA = a.server;
  await a.booted;
  const b = bootServer(PORT_B, { TEST_FORCE_ACCOUNT_TEARDOWN_FAILURE: "1" });
  serverB = b.server;
  await b.booted;

  await snapshotPreExistingAnon();
  await cleanup();

  // ── seed disposable accounts + a prior activity row for the target ────────
  await pool.query(
    `INSERT INTO jpo_players (email, first_name, last_name, name, character, department, approved, coins, password_hash)
     VALUES ($1,'OwnerC',$4::text,'Owner C','amelia',$5,true,500,NULL),
            ($2,'Target',$4::text,'Target C','adam',  $5,true,777,NULL),
            ($3,'Observ',$4::text,'Observer','alex',  $5,true,500,NULL)`,
    [EMAIL_OWNER, EMAIL_TARGET, EMAIL_OBS, `committed-${run}`, RUN_DEPT],
  );
  await pool.query(
    `INSERT INTO jpo_activity_daily (day, email, active_seconds, idle_seconds, meaningful_actions, passive_coins)
     VALUES (CURRENT_DATE - 1, $1, 333, 33, 5, 9)`,
    [EMAIL_TARGET],
  );

  // ── owner authenticates on A ──────────────────────────────────────────────
  owner = connect(URL_A);
  await owner.ready;
  register(owner, EMAIL_OWNER, "OwnerC", OLD_PASSWORD, "amelia");
  await owner.approved.next(18_000, "owner approved");
  owner.socket.emit("adminAuth", { password: process.env.OWNER_PASSWORD });
  const ownerAuth = await owner.authOk.next(10_000, "owner auth");
  ok(ownerAuth.owner === true, "owner authenticates on server A (owner tier)");

  // ── target + observer live on B ───────────────────────────────────────────
  target = connect(URL_B);
  observer = connect(URL_B);
  await Promise.all([target.ready, observer.ready]);
  register(target, EMAIL_TARGET, "Target", OLD_PASSWORD, "adam");
  register(observer, EMAIL_OBS, "Observ", OLD_PASSWORD, "alex");
  await Promise.all([
    target.approved.next(18_000, "target approved on B"),
    observer.approved.next(18_000, "observer approved on B"),
  ]);
  // Capture a real resume token for the target if the server issues one.
  let resumeToken = "";
  const tok = await target.sessionToken.next(4_000, "target sessionToken").catch(() => null);
  if (tok?.token) resumeToken = tok.token;
  if (!resumeToken) resumeToken = craftToken(EMAIL_TARGET, Date.now());

  // Prove ordinary events flow BEFORE removal: target chat reaches the observer.
  observer.chat.drain();
  target.socket.emit("chatMessage", { message: `pre-${run}` });
  const preHeard = await observer.chat.next(6_000, "observer hears pre chat").catch(() => null);
  ok(preHeard && preHeard.message === `pre-${run}` && preHeard.name === "Target",
     "before removal, the target's ordinary chat reaches the observer on B");

  // ════════════════════════════════════════════════════════════════════════
  //  Trigger removal on A. Do NOT await the result — A blocks in
  //  waitForAccountRemovalCompletion because B never writes completed_at.
  // ════════════════════════════════════════════════════════════════════════
  console.log("― triggering owner removal on A (B teardown will be forced to fail)");
  owner.removeResult.drain();
  const resultPromise = owner.removeResult.next(45_000, "A owner success").catch((e) => ({ __err: e.message }));
  owner.socket.emit("ownerRemoveAccount", { email: EMAIL_TARGET, confirmEmail: EMAIL_TARGET });

  // Give the barrier + anonymize commit time to land (prepare 10s cap + commit).
  await sleep(4_000);

  // ── WEDGED STATE ASSERTIONS ───────────────────────────────────────────────
  console.log("― wedged state (committed, remote teardown stuck)");

  // 1) Anonymization committed: old-email row gone, one new anon row, name scrubbed.
  const oldRow = (await pool.query(`SELECT email FROM jpo_players WHERE email=$1`, [EMAIL_TARGET])).rows[0];
  ok(!oldRow, "the old-email player row is gone (anonymization committed)");
  const { rows: anonRows } = await pool.query(
    `SELECT email, name, approved, dismissed, first_name FROM jpo_players
       WHERE email LIKE '%@deleted.invalid' AND NOT (email = ANY($1::text[]))`,
    [[...preExistingAnonEmails]],
  );
  ok(anonRows.length === 1, "exactly one new anonymous @deleted.invalid row exists");
  const anonRow = anonRows[0];
  ok(anonRow && anonRow.name === "Deleted player" && anonRow.approved === false && anonRow.dismissed === true,
     "the anonymous row is scrubbed (name 'Deleted player', approved=false, dismissed=true)");
  // Activity rekeyed to the anon email; nothing left under the old email.
  const oldActivity = Number((await pool.query(
    `SELECT count(*)::int AS c FROM jpo_activity_daily WHERE email=$1`, [EMAIL_TARGET],
  )).rows[0].c);
  ok(oldActivity === 0, "no activity/history remains under the old email (rekeyed on commit)");

  // 2) A has NOT emitted owner success yet (blocked on completion).
  ok(!owner.removeResult.seen(),
     "A does NOT emit ownerRemoveAccountResult while B's teardown is stuck");

  // 3) Committed op persists with expires_at NULL; B still heartbeats; B ack has no completed_at.
  const opRow = (await pool.query(
    `SELECT state, expires_at, email FROM jpo_account_removal_ops
       WHERE anonymous_email=$1`, [anonRow.email],
  )).rows[0];
  ok(opRow && opRow.state === "committed", "the durable op is in state 'committed'");
  ok(opRow && opRow.expires_at === null, "the committed op has expires_at IS NULL");
  ok(opRow && opRow.email === null, "the committed op no longer stores the old email");

  const opId = (await pool.query(
    `SELECT op_id FROM jpo_account_removal_ops WHERE anonymous_email=$1`, [anonRow.email],
  )).rows[0]?.op_id;
  const { rows: ackRows } = await pool.query(
    `SELECT a.instance_id, a.ok, a.completed_at, s.heartbeat_at,
            (s.heartbeat_at >= now() - interval '6 seconds') AS live
       FROM jpo_account_removal_acks a
       LEFT JOIN jpo_server_instances s ON s.instance_id = a.instance_id
      WHERE a.op_id=$1`, [opId],
  );
  const stuckLive = ackRows.filter((r) => r.ok && !r.completed_at && r.live);
  ok(stuckLive.length >= 1,
     "at least one live-heartbeating instance (B) has an ACK with completed_at IS NULL");

  // 4) B's live target stays event-guarded: chat is silently dropped.
  observer.chat.drain();
  target.socket.emit("chatMessage", { message: `guarded-${run}` });
  const guardedHeard = await observer.chat.next(3_500, "observer hears guarded chat").catch(() => null);
  ok(guardedHeard === null,
     "B's live target is event-guarded — its ordinary chat/game event is not processed");

  // 5) Neither old password nor resume token can restore the identity on B.
  loginProbe = connect(URL_B);
  await loginProbe.ready;
  loginProbe.socket.emit("login", { email: EMAIL_TARGET, password: OLD_PASSWORD });
  const loginOutcome = await Promise.race([
    loginProbe.loginFailed.next(8_000, "old-password loginFailed").then(() => "failed"),
    loginProbe.authFailed.next(8_000, "old-password authFailed").then(() => "failed"),
    loginProbe.approved.next(8_000, "old-password approved").then(() => "restored"),
    sleep(8_500).then(() => "no-restore"),
  ]).catch(() => "no-restore");
  ok(loginOutcome !== "restored", `the OLD password cannot restore the identity on B (${loginOutcome})`);

  const haveToken = !!resumeToken;
  if (haveToken) {
    resumeProbe = connect(URL_B);
    await resumeProbe.ready;
    resumeProbe.socket.emit("resumeSession", { token: resumeToken });
    const resumeOutcome = await Promise.race([
      resumeProbe.resumeFailed.next(8_000, "resumeFailed").then(() => "failed"),
      resumeProbe.approved.next(8_000, "resume approved").then(() => "restored"),
      sleep(8_500).then(() => "no-restore"),
    ]).catch(() => "no-restore");
    ok(resumeOutcome !== "restored", `an OLD resume token cannot restore the identity on B (${resumeOutcome})`);
  } else {
    ok(true, "resume-token probe skipped (no SESSION_SECRET and no issued token)");
  }

  // Confirm A is STILL blocked right before we free it.
  ok(!owner.removeResult.seen(),
     "A is still blocked (no success) up to the moment B is terminated");

  // ════════════════════════════════════════════════════════════════════════
  //  Terminate B hard (SIGKILL so it cannot unregister its instance row).
  //  After its heartbeat lease goes stale (>6s), A must finish.
  // ════════════════════════════════════════════════════════════════════════
  console.log("― hard-killing B; waiting for its heartbeat lease to go stale");
  serverB.kill("SIGKILL");
  serverB = null;

  const finalResult = await resultPromise;   // A resolves once B is stale (~6-8s)
  ok(finalResult && finalResult.ok === true && !finalResult.__err,
     "A finishes with ownerRemoveAccountResult{ok:true} once no live remote process remains");

  await sleep(1_500);

  // Op cleaned up.
  const opGone = Number((await pool.query(
    `SELECT count(*)::int AS c FROM jpo_account_removal_ops WHERE op_id=$1`, [opId],
  )).rows[0].c);
  ok(opGone === 0, "the committed op row is cleaned up after completion");

  // No old-email row / history reappears.
  const oldBack = Number((await pool.query(
    `SELECT count(*)::int AS c FROM jpo_players WHERE email=$1`, [EMAIL_TARGET],
  )).rows[0].c);
  ok(oldBack === 0, "no old-email player row reappears after completion");
  const oldActBack = Number((await pool.query(
    `SELECT count(*)::int AS c FROM jpo_activity_daily WHERE email=$1`, [EMAIL_TARGET],
  )).rows[0].c);
  ok(oldActBack === 0, "no old-email activity/history reappears after completion");

  // The anonymized row is still present and intact.
  const anonStill = (await pool.query(
    `SELECT name, approved, dismissed FROM jpo_players WHERE email=$1`, [anonRow.email],
  )).rows[0];
  ok(anonStill && anonStill.name === "Deleted player" && anonStill.approved === false,
     "the anonymized row remains intact after completion");

} catch (err) {
  console.error("TEST ERROR:", err.stack || err.message);
  fails.push(err.message);
} finally {
  for (const c of [owner, target, observer, loginProbe, resumeProbe]) c?.socket.close();
  serverA?.kill();
  serverB?.kill("SIGKILL");
  await sleep(500);
  await cleanup().catch(() => {});
  await pool.end();
}

console.log(fails.length ? `RESULT: FAIL (${fails.length})` : "RESULT: PASS");
process.exit(fails.length ? 1 : 0);
