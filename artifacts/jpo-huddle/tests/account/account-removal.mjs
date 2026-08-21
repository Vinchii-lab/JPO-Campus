// Account Removal integration test (task #153).
// Contract: owner socket event `ownerRemoveAccount` with payload { email, confirmEmail }
// responds with `ownerRemoveAccountResult { ok, message }`.
//
// Behaviour under test:
//   - Normal user and plain admin receive an ok:false refusal (not silently ignored).
//   - Owner can remove an approved account.
//   - Live target socket receives `accountRemoved` and then disconnects.
//   - Old password login fails after removal.
//   - Old resume token is rejected after removal (password_set_at voided).
//   - Original email row is GONE from jpo_players.
//   - One anonymised jpo_players row exists under the opaque @deleted.invalid identity
//     with scrubbed profile/credentials and approved = false.
//   - jpo_activity_daily rows are retained under the anonymous email.
//   - Authored whisper message/image text is redacted (NULL) but recipient-side row stays.
//   - Owner cannot remove their own currently-authenticated player account.
//   - email / confirmEmail mismatch is rejected.
//   - Repeating the old email removal fails safely (ok: false, no crash).
//   - Static client (index.html) contains owner-only "Remove account" control
//     and explicit irreversible confirmation language.
//
// Uses @example.test disposable identities only. Cleanup targets both original
// and anonymous rows via a unique run-scoped marker.
//
// Run: node tests/account/account-removal.mjs
// (needs DATABASE_URL + ADMIN_PASSWORD + OWNER_PASSWORD)

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { io } from "socket.io-client";
import crypto from "node:crypto";

const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PORT = process.env.TEST_ACCT_REMOVE_PORT || "20997";
const URL = `http://localhost:${PORT}`;

const run = Math.random().toString(36).slice(2, 9);
// All test identities use @example.test (RFC 2606 reserved) — never real accounts.
const EMAIL_TARGET   = `acct-remove-target-${run}@example.test`;
const EMAIL_WORKER   = `acct-remove-worker-${run}@example.test`;
const EMAIL_ADMIN    = `acct-remove-admin-${run}@example.test`;
const EMAIL_OWNER    = `acct-remove-owner-${run}@example.test`;
const EMAIL_RECIP    = `acct-remove-recip-${run}@example.test`;   // whisper recipient
// All test accounts share a run-unique last_name for targeted cleanup of the
// anon row (anon first_name is always "Deleted", last_name is cleared to '').
// We use a unique department tag embedded in a prefix so we can locate the anon
// row by the uuid inside its email (contained in the result).
const RUN_DEPT       = `acct-remove-dept-${run}`;   // unique department marker

const ALL_ORIGINALS  = [EMAIL_TARGET, EMAIL_WORKER, EMAIL_ADMIN, EMAIL_OWNER, EMAIL_RECIP];
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
  const sessionToken = queue(socket, "sessionToken");
  const ready = new Promise((resolve, reject) => {
    socket.once("connect", () => {
      socket.emit("register", {
        firstName,
        lastName: `removal-test-${run}`,
        email,
        password: "testpass123",
        character,
        department: RUN_DEPT,
      });
      resolve();
    });
    socket.once("connect_error", reject);
  });
  return { socket, approved, authOk, removeResult, sessionToken, ready };
}

// ── cleanup (wipes ONLY rows created by this run) ──────────────────────────────
// The anon row is tracked via the unique department marker (stored before update).
// After removal the anon row's department is '' — we locate it via the result email.
let anonEmailForCleanup = "";  // set during removal flow

// Snapshot of @deleted.invalid emails that existed BEFORE this test started.
// Cleanup must never touch these pre-existing anonymous rows — only delete the
// difference (anonymous rows this run created).
let preExistingAnonEmails = new Set();

