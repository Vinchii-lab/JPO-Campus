// Account-removal ephemeral game teardown (task #153, focused companion test).
//
// Verifies that removing an account cleanly tears down the two owner/admin-hosted
// ephemeral office games WITHOUT paying or retaining the removed identity:
//
//   (1) BINGO — a non-host target that joined vanishes from the game's name list
//       and internal state when its account is removed, but the game itself is
//       NOT cancelled (a live host + remaining players keep playing). The host
//       can then still cancel the game normally.
//
//   (2) DEAL OR NO DEAL — because deal payouts are computed from an email list
//       captured before a delayed reveal timer fires, removing a participant
//       cancels the whole show. No participant is paid, and the removed email is
//       left in no delayed/queued state.
//
// Throwaway server, disposable @example.test accounts only, full cleanup in
// `finally`. Cleanup snapshots pre-existing @deleted.invalid rows so it can only
// delete anonymous rows THIS run created.
//
// Run: node tests/account/account-removal-games.mjs
// (needs DATABASE_URL + ADMIN_PASSWORD + OWNER_PASSWORD)

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { io } from "socket.io-client";

const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PORT = process.env.TEST_ACCT_REMOVE_GAMES_PORT || "20998";
const URL = `http://localhost:${PORT}`;

const run = Math.random().toString(36).slice(2, 9);
// Disposable identities (RFC 2606 reserved domain — never real accounts).
const EMAIL_OWNER   = `arg-owner-${run}@example.test`;
const EMAIL_HOST    = `arg-host-${run}@example.test`;   // separate admin who hosts Bingo
const EMAIL_BTARGET = `arg-btarget-${run}@example.test`;// bingo target to be removed
const EMAIL_BKEEP   = `arg-bkeep-${run}@example.test`;  // stays so bingo isn't emptied
const EMAIL_DTARGET = `arg-dtarget-${run}@example.test`;// deal target to be removed
const EMAIL_DKEEP   = `arg-dkeep-${run}@example.test`;  // second deal participant
const RUN_DEPT      = `arg-dept-${run}`;

const ALL_ORIGINALS = [EMAIL_OWNER, EMAIL_HOST, EMAIL_BTARGET, EMAIL_BKEEP, EMAIL_DTARGET, EMAIL_DKEEP];
const fails = [];

