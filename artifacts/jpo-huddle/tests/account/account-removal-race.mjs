// Account-removal ⇄ re-registration DB race (task #153, focused companion test).
//
// Two throwaway server processes (A and B) share the ONE dev database, so the
// only thing serializing a concurrent "remove this account" (server A) against a
// "Join with the same old email + a NEW password" (server B) is the Postgres
// advisory lock the server takes on the normalized email:
//
//   • removal  → pg_advisory_xact_lock(hashtextextended(email,0))  (server.js ~8916)
//   • register → pg_advisory_lock(hashtextextended(email,0))       (server.js ~7428)
//
// We deterministically wedge the race open by holding a SEPARATE pg transaction
// that does `SELECT ... FOR UPDATE` on the target's jpo_players row. Removal
// acquires the email advisory lock first, then blocks inside anonymizeAccountTx
// at its own `SELECT * FROM jpo_players WHERE email=$1 FOR UPDATE` (server.js
// ~3161) — i.e. AFTER the advisory lock is held. While A is wedged there, a
// register for the same old email is fired at server B: B must block on the
// advisory lock and NOT complete registration until we release the blocker.
//
// After release we assert:
//   • removal succeeds (email row anonymized, old identity gone),
//   • retained history (activity) belongs ONLY to the anonymous identity,
//   • server B then creates a BRAND-NEW pending row for the old email with the
//     NEW password (new password reaches pending; old password is rejected),
//   • the new row carries no old history/assets (fresh coins, no activity).
//
// Snapshot-safe cleanup: pre-existing @deleted.invalid rows are captured before
// the run and never deleted.
//
// Run: node tests/account/account-removal-race.mjs
// (needs DATABASE_URL + OWNER_PASSWORD)

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { io } from "socket.io-client";

const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PORT_A = process.env.TEST_ACCT_RACE_PORT_A || "20989";
const PORT_B = process.env.TEST_ACCT_RACE_PORT_B || "20990";
const URL_A = `http://localhost:${PORT_A}`;
const URL_B = `http://localhost:${PORT_B}`;

const run = Math.random().toString(36).slice(2, 9);
const EMAIL_OWNER  = `race-owner-${run}@example.test`;
const EMAIL_TARGET = `race-target-${run}@example.test`;
const RUN_DEPT     = `race-dept-${run}`;
const OLD_PASSWORD = "old-password-123";
const NEW_PASSWORD = "brand-new-password-456";

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
    if (waiter) waiter(data);
    else items.push(data);
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
    removeResult:  queue(socket, "ownerRemoveAccountResult"),
  };
  const ready = new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return { socket, ...q, ready };
}