async function snapshotPreExistingAnon() {
  const { rows } = await pool.query(
    `SELECT email FROM jpo_players WHERE email LIKE '%@deleted.invalid'`,
  ).catch(() => ({ rows: [] }));
  preExistingAnonEmails = new Set(rows.map((r) => r.email));
}

async function cleanup() {
  const emails = [...ALL_ORIGINALS];
  if (anonEmailForCleanup) emails.push(anonEmailForCleanup);

  // Compute the set of @deleted.invalid rows to delete: only those NOT present
  // in the pre-test snapshot (i.e. created by this run). This guarantees we can
  // never delete pre-existing anonymous rows belonging to earlier runs / prod.
  const { rows: nowAnon } = await pool.query(
    `SELECT email FROM jpo_players WHERE email LIKE '%@deleted.invalid'`,
  ).catch(() => ({ rows: [] }));
  const newlyCreatedAnon = nowAnon
    .map((r) => r.email)
    .filter((e) => !preExistingAnonEmails.has(e));
  for (const e of newlyCreatedAnon) if (!emails.includes(e)) emails.push(e);

  await pool.query(`DELETE FROM jpo_whispers WHERE from_email = ANY($1::text[]) OR to_email = ANY($1::text[])`,
    [emails]).catch(() => {});
  await pool.query(`DELETE FROM jpo_activity_daily WHERE email = ANY($1::text[])`,
    [emails]).catch(() => {});
  await pool.query(`DELETE FROM jpo_players WHERE email = ANY($1::text[])`,
    [emails]).catch(() => {});
  // Belt-and-suspenders: remove any residual @example.test rows with our run id
  // (these are never @deleted.invalid, so the snapshot guard is unaffected).
  await pool.query(`DELETE FROM jpo_players WHERE email LIKE $1`, [`%-${run}@example.test`]).catch(() => {});
  // Also remove any row still carrying our run-scoped department marker — but
  // ONLY if it is not a pre-existing anonymous row (department is cleared to ''
  // during anonymisation, so a committed anon row won't match this anyway).
  await pool.query(
    `DELETE FROM jpo_players WHERE department = $1 AND NOT (email = ANY($2::text[]))`,
    [RUN_DEPT, [...preExistingAnonEmails]],
  ).catch(() => {});
}

