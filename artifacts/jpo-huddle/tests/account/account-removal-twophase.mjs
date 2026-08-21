// Two-phase account-removal FAILURE contract (task #153, TEST_FORCE hook).
//
// server.js provides a test-only injection point: with
// TEST_FORCE_ACCOUNT_ANONYMIZE_FAILURE=1 the ownerRemoveAccount handler throws
// right AFTER the durable barrier succeeds but BEFORE anonymizeAccountTx runs
// (server.js ~9338). The removal transaction rolls back, the barrier op is
// deleted, and the in-process removal guard is released — so no DURABLE state is
// mutated and the account stays fully registered.
//
// This test drives that path with a single throwaway server and asserts the
// two-phase failure contract:
//   • ownerRemoveAccount returns ok:false,
//   • the original player row / profile / coins / cosmetics are unchanged,
//   • the seeded activity row keeps its original email key and totals,
//   • no @deleted.invalid anonymous row is created,
//   • no transient jpo_account_removal_ops/targets/acks rows survive,
//   • the owner can immediately retry another owner-only action (guard released).
//
// It also puts the target in a removable ephemeral game state (a non-host Bingo
// with a keeper) and — because the barrier's local teardown runs before the
// forced failure — OBSERVES and reports the live-session side effects rather
// than assuming them. See the "live-session observations" section.
//
// Snapshot-safe cleanup: pre-existing @deleted.invalid rows are never deleted.
//
// Run: node tests/account/account-removal-twophase.mjs
// (needs DATABASE_URL + ADMIN_PASSWORD + OWNER_PASSWORD)

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { io } from "socket.io-client";

const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PORT = process.env.TEST_ACCT_TWOPHASE_PORT || "20961";
const URL = `http://localhost:${PORT}`;

const run = Math.random().toString(36).slice(2, 9);
const EMAIL_OWNER  = `twophase-owner-${run}@example.test`;
const EMAIL_TARGET = `twophase-target-${run}@example.test`;
const EMAIL_KEEP   = `twophase-keep-${run}@example.test`;
const RUN_DEPT     = `twophase-dept-${run}`;
const OLD_PASSWORD = "old-password-2phase";
const SEED_COINS   = 4242;
const SEED_COSMETICS = ["hat_party", "shirt_neon"];

const ALL_ORIGINALS = [EMAIL_OWNER, EMAIL_TARGET, EMAIL_KEEP];
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
function connect() {
  const socket = io(URL, { transports: ["websocket"], reconnection: false });
  const q = {
    approved:       queue(socket, "approved"),
    authOk:         queue(socket, "adminAuthOk"),
    accountRemoved: queue(socket, "accountRemoved"),
    removeResult:   queue(socket, "ownerRemoveAccountResult"),
    bingoResult:    queue(socket, "adminBingoResult"),
    bingoNames:     queue(socket, "bingoNames"),
    bingoOver:      queue(socket, "bingoOver"),
    bingoCard:      queue(socket, "bingoCard"),
    chat:           queue(socket, "chatMessage"),
    coinUpdate:     queue(socket, "coinUpdate"),
  };
  let disconnected = false;
  socket.on("disconnect", () => { disconnected = true; });
  const ready = new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return { socket, ...q, ready, isDisconnected: () => disconnected };
}