function register(client, email, firstName, password, character = "adam") {
  client.socket.emit("register", {
    firstName, lastName: `race-${run}`, email, password, character, department: RUN_DEPT,
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

// Boot one throwaway server, resolve when it prints its ready line.
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
let owner, targetA, racerB, loginProbe;
let blocker;   // dedicated pg client holding the FOR UPDATE row lock

try {
  // Boot sequentially, not in parallel: both processes run the same one-time
  // startup migrations against the shared dev DB, and racing them there can
  // deadlock on the ledger tables. Let A finish its startup work before B begins.
  const a = bootServer(PORT_A);
  serverA = a.server;
  await a.booted;
  const b = bootServer(PORT_B);
  serverB = b.server;
  await b.booted;

  await snapshotPreExistingAnon();
  await cleanup();

  // ── seed disposable accounts ───────────────────────────────────────────
  // Owner + a target seeded WITHOUT a password so we can establish the target's
  // password over a real socket (mirrors a genuine established account).
  await pool.query(
    `INSERT INTO jpo_players
       (email, first_name, last_name, name, character, department, approved, coins, cosmetics, last_daily_bonus, password_hash)
     VALUES
       ($1, 'OwnerP', $3, 'Owner Test',  'amelia', $4, true, 500, ARRAY[]::text[], CURRENT_DATE, NULL),
       ($2, 'Target', $3, 'Target Test', 'adam',   $4, true, 777, ARRAY[]::text[], CURRENT_DATE, NULL)`,
    [EMAIL_OWNER, EMAIL_TARGET, `race-${run}`, RUN_DEPT],
  );
  // Seed activity history for the target — must end up owned ONLY by the anon id.
  await pool.query(
    `INSERT INTO jpo_activity_daily (day, email, active_seconds, idle_seconds, meaningful_actions, passive_coins)
     VALUES (CURRENT_DATE - 1, $1, 500, 100, 9, 42)`,
    [EMAIL_TARGET],
  );

  // ── authenticate owner on server A + establish the target's OLD password ──
  owner = connect(URL_A);
  targetA = connect(URL_A);
  await Promise.all([owner.ready, targetA.ready]);

  register(owner, EMAIL_OWNER, "OwnerP", OLD_PASSWORD, "amelia");
  await owner.approved.next(18_000, "owner approved");
  owner.socket.emit("adminAuth", { password: process.env.OWNER_PASSWORD });
  const ownerAuth = await owner.authOk.next(10_000, "owner auth");
  ok(ownerAuth.owner === true, "owner authenticates on server A (owner tier)");

  // Establish the target's established account (sets password_hash to OLD_PASSWORD).
  register(targetA, EMAIL_TARGET, "Target", OLD_PASSWORD, "adam");
  await targetA.approved.next(18_000, "target established+approved");
  const establishedHash = (await pool.query(
    `SELECT password_hash FROM jpo_players WHERE email = $1`, [EMAIL_TARGET],
  )).rows[0]?.password_hash;
  ok(!!establishedHash, "target is now an established account (password_hash set)");
  // Disconnect the target's live socket so removal has no live session to fight.
  targetA.socket.close();
  await sleep(400);

  // ════════════════════════════════════════════════════════════════════════
  //  Wedge the race open with a FOR UPDATE row lock on the target row.
  // ════════════════════════════════════════════════════════════════════════
  console.log("― acquiring FOR UPDATE blocker on the target player row");
  blocker = await pool.connect();
  await blocker.query("BEGIN");
  await blocker.query(`SELECT * FROM jpo_players WHERE email = $1 FOR UPDATE`, [EMAIL_TARGET]);
  ok(true, "blocker transaction holds FOR UPDATE on the target row");

  // Kick off the owner removal on server A. It will:
  //   grab the email advisory xact lock → pass the approved/dismissed preview →
  //   then BLOCK on its own `SELECT ... FOR UPDATE` inside anonymizeAccountTx.
  console.log("― firing owner removal on server A (will wedge post-advisory-lock)");
  owner.removeResult.drain();
  owner.socket.emit("ownerRemoveAccount", { email: EMAIL_TARGET, confirmEmail: EMAIL_TARGET });

  // Give A time to reach the advisory lock + FOR UPDATE wait.
  await sleep(1_500);
  ok(!owner.removeResult.seen(),
     "removal has NOT completed while the FOR UPDATE blocker is held (wedged after advisory lock)");

  // ── while A is wedged, race a Join for the SAME old email on server B ──────
  console.log("― firing re-registration on server B with a NEW password (same old email)");
  racerB = connect(URL_B);
  await racerB.ready;
  register(racerB, EMAIL_TARGET, "Target", NEW_PASSWORD, "bob");

  // B must NOT finish registration before the blocker releases — it is stuck on
  // the advisory lock that server A's removal transaction holds.
  await sleep(1_500);
  ok(!racerB.pending.seen() && !racerB.approved.seen() && !racerB.authFailed.seen(),
     "server B registration does NOT complete while removal holds the advisory lock");

  // ── release the blocker → A completes removal → B proceeds ────────────────
  console.log("― releasing the blocker");
  await blocker.query("ROLLBACK");
  blocker.release();
  blocker = null;

  const removeRes = await owner.removeResult.next(15_000, "removal result after release");
  ok(removeRes.ok === true, "removal succeeds once the blocker releases");

  const anonEmail = await locateNewAnonEmail();
  ok(anonEmail !== "", "an anonymous @deleted.invalid identity was created by the removal");

  // ── B must now land as a fresh account for the old email ──────────────────
  // Once A commits and unlocks, B re-reads: the old email row is gone, so B
  // creates a brand-new pending account with the NEW password.
  const bOutcome = await Promise.race([
    racerB.pending.next(15_000, "server B pending").then((v) => ({ kind: "pending", v })),
    racerB.approved.next(15_000, "server B approved").then((v) => ({ kind: "approved", v })),
    racerB.authFailed.next(15_000, "server B authFailed").then((v) => ({ kind: "authFailed", v })),
  ]);
  ok(bOutcome.kind !== "authFailed",
     `server B creates a fresh account (not rejected) — outcome=${bOutcome.kind}`);
  // A brand-new email starts unapproved → pending is the expected landing.
  ok(bOutcome.kind === "pending",
     "server B lands the re-registered old email in a NEW pending account");

  // ── DB invariants ─────────────────────────────────────────────────────────
  console.log("― database invariants after the race");
  await sleep(400);

  const newRow = (await pool.query(
    `SELECT email, coins, approved, dismissed, password_hash, first_name FROM jpo_players WHERE email = $1`,
    [EMAIL_TARGET],
  )).rows[0];
  ok(!!newRow, "a fresh row exists again for the old email (re-registration recreated it)");
  if (newRow) {
    ok(newRow.approved === false, "the recreated old-email row is a NEW pending (unapproved) account");
    ok(newRow.password_hash && newRow.password_hash !== establishedHash,
       "the recreated row carries a DIFFERENT (new) password hash, not the old one");
    // Fresh account → no carried-over activity/assets under the old email.
    const carriedActivity = Number((await pool.query(
      `SELECT count(*)::int AS c FROM jpo_activity_daily WHERE email = $1`, [EMAIL_TARGET],
    )).rows[0].c);
    ok(carriedActivity === 0, "the recreated old-email account carries NO old activity history");
  }

  // Retained history belongs ONLY to the anonymous identity.
  if (anonEmail) {
    const anonActivity = Number((await pool.query(
      `SELECT count(*)::int AS c FROM jpo_activity_daily WHERE email = $1`, [anonEmail],
    )).rows[0].c);
    ok(anonActivity >= 1, "the seeded activity history was retained under the anonymous identity");
    const anon = (await pool.query(
      `SELECT approved, first_name FROM jpo_players WHERE email = $1`, [anonEmail],
    )).rows[0];
    ok(anon && anon.approved === false && anon.first_name === "Deleted",
       "the anonymous identity is a scrubbed, non-restorable row");
  }

  // ── credential checks on the fresh account (server A `login`) ─────────────
  console.log("― credential checks on the recreated account");
  loginProbe = connect(URL_A);
  await loginProbe.ready;
  // Old password must fail — it belonged to the removed/anonymized identity.
  loginProbe.socket.emit("login", { email: EMAIL_TARGET, password: OLD_PASSWORD });
  const oldPwResult = await Promise.race([
    loginProbe.loginFailed.next(8_000, "old-password loginFailed").then(() => "failed"),
    loginProbe.approved.next(8_000, "old-password approved").then(() => "approved"),
  ]).catch(() => "failed");
  ok(oldPwResult === "failed", "OLD password is rejected on the recreated account");

  // NEW password authenticates (the recreated account is pending → register path
  // is the ground truth; login of a pending, unapproved account should not drop
  // straight into the office, so we assert the NEW password is at least accepted
  // as the account's credential by re-registering with it).
  loginProbe.pending.drain();
  loginProbe.authFailed.drain();
  register(loginProbe, EMAIL_TARGET, "Target", NEW_PASSWORD, "bob");
  const newPwOutcome = await Promise.race([
    loginProbe.pending.next(10_000, "new-password pending").then(() => "ok"),
    loginProbe.approved.next(10_000, "new-password approved").then(() => "ok"),
    loginProbe.authFailed.next(10_000, "new-password authFailed").then(() => "rejected"),
  ]).catch(() => "rejected");
  ok(newPwOutcome === "ok", "NEW password is accepted as the recreated account's credential");

} catch (err) {
  console.error("TEST ERROR:", err.stack || err.message);
  fails.push(err.message);
} finally {
  try { if (blocker) { await blocker.query("ROLLBACK").catch(() => {}); blocker.release(); } } catch {}
  for (const c of [owner, targetA, racerB, loginProbe]) c?.socket.close();
  serverA?.kill();
  serverB?.kill();
  await cleanup().catch(() => {});
  await pool.end();
}

console.log(fails.length ? `RESULT: FAIL (${fails.length})` : "RESULT: PASS");
process.exit(fails.length ? 1 : 0);