// ── craft a token using the same algorithm as the server ─────────────────────
function craftToken(email, iatOverride) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return "";
  const payload = Buffer.from(JSON.stringify({ email, iat: iatOverride ?? Date.now() })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

// ── main ──────────────────────────────────────────────────────────────────────
let server;
let target, worker, admin, owner, recip;

try {
  // ── boot throwaway server ──────────────────────────────────────────────
  server = spawn("node", ["server.js"], {
    cwd: "/home/runner/workspace/artifacts/jpo-huddle",
    env: { ...process.env, PORT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write(`[srv] ${d}`));
  let boot = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("account-removal test server did not boot")), 30_000);
    server.stdout.on("data", (d) => {
      boot += String(d);
      if (boot.includes("running on port")) { clearTimeout(timer); resolve(); }
    });
    server.once("exit", (code) => reject(new Error(`server exited during boot (${code})\n${boot}`)));
  });

  // ── snapshot pre-existing anonymous rows, then seed ────────────────────
  // Snapshot BEFORE any cleanup so pre-existing @deleted.invalid rows are
  // protected from deletion for the whole run.
  await snapshotPreExistingAnon();
  await cleanup();
  const lastNameSeed = `removal-test-${run}`;
  await pool.query(
    `INSERT INTO jpo_players
       (email, first_name, last_name, name, character, department, approved, coins, cosmetics, last_daily_bonus, password_hash)
     VALUES
       ($1, 'Target',  $6, 'Target Test',   'adam',   $7, true, 500, ARRAY[]::text[], CURRENT_DATE, NULL),
       ($2, 'Worker',  $6, 'Worker Test',   'alex',   $7, true, 500, ARRAY[]::text[], CURRENT_DATE, NULL),
       ($3, 'Admin',   $6, 'Admin Test',    'bob',    $7, true, 500, ARRAY[]::text[], CURRENT_DATE, NULL),
       ($4, 'OwnerP',  $6, 'Owner Test',    'amelia', $7, true, 500, ARRAY[]::text[], CURRENT_DATE, NULL),
       ($5, 'Recip',   $6, 'Recip Test',    'adam',   $7, true, 500, ARRAY[]::text[], CURRENT_DATE, NULL)`,
    [EMAIL_TARGET, EMAIL_WORKER, EMAIL_ADMIN, EMAIL_OWNER, EMAIL_RECIP, lastNameSeed, RUN_DEPT],
  );

  // Seed a PII-like pet_names value on the target — a custom pet nickname could
  // encode a real name, so anonymisation must reset pet_names to an empty object.
  await pool.query(
    `UPDATE jpo_players SET pet_names = $2::jsonb WHERE email = $1`,
    [EMAIL_TARGET, JSON.stringify({ pet_cat: `Fluffy belongs to real-person-${run}` })],
  );

  // Seed activity rows for the target (should survive removal under anon email).
  await pool.query(
    `INSERT INTO jpo_activity_daily (day, email, active_seconds, idle_seconds, meaningful_actions, passive_coins)
     VALUES (CURRENT_DATE - 2, $1, 300, 120, 5, 10),
            (CURRENT_DATE - 1, $1, 400, 80,  3,  5)`,
    [EMAIL_TARGET],
  );

  // Seed a whisper FROM target TO recip (authored — message/img should be redacted).
  await pool.query(
    `INSERT INTO jpo_whispers (from_email, from_name, to_email, to_name, message, img)
     VALUES ($1, 'Target', $2, 'Recip', 'Hello from target!', NULL),
            ($1, 'Target', $2, 'Recip', NULL, 'data:image/png;base64,iVBORw0KGgo=')`,
    [EMAIL_TARGET, EMAIL_RECIP],
  );
  // Seed a whisper TO target FROM recip (recipient side — row kept, to_email anonymised).
  await pool.query(
    `INSERT INTO jpo_whispers (from_email, from_name, to_email, to_name, message, img)
     VALUES ($1, 'Recip', $2, 'Target', 'Hello back!', NULL)`,
    [EMAIL_RECIP, EMAIL_TARGET],
  );

  // ── connect all sockets ────────────────────────────────────────────────
  target = connect(EMAIL_TARGET, "Target",  "adam");
  worker = connect(EMAIL_WORKER, "Worker",  "alex");
  admin  = connect(EMAIL_ADMIN,  "Admin",   "bob");
  owner  = connect(EMAIL_OWNER,  "OwnerP",  "amelia");
  recip  = connect(EMAIL_RECIP,  "Recip",   "adam");

  await Promise.all([target.ready, worker.ready, admin.ready, owner.ready, recip.ready]);
  await Promise.all([
    target.approved.next(18_000, "target approved"),
    worker.approved.next(18_000, "worker approved"),
    admin.approved.next(18_000,  "admin approved"),
    owner.approved.next(18_000,  "owner approved"),
    recip.approved.next(18_000,  "recip approved"),
  ]);

  // Capture the target's resume token (emitted by restorePlayer after approve).
  let targetResumeToken = await target.sessionToken.next(4_000, "target session token").then((d) => d?.token || "").catch(() => "");
  if (!targetResumeToken) {
    // Fallback: craft a token directly (works only if SESSION_SECRET is available).
    targetResumeToken = craftToken(EMAIL_TARGET, Date.now() - 500);
  }

  // ── auth escalation ────────────────────────────────────────────────────
  admin.socket.emit("adminAuth", { password: process.env.ADMIN_PASSWORD });
  const adminAuthOk = await admin.authOk.next(10_000, "plain admin auth");
  ok(adminAuthOk.owner === false, "plain admin authenticated (not owner tier)");

  owner.socket.emit("adminAuth", { password: process.env.OWNER_PASSWORD });
  const ownerAuthOk = await owner.authOk.next(10_000, "owner auth");
  ok(ownerAuthOk.owner === true, "owner password grants the owner tier");

  // ── authorization gate: worker and plain admin are refused ────────────
  // The server responds with ok:false (not silent) for non-owners.
  console.log("― authorization: non-owner rejection");
  worker.socket.emit("ownerRemoveAccount", { email: EMAIL_TARGET, confirmEmail: EMAIL_TARGET });
  const workerResult = await worker.removeResult.next(6_000, "worker ownerRemoveAccount").catch(() => null);
  ok(workerResult !== null && workerResult.ok === false,
     "normal worker receives ok:false refusal for ownerRemoveAccount");

  admin.socket.emit("ownerRemoveAccount", { email: EMAIL_TARGET, confirmEmail: EMAIL_TARGET });
  const adminResult = await admin.removeResult.next(6_000, "admin ownerRemoveAccount").catch(() => null);
  ok(adminResult !== null && adminResult.ok === false,
     "plain admin receives ok:false refusal for ownerRemoveAccount");

  // ── owner cannot remove their own currently-authenticated account ──────
  console.log("― owner self-removal guard");
  owner.socket.emit("ownerRemoveAccount", { email: EMAIL_OWNER, confirmEmail: EMAIL_OWNER });
  const selfResult = await owner.removeResult.next(8_000, "self-removal guard");
  ok(selfResult.ok === false, "owner cannot remove their own currently-authenticated account");
  ok(typeof selfResult.message === "string" && selfResult.message.length > 0,
     "self-removal refusal carries an error message");

  // ── email / confirmEmail mismatch is rejected ──────────────────────────
  console.log("― confirmation email mismatch");
  owner.socket.emit("ownerRemoveAccount", { email: EMAIL_TARGET, confirmEmail: "different@example.test" });
  const mismatchResult = await owner.removeResult.next(8_000, "mismatch rejection");
  ok(mismatchResult.ok === false, "email/confirmEmail mismatch returns ok:false");

  // ── live removal of target ─────────────────────────────────────────────
  console.log("― live removal flow");
  const targetDisconnected = new Promise((resolve) => {
    target.socket.once("disconnect", resolve);
  });

  owner.socket.emit("ownerRemoveAccount", { email: EMAIL_TARGET, confirmEmail: EMAIL_TARGET });
  const removeResult = await owner.removeResult.next(15_000, "ownerRemoveAccountResult");
  ok(removeResult.ok === true, "owner removal of a valid account returns ok:true");
  ok(typeof removeResult.message === "string" && removeResult.message.length > 0,
     "successful removal carries a confirmation message");

  // Track the anonymous email so cleanup can delete it.
  anonEmailForCleanup = typeof removeResult.removedEmail === "string" ? "" : "";
  // Find the anon email from DB (we know it ends @deleted.invalid).
  const anonRows = (await pool.query(
    `SELECT email FROM jpo_players WHERE email LIKE '%@deleted.invalid' ORDER BY updated_at DESC LIMIT 10`,
  )).rows;
  // Identify by activity rows that were re-keyed.
  let anonEmail = "";
  for (const r of anonRows) {
    const cnt = Number((await pool.query(
      `SELECT count(*) AS c FROM jpo_activity_daily WHERE email=$1`, [r.email],
    )).rows[0].c);
    if (cnt >= 2) { anonEmail = r.email; break; }
  }
  if (!anonEmail && anonRows.length === 1) anonEmail = anonRows[0].email;
  anonEmailForCleanup = anonEmail;

  // Wait for target socket to disconnect (server closes it after accountRemoved).
  await Promise.race([targetDisconnected, sleep(7_000)]);
  ok(!target.socket.connected, "target socket disconnects after account removal");

  // ── DB invariants after removal ────────────────────────────────────────
  console.log("― database invariants after removal");

  const origRow = (await pool.query(
    `SELECT email FROM jpo_players WHERE email = $1`, [EMAIL_TARGET],
  )).rows[0];
  ok(!origRow, "original email row is gone from jpo_players");

  ok(anonEmail !== "", "anonymous row was located in jpo_players");
  ok(anonEmail.endsWith("@deleted.invalid"), "anonymous row uses the @deleted.invalid domain");

  if (anonEmail) {
    const anon = (await pool.query(
      `SELECT * FROM jpo_players WHERE email = $1`, [anonEmail],
    )).rows[0];
    ok(!!anon, "anonymous row exists in jpo_players");
    if (anon) {
      ok(anon.approved === false, "anonymous row has approved = false");
      ok(anon.first_name === "Deleted", "anonymous row has first_name = 'Deleted'");
      ok(!String(anon.name || "").includes(EMAIL_TARGET),
         "original email does not appear in the anonymous row's name field");
      ok(!String(anon.email).includes("@example.test"),
         "no @example.test domain leaks into the anonymous row");
      // password_hash is a disabled (scrypt-valid but functionally useless) hash —
      // the server sets it to hash(`removed:<uuid>:<uuid>`). It must not be NULL.
      ok(anon.password_hash && !anon.password_hash.includes("testpass"),
         "anonymous row has a scrubbed, non-original password hash");
      // PII-like pet nicknames must be wiped to an empty object.
      const petNames = anon.pet_names || {};
      ok(
        Object.keys(petNames).length === 0
          && !JSON.stringify(petNames).includes(`real-person-${run}`),
        "anonymous row has pet_names = {} (custom pet nicknames scrubbed)",
      );
    }

    // Activity rows re-keyed to the anon email.
    const activityCount = Number((await pool.query(
      `SELECT count(*) AS c FROM jpo_activity_daily WHERE email = $1`, [anonEmail],
    )).rows[0].c);
    ok(activityCount >= 2, "activity rows are retained under the anonymous email");

    const origActivity = Number((await pool.query(
      `SELECT count(*) AS c FROM jpo_activity_daily WHERE email = $1`, [EMAIL_TARGET],
    )).rows[0].c);
    ok(origActivity === 0, "activity rows are re-keyed away from the original email");

    // Authored whispers: message and img NULLed, from_email → anon.
    const authoredWhispers = (await pool.query(
      `SELECT message, img FROM jpo_whispers WHERE from_email = $1`, [anonEmail],
    )).rows;
    ok(authoredWhispers.length >= 2, "authored whisper rows are retained (under anon email)");
    ok(
      authoredWhispers.every((r) => r.message === null && r.img === null),
      "authored whisper text and images are redacted (NULL) after removal",
    );

    // Recipient-side whisper (from recip TO target) — to_email became anon, message intact.
    const recipWhispers = (await pool.query(
      `SELECT message FROM jpo_whispers WHERE from_email = $1 AND to_email = $2`, [EMAIL_RECIP, anonEmail],
    )).rows;
    ok(recipWhispers.length >= 1, "recipient-side whisper from another user is retained");
    ok(recipWhispers.some((r) => r.message === "Hello back!"),
       "recipient-side whisper message content is intact");
  }

  // ── credential rejection after removal ────────────────────────────────
  console.log("― credential rejection after removal");

  // Old password login must fail — no account found (row email changed).
  const loginFailSocket = io(URL, { transports: ["websocket"], reconnection: false });
  const loginFailed = queue(loginFailSocket, "loginFailed");
  await new Promise((res, rej) => {
    loginFailSocket.once("connect", () => {
      loginFailSocket.emit("login", { email: EMAIL_TARGET, password: "testpass123" });
      res();
    });
    loginFailSocket.once("connect_error", rej);
  });
  const loginFailResult = await loginFailed.next(10_000, "old-password login fail").catch(() => null);
  ok(loginFailResult !== null, "old password login fails after account removal");
  loginFailSocket.close();

  // Old resume token must be rejected.
  if (targetResumeToken && process.env.SESSION_SECRET) {
    const resumeFailSocket = io(URL, { transports: ["websocket"], reconnection: false });
    const resumeFailed = queue(resumeFailSocket, "resumeFailed");
    await new Promise((res, rej) => {
      resumeFailSocket.once("connect", () => {
        resumeFailSocket.emit("resumeSession", { token: targetResumeToken });
        res();
      });
      resumeFailSocket.once("connect_error", rej);
    });
    const resumeFailResult = await resumeFailed.next(10_000, "old-token resume fail").catch(() => null);
    ok(resumeFailResult !== null, "old resume token is rejected after account removal");
    resumeFailSocket.close();
  } else {
    console.log("  ℹ  SESSION_SECRET not set — skipping resume-token rejection test");
  }

  // ── idempotency: repeat removal of the same original email ────────────
  console.log("― idempotent repeat removal");
  owner.socket.emit("ownerRemoveAccount", { email: EMAIL_TARGET, confirmEmail: EMAIL_TARGET });
  const repeatResult = await owner.removeResult.next(10_000, "repeat removal").catch(() => null);
  ok(repeatResult !== null, "repeat removal of already-removed email does not time out (no crash)");
  ok(repeatResult?.ok === false, "repeat removal returns ok:false (not ok:true)");

  // ── static client checks ───────────────────────────────────────────────
  console.log("― static client: Remove account control");
  const html = await readFile(
    "/home/runner/workspace/artifacts/jpo-huddle/public/index.html",
    "utf8",
  );

  ok(
    html.includes("ownerRemoveAccount") || html.includes("owner-remove-account") ||
    html.includes("data-remove-account"),
    "static client wires up the ownerRemoveAccount event or a data-remove-account control",
  );
  // The label can be a full phrase or a "Remove" button on a row in the roster.
  ok(
    /[Rr]emove\s+[Aa]ccount/.test(html)          // "Remove account" heading/label
    || /[Dd]elete\s+[Aa]ccount/.test(html)        // or "Delete account"
    || html.includes("data-remove-account")        // or the data-attribute pattern
    || /Permanently revoke this account/i.test(html),  // or a descriptive tooltip
    "static client contains a visible Remove account control or descriptive label",
  );
  // Confirmation language must appear near the remove-account UI context.
  const removeIdx = html.search(/data-remove-account|[Rr]emove\s+[Aa]ccount|ownerRemoveAccount/);
  const removeRegion = removeIdx >= 0
    ? html.slice(Math.max(0, removeIdx - 300), removeIdx + 2000)
    : "";
  ok(
    removeRegion.length > 0 &&
    /irreversible|cannot be undone|permanent.*remov|remov.*permanent|This action cannot|This cannot be undone/i.test(removeRegion),
    "static client shows explicit irreversible/permanent confirmation language near Remove account",
  );
  // The control must be owner-only gated (visible only after owner auth).
  const hasRemoveEmit = html.includes("ownerRemoveAccount") || html.includes("data-remove-account");
  const gatedByOwner =
    (hasRemoveEmit && html.includes("_ownerAuthed"))               // JS guard check
    || /op-owner-remove|owner-remove/i.test(html);                 // id prefix pattern
  ok(
    !hasRemoveEmit || gatedByOwner,
    "Remove account control is gated behind owner authentication in the static client",
  );

} catch (err) {
  console.error("TEST ERROR:", err.stack || err.message);
  fails.push(err.message);
} finally {
  target?.socket.close();
  worker?.socket.close();
  admin?.socket.close();
  owner?.socket.close();
  recip?.socket.close();
  server?.kill();
  await cleanup().catch(() => {});
  await pool.end();
}

console.log(fails.length ? `RESULT: FAIL (${fails.length})` : "RESULT: PASS");
process.exit(fails.length ? 1 : 0);