const ok = (value, label) => {
  console.log(`${value ? "  ✓" : "  ✗"} ${label}`);
  if (!value) fails.push(label);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── queue helper (same pattern as activity-reporting.mjs) ─────────────────────
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
function connect(email, firstName, character) {
  const socket = io(URL, { transports: ["websocket"], reconnection: false });
  const approved = queue(socket, "approved");
  const authOk   = queue(socket, "adminAuthOk");
  const removeResult = queue(socket, "ownerRemoveAccountResult");
  const bingoNames = queue(socket, "bingoNames");
  const bingoResult = queue(socket, "adminBingoResult");
  const bingoOver = queue(socket, "bingoOver");
  const bingoCard = queue(socket, "bingoCard");
  const dealNames = queue(socket, "dealNames");
  const dealResult = queue(socket, "ownerDealResult");
  const dealOver = queue(socket, "dealOver");
  const dealYouIn = queue(socket, "dealYouIn");
  const coinUpdate = queue(socket, "coinUpdate");
  const ready = new Promise((resolve, reject) => {
    socket.once("connect", () => {
      socket.emit("register", {
        firstName,
        lastName: `arg-${run}`,
        email,
        password: "testpass123",
        character,
        department: RUN_DEPT,
      });
      resolve();
    });
    socket.once("connect_error", reject);
  });
  return {
    socket, approved, authOk, removeResult,
    bingoNames, bingoResult, bingoOver, bingoCard,
    dealNames, dealResult, dealOver, dealYouIn, coinUpdate, ready,
  };
}

// ── snapshot-protected cleanup ────────────────────────────────────────────────
let preExistingAnonEmails = new Set();
const runAnonEmails = new Set();  // anon emails this run created (tracked as we see them)

async function snapshotPreExistingAnon() {
  const { rows } = await pool.query(
    `SELECT email FROM jpo_players WHERE email LIKE '%@deleted.invalid'`,
  ).catch(() => ({ rows: [] }));
  preExistingAnonEmails = new Set(rows.map((r) => r.email));
}

async function cleanup() {
  const emails = [...ALL_ORIGINALS, ...runAnonEmails];

  // Only delete @deleted.invalid rows NOT present in the pre-test snapshot.
  const { rows: nowAnon } = await pool.query(
    `SELECT email FROM jpo_players WHERE email LIKE '%@deleted.invalid'`,
  ).catch(() => ({ rows: [] }));
  for (const r of nowAnon) {
    if (!preExistingAnonEmails.has(r.email) && !emails.includes(r.email)) emails.push(r.email);
  }

  await pool.query(`DELETE FROM jpo_activity_daily WHERE email = ANY($1::text[])`, [emails]).catch(() => {});
  await pool.query(`DELETE FROM jpo_whispers WHERE from_email = ANY($1::text[]) OR to_email = ANY($1::text[])`, [emails]).catch(() => {});
  await pool.query(`DELETE FROM jpo_players WHERE email = ANY($1::text[])`, [emails]).catch(() => {});
  // Residual @example.test rows from this run (never anonymous — snapshot-safe).
  await pool.query(`DELETE FROM jpo_players WHERE email LIKE $1`, [`%-${run}@example.test`]).catch(() => {});
  // Any row still carrying the run department marker, EXCEPT pre-existing anon rows.
  await pool.query(
    `DELETE FROM jpo_players WHERE department = $1 AND NOT (email = ANY($2::text[]))`,
    [RUN_DEPT, [...preExistingAnonEmails]],
  ).catch(() => {});
}

// Find the anon email a removal produced (by matching an activity row we seeded,
// or by the difference from the pre-test snapshot).
async function locateNewAnonEmail(seededActivityEmailOrNull) {
  if (seededActivityEmailOrNull) {
    // No activity seeded here; fall through to snapshot diff.
  }
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

// ── main ──────────────────────────────────────────────────────────────────────
let server;
let owner, host, bTarget, bKeep, dTarget, dKeep;

try {
  // ── boot throwaway server ──────────────────────────────────────────────
  // Long game join windows so the join-timer never auto-begins/cancels a game
  // out from under the test; we drive every transition explicitly.
  server = spawn("node", ["server.js"], {
    cwd: "/home/runner/workspace/artifacts/jpo-huddle",
    env: {
      ...process.env,
      PORT,
      BINGO_JOIN_MS: "120000",
      DEAL_JOIN_MS: "120000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write(`[srv] ${d}`));
  let boot = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("game-teardown test server did not boot")), 30_000);
    server.stdout.on("data", (d) => {
      boot += String(d);
      if (boot.includes("running on port")) { clearTimeout(timer); resolve(); }
    });
    server.once("exit", (code) => reject(new Error(`server exited during boot (${code})\n${boot}`)));
  });

  await snapshotPreExistingAnon();
  await cleanup();

  // ── seed accounts ──────────────────────────────────────────────────────
  await pool.query(
    `INSERT INTO jpo_players
       (email, first_name, last_name, name, character, department, approved, coins, cosmetics, last_daily_bonus, password_hash)
     VALUES
       ($1, 'OwnerP', $7, 'Owner Test',  'amelia', $8, true, 1000, ARRAY[]::text[], CURRENT_DATE, NULL),
       ($2, 'Host',   $7, 'Host Test',   'bob',    $8, true, 1000, ARRAY[]::text[], CURRENT_DATE, NULL),
       ($3, 'BTgt',   $7, 'BTarget Test','adam',   $8, true, 1000, ARRAY[]::text[], CURRENT_DATE, NULL),
       ($4, 'BKeep',  $7, 'BKeep Test',  'alex',   $8, true, 1000, ARRAY[]::text[], CURRENT_DATE, NULL),
       ($5, 'DTgt',   $7, 'DTarget Test','adam',   $8, true, 1000, ARRAY[]::text[], CURRENT_DATE, NULL),
       ($6, 'DKeep',  $7, 'DKeep Test',  'alex',   $8, true, 1000, ARRAY[]::text[], CURRENT_DATE, NULL)`,
    [EMAIL_OWNER, EMAIL_HOST, EMAIL_BTARGET, EMAIL_BKEEP, EMAIL_DTARGET, EMAIL_DKEEP, `arg-${run}`, RUN_DEPT],
  );

  // ── connect & approve ──────────────────────────────────────────────────
  owner   = connect(EMAIL_OWNER,   "OwnerP", "amelia");
  host    = connect(EMAIL_HOST,    "Host",   "bob");
  bTarget = connect(EMAIL_BTARGET, "BTgt",   "adam");
  bKeep   = connect(EMAIL_BKEEP,   "BKeep",  "alex");
  dTarget = connect(EMAIL_DTARGET, "DTgt",   "adam");
  dKeep   = connect(EMAIL_DKEEP,   "DKeep",  "alex");

  const all = [owner, host, bTarget, bKeep, dTarget, dKeep];
  await Promise.all(all.map((c) => c.ready));
  await Promise.all([
    owner.approved.next(18_000, "owner approved"),
    host.approved.next(18_000, "host approved"),
    bTarget.approved.next(18_000, "bTarget approved"),
    bKeep.approved.next(18_000, "bKeep approved"),
    dTarget.approved.next(18_000, "dTarget approved"),
    dKeep.approved.next(18_000, "dKeep approved"),
  ]);

  // Auth: owner (owner key) + host (plain admin, so it can host bingo).
  owner.socket.emit("adminAuth", { password: process.env.OWNER_PASSWORD });
  const ownerAuth = await owner.authOk.next(10_000, "owner auth");
  ok(ownerAuth.owner === true, "owner password grants the owner tier");

  host.socket.emit("adminAuth", { password: process.env.ADMIN_PASSWORD });
  const hostAuth = await host.authOk.next(10_000, "host (plain admin) auth");
  ok(hostAuth.owner === false, "bingo host authenticates as a plain admin (not owner)");

  // ════════════════════════════════════════════════════════════════════════
  //  TEST 1 — BINGO: removing a non-host participant does not cancel the game
  // ════════════════════════════════════════════════════════════════════════
  console.log("― TEST 1: Bingo non-host removal");

  // Host (a DIFFERENT admin from the owner) starts a bingo lobby.
  host.socket.emit("adminBingoStart", { prize: 500, mode: "manual", rule: "line" });
  const startRes = await host.bingoResult.next(10_000, "bingo start result");
  ok(startRes.ok === true && startRes.isHost === true, "plain-admin host starts a Bingo lobby");

  // The target and a keeper both join.
  bTarget.socket.emit("bingoJoin");
  await bTarget.bingoCard.next(8_000, "bTarget card");
  bKeep.socket.emit("bingoJoin");
  await bKeep.bingoCard.next(8_000, "bKeep card");

  // Everyone should see both names. Wait for the latest broadcast.
  await sleep(600);
  const preNames = host.bingoNames.items.length
    ? host.bingoNames.items[host.bingoNames.items.length - 1].names
    : [];
  ok(preNames.includes("BTgt") && preNames.includes("BKeep"),
     "both players appear in the Bingo name list before removal");
  host.bingoNames.drain();
  host.bingoOver.drain();

  // Owner removes the non-host target.
  owner.socket.emit("ownerRemoveAccount", { email: EMAIL_BTARGET, confirmEmail: EMAIL_BTARGET });
  const bRemoveRes = await owner.removeResult.next(15_000, "bingo target removal result");
  ok(bRemoveRes.ok === true, "owner removes the non-host Bingo participant (ok:true)");
  await locateNewAnonEmail(null);

  // The name list must update WITHOUT the removed target, but the game must NOT end.
  const postNames = await host.bingoNames.next(8_000, "post-removal bingoNames");
  ok(!postNames.names.includes("BTgt"), "removed target disappears from the Bingo name list");
  ok(postNames.names.includes("BKeep"), "remaining player is still listed in Bingo");

  // No bingoOver should have fired (a non-host, non-emptying removal keeps the game live).
  await sleep(1_000);
  ok(host.bingoOver.items.length === 0,
     "Bingo game is NOT cancelled by removing a non-host participant");

  // The host can still cancel the (still-running) game normally.
  host.bingoResult.drain();
  host.socket.emit("adminBingoCancel");
  const cancelRes = await host.bingoResult.next(8_000, "bingo cancel result");
  ok(cancelRes.ok === true, "host can still cancel the surviving Bingo game");
  const overAfterCancel = await host.bingoOver.next(8_000, "bingoOver after host cancel");
  ok(overAfterCancel !== null, "host cancel ends the Bingo game with a bingoOver event");

  // ════════════════════════════════════════════════════════════════════════
  //  TEST 2 — DEAL OR NO DEAL: removing a participant cancels the show, no pay
  // ════════════════════════════════════════════════════════════════════════
  console.log("― TEST 2: Deal or No Deal participant removal cancels the show");

  // Record participant coin balances before the show.
  const dTargetCoinsBefore = Number((await pool.query(
    `SELECT coins FROM jpo_players WHERE email = $1`, [EMAIL_DTARGET],
  )).rows[0].coins);
  const dKeepCoinsBefore = Number((await pool.query(
    `SELECT coins FROM jpo_players WHERE email = $1`, [EMAIL_DKEEP],
  )).rows[0].coins);

  // Owner hosts the show; two participants join.
  owner.socket.emit("ownerDealStart", { jackpot: 5000, voteSec: 8 });
  const dealStartRes = await owner.dealResult.next(10_000, "deal start result");
  ok(dealStartRes.ok === true && dealStartRes.active === true, "owner starts a Deal or No Deal show");

  dTarget.socket.emit("dealJoin");
  await dTarget.dealYouIn.next(8_000, "dTarget joined");
  dKeep.socket.emit("dealJoin");
  await dKeep.dealYouIn.next(8_000, "dKeep joined");

  await sleep(600);
  const dPreNames = dKeep.dealNames.items.length
    ? dKeep.dealNames.items[dKeep.dealNames.items.length - 1].names
    : [];
  ok(dPreNames.includes("DTgt") && dPreNames.includes("DKeep"),
     "both participants appear in the Deal name list before removal");
  dKeep.dealOver.drain();
  owner.dealOver.drain();

  // Owner removes one participant → the whole show must cancel with no payout.
  owner.socket.emit("ownerRemoveAccount", { email: EMAIL_DTARGET, confirmEmail: EMAIL_DTARGET });
  const dRemoveRes = await owner.removeResult.next(15_000, "deal target removal result");
  ok(dRemoveRes.ok === true, "owner removes a Deal participant (ok:true)");
  await locateNewAnonEmail(null);

  // A dealOver cancellation must reach the remaining participant.
  const dealOverEvt = await dKeep.dealOver.next(8_000, "dealOver cancellation");
  ok(dealOverEvt !== null, "the Deal show is cancelled (dealOver) after a participant is removed");
  ok(
    dealOverEvt?.per === 0
      || dealOverEvt?.mode === "cancelled"
      || /cancel/i.test(String(dealOverEvt?.message || "")),
    "the cancellation carries no payout (per 0 / cancelled)",
  );

  // Give any (incorrect) delayed reveal/payout timer a chance to fire.
  await sleep(2_500);

  // No participant should have been paid.
  const dKeepCoinsAfter = Number((await pool.query(
    `SELECT coins FROM jpo_players WHERE email = $1`, [EMAIL_DKEEP],
  )).rows[0].coins);
  ok(dKeepCoinsAfter === dKeepCoinsBefore,
     "remaining participant received no Deal payout (coins unchanged)");

  // The removed original email must be entirely gone — not lingering in any
  // delayed player-row state under the old identity.
  const dTargetRow = (await pool.query(
    `SELECT coins FROM jpo_players WHERE email = $1`, [EMAIL_DTARGET],
  )).rows[0];
  ok(!dTargetRow, "removed participant's original email row is gone (no delayed state)");

  // Sanity: no anonymous row got any Deal payout above its seeded balance.
  if (runAnonEmails.size > 0) {
    const anonPaid = (await pool.query(
      `SELECT max(coins) AS m FROM jpo_players WHERE email = ANY($1::text[])`,
      [[...runAnonEmails]],
    )).rows[0]?.m;
    ok(anonPaid === null || Number(anonPaid) <= 1000,
       "no anonymous row was paid a Deal jackpot (balance never inflated)");
  }

  // Owner should be able to start a fresh show now that the old one is cancelled
  // (proves the deal state was fully torn down, not left half-alive).
  owner.dealResult.drain();
  owner.socket.emit("ownerDealStart", { jackpot: 1000, voteSec: 8 });
  const restart = await owner.dealResult.next(8_000, "deal restart after teardown");
  ok(restart.ok === true, "a new Deal show can start (previous state fully torn down)");
  owner.socket.emit("ownerDealCancel");
  await owner.dealResult.next(8_000, "cleanup deal cancel").catch(() => {});

} catch (err) {
  console.error("TEST ERROR:", err.stack || err.message);
  fails.push(err.message);
} finally {
  for (const c of [owner, host, bTarget, bKeep, dTarget, dKeep]) c?.socket.close();
  server?.kill();
  await cleanup().catch(() => {});
  await pool.end();
}

console.log(fails.length ? `RESULT: FAIL (${fails.length})` : "RESULT: PASS");
process.exit(fails.length ? 1 : 0);