function register(client, email, firstName, character = "adam") {
  client.socket.emit("register", {
    firstName, lastName: `twophase-${run}`, email, password: OLD_PASSWORD, character, department: RUN_DEPT,
  });
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

function bootServer() {
  const server = spawn("node", ["server.js"], {
    cwd: "/home/runner/workspace/artifacts/jpo-huddle",
    // Force the two-phase anonymize failure for the whole process.
    env: { ...process.env, PORT, TEST_FORCE_ACCOUNT_ANONYMIZE_FAILURE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write(`[srv] ${d}`));
  const booted = new Promise((resolve, reject) => {
    let boot = "";
    const timer = setTimeout(() => reject(new Error("two-phase test server did not boot")), 30_000);
    server.stdout.on("data", (d) => {
      boot += String(d);
      if (boot.includes("running on port")) { clearTimeout(timer); resolve(); }
    });
    server.once("exit", (code) => reject(new Error(`server exited during boot (${code})\n${boot}`)));
  });
  return { server, booted };
}

// ── main ──────────────────────────────────────────────────────────────────────
let server;
let owner, target, keep;

try {
  const s = bootServer();
  server = s.server;
  await s.booted;

  await snapshotPreExistingAnon();
  await cleanup();

  // ── seed disposable accounts with known coins/assets + an activity row ────
  await pool.query(
    `INSERT INTO jpo_players
       (email, first_name, last_name, name, character, department, approved, coins, cosmetics, last_daily_bonus, password_hash)
     VALUES
       ($1, 'OwnerP', $4::text, 'Owner Test',  'amelia', $5, true, 500,        ARRAY[]::text[],   CURRENT_DATE, NULL),
       ($2, 'Target', $4::text, 'Target Test', 'adam',   $5, true, $6::int,    $7::text[],        CURRENT_DATE, NULL),
       ($3, 'Keeper', $4::text, 'Keeper Test', 'alex',   $5, true, 500,        ARRAY[]::text[],   CURRENT_DATE, NULL)`,
    [EMAIL_OWNER, EMAIL_TARGET, EMAIL_KEEP, `twophase-${run}`, RUN_DEPT, SEED_COINS, SEED_COSMETICS],
  );
  await pool.query(
    `INSERT INTO jpo_activity_daily (day, email, active_seconds, idle_seconds, meaningful_actions, passive_coins)
     VALUES (CURRENT_DATE - 1, $1, 512, 64, 8, 21)`,
    [EMAIL_TARGET],
  );

  // ── connect + approve owner, target, keeper ──────────────────────────────
  owner = connect(); target = connect(); keep = connect();
  await Promise.all([owner.ready, target.ready, keep.ready]);
  register(owner, EMAIL_OWNER, "OwnerP", "amelia");
  register(target, EMAIL_TARGET, "Target", "adam");
  register(keep, EMAIL_KEEP, "Keeper", "alex");
  await Promise.all([
    owner.approved.next(18_000, "owner approved"),
    target.approved.next(18_000, "target approved"),
    keep.approved.next(18_000, "keeper approved"),
  ]);

  // Snapshot the LIVE established durable state (after socket registration set
  // the password/profile) — this is what the failed removal must preserve verbatim.
  await sleep(400);
  const beforeRow = (await pool.query(
    `SELECT email, first_name, last_name, name, character, approved, dismissed, coins, cosmetics
       FROM jpo_players WHERE email = $1`, [EMAIL_TARGET],
  )).rows[0];
  const beforeActivity = (await pool.query(
    `SELECT email, active_seconds, idle_seconds, meaningful_actions, passive_coins
       FROM jpo_activity_daily WHERE email = $1 AND day = CURRENT_DATE - 1`, [EMAIL_TARGET],
  )).rows[0];

  owner.socket.emit("adminAuth", { password: process.env.OWNER_PASSWORD });
  const ownerAuth = await owner.authOk.next(10_000, "owner auth");
  ok(ownerAuth.owner === true, "owner authenticates (owner tier)");

  // ── put the target into a removable ephemeral game: non-host Bingo ────────
  // The OWNER hosts Bingo; target + keeper join as NON-host players so a torn
  // roster would be observable (keeper survives, target's slot is the variable).
  console.log("― setting up non-host Bingo with target + keeper");
  owner.socket.emit("adminBingoStart", { prize: 500, mode: "manual", rule: "line" });
  const startRes = await owner.bingoResult.next(10_000, "bingo start");
  ok(startRes.ok === true, "owner starts a Bingo lobby (target/keeper will be non-host)");

  target.socket.emit("bingoJoin");
  await target.bingoCard.next(8_000, "target bingo card");
  keep.socket.emit("bingoJoin");
  await keep.bingoCard.next(8_000, "keeper bingo card");
  await sleep(600);
  const preNames = owner.bingoNames.last()?.names || [];
  ok(preNames.includes("Target") && preNames.includes("Keeper"),
     "both target and keeper are in the Bingo roster before removal");
  owner.bingoNames.drain(); owner.bingoOver.drain();
  target.accountRemoved.drain();

  // ════════════════════════════════════════════════════════════════════════
  //  Trigger the forced two-phase failure removal.
  // ════════════════════════════════════════════════════════════════════════
  console.log("― triggering owner removal (forced anonymize failure)");
  owner.removeResult.drain();
  owner.socket.emit("ownerRemoveAccount", { email: EMAIL_TARGET, confirmEmail: EMAIL_TARGET });
  const removeRes = await owner.removeResult.next(25_000, "forced-failure removal result");

  // ── PRIMARY CONTRACT: the durable two-phase failure guarantees ────────────
  ok(removeRes.ok === false, "ownerRemoveAccount returns ok:false on the forced anonymize failure");

  // Give any late async work a moment; then read durable state.
  await sleep(1_500);

  const afterRow = (await pool.query(
    `SELECT email, first_name, last_name, name, character, approved, dismissed, coins, cosmetics
       FROM jpo_players WHERE email = $1`, [EMAIL_TARGET],
  )).rows[0];
  ok(!!afterRow, "the original player row still exists (registered)");
  ok(afterRow && afterRow.approved === true && afterRow.dismissed === false,
     "the target remains approved and not dismissed");
  ok(afterRow && afterRow.first_name === beforeRow.first_name && afterRow.name === beforeRow.name
       && afterRow.character === beforeRow.character,
     "the target profile is unchanged (name/first_name/character intact)");
  ok(afterRow && Number(afterRow.coins) === Number(beforeRow.coins) && Number(afterRow.coins) === SEED_COINS,
     `the target coins are unchanged (${SEED_COINS})`);
  ok(afterRow && JSON.stringify(afterRow.cosmetics) === JSON.stringify(beforeRow.cosmetics),
     "the target cosmetics/assets are unchanged");

  const afterActivity = (await pool.query(
    `SELECT email, active_seconds, idle_seconds, meaningful_actions, passive_coins
       FROM jpo_activity_daily WHERE email = $1 AND day = CURRENT_DATE - 1`, [EMAIL_TARGET],
  )).rows[0];
  ok(!!afterActivity, "the activity row is still keyed to the ORIGINAL email (no rekey)");
  ok(afterActivity
       && afterActivity.active_seconds === beforeActivity.active_seconds
       && afterActivity.idle_seconds === beforeActivity.idle_seconds
       && afterActivity.meaningful_actions === beforeActivity.meaningful_actions
       && afterActivity.passive_coins === beforeActivity.passive_coins,
     "the activity totals are unchanged");

  const anonCount = Number((await pool.query(
    `SELECT count(*)::int AS c FROM jpo_players
       WHERE email LIKE '%@deleted.invalid' AND NOT (email = ANY($1::text[]))`,
    [[...preExistingAnonEmails]],
  )).rows[0].c);
  ok(anonCount === 0, "no anonymous @deleted.invalid row is created for the failed removal");

  // Transient barrier rows must be gone (op deleted on abort; targets/acks cascade).
  const opRows = Number((await pool.query(
    `SELECT count(*)::int AS c FROM jpo_account_removal_ops WHERE email = $1`, [EMAIL_TARGET],
  )).rows[0].c);
  ok(opRows === 0, "no transient jpo_account_removal_ops row survives the failed removal");
  const orphanTargets = Number((await pool.query(
    `SELECT count(*)::int AS c FROM jpo_account_removal_targets t
       WHERE NOT EXISTS (SELECT 1 FROM jpo_account_removal_ops o WHERE o.op_id = t.op_id)`,
  )).rows[0].c);
  ok(orphanTargets === 0, "no orphan jpo_account_removal_targets rows survive");
  const orphanAcks = Number((await pool.query(
    `SELECT count(*)::int AS c FROM jpo_account_removal_acks a
       WHERE NOT EXISTS (SELECT 1 FROM jpo_account_removal_ops o WHERE o.op_id = a.op_id)`,
  )).rows[0].c);
  ok(orphanAcks === 0, "no orphan jpo_account_removal_acks rows survive");

  // ── LIVE-SESSION CONTRACT ─────────────────────────────────────────────────
  // The forced failure aborts before any observable session revocation: the
  // target keeps its live session and its ephemeral-game membership.
  console.log("― live-session contract");
  ok(!target.accountRemoved.seen(),
     "target does NOT receive 'accountRemoved' on the aborted removal");
  ok(target.socket.connected && !target.isDisconnected(),
     "target socket remains connected after the aborted removal");

  // Bingo roster survives (assert while the game is still running, before cancel).
  const postRosterNames = owner.bingoNames.last()?.names || preNames;
  ok(postRosterNames.includes("Target") && postRosterNames.includes("Keeper"),
     "Bingo roster remains intact (target + keeper still present) after the aborted removal");

  // The still-live target can send an ordinary event after the abort (guard
  // released): a public chatMessage requires a live player row and broadcasts to
  // everyone, so the keeper observing the target's message (by the target's name)
  // proves the target's live session is intact and not guard-blocked.
  keep.chat.drain();
  const chatText = `still-here-${run}`;
  target.socket.emit("chatMessage", { message: chatText });
  const heard = await keep.chat.next(6_000, "keeper hears target chat").catch(() => null);
  ok(heard && heard.message === chatText && heard.name === "Target",
     "the still-live target can send an ordinary event after the abort (keeper heard its chat)");

  // The Bingo game can still be driven/cancelled normally afterwards — and this
  // also proves the owner's own guard is released (an owner-only, host-only action).
  owner.bingoResult.drain(); owner.bingoOver.drain();
  owner.socket.emit("adminBingoCancel");
  const cancelRes = await owner.bingoResult.next(8_000, "owner bingo cancel after abort").catch(() => null);
  ok(cancelRes && cancelRes.ok === true,
     "the surviving Bingo game can still be cancelled normally (owner guard released)");
  const overEvt = await owner.bingoOver.next(8_000, "bingoOver after cancel").catch(() => null);
  ok(overEvt !== null, "cancelling the surviving Bingo game ends it with a bingoOver");

} catch (err) {
  console.error("TEST ERROR:", err.stack || err.message);
  fails.push(err.message);
} finally {
  for (const c of [owner, target, keep]) c?.socket.close();
  server?.kill();
  await sleep(300);
  await cleanup().catch(() => {});
  await pool.end();
}

console.log(fails.length ? `RESULT: FAIL (${fails.length})` : "RESULT: PASS");
process.exit(fails.length ? 1 : 0);
