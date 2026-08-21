// Identity-name-collision privacy fix (task #153).
//
// When a player is removed, authored free-text records (announcements, gift
// notices) are anonymized. The fix distinguishes THREE cases by durable
// attribution columns (jpo_announcements.author_email / jpo_gift_notices.from_email,
// both added by the server's boot-time schema nudges):
//
//   (1) LEGACY rows (author/from email NULL) that predate attribution. If the
//       removed player's display name is SHARED with another active account,
//       there's no honest way to know which legacy row was theirs — so EVERY
//       unattributed row whose display name matches is conservatively redacted.
//   (2) TARGET-ATTRIBUTED rows (author/from email == target) are re-keyed to the
//       anonymous email and their free text / display name is redacted.
//   (3) OTHER-player-ATTRIBUTED rows (author/from email == a different, still
//       active account) that happen to share the same display name must remain
//       fully INTACT despite the name collision.
//
// This boots ONE throwaway server (so author_email/from_email exist), seeds the
// three cases with a deliberately shared display name, removes the target via
// the owner event, and asserts (1)/(2) are redacted while (3) survives, and no
// original target email or name leaks in the target/legacy records.
//
// Cleanup is strictly run-scoped: only rows this run created are removed, and
// pre-existing @deleted.invalid rows are never touched.
//
// Run: node tests/account/account-removal-namecollision.mjs
// (needs DATABASE_URL + OWNER_PASSWORD)

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { io } from "socket.io-client";

const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PORT = process.env.TEST_ACCT_NAMECOLLIDE_PORT || "20993";
const URL = `http://localhost:${PORT}`;

const run = Math.random().toString(36).slice(2, 9);
const EMAIL_OWNER  = `collide-owner-${run}@example.test`;
const EMAIL_TARGET = `collide-target-${run}@example.test`;
const EMAIL_OTHER  = `collide-other-${run}@example.test`;
const RUN_DEPT     = `collide-dept-${run}`;
const OLD_PASSWORD = "old-password-collide";

// The deliberately SHARED display name (and its components).
const SHARED_FIRST = "Alexcollide";
const SHARED_LAST  = `Carter${run}`;
const SHARED_NAME  = `${SHARED_FIRST} ${SHARED_LAST}`;

// Free-text bodies we seed, tagged with `run` so cleanup is precise.
const LEGACY_ANN_TEXT  = `legacy-ann-${run}`;
const TARGET_ANN_TEXT  = `target-ann-${run}`;
const OTHER_ANN_TEXT   = `other-ann-${run}`;
const BOARD            = "main";
const DELETED_NAME     = "Deleted player";
const DELETED_TEXT     = "[Content removed when this account was anonymized.]";

const ALL_ORIGINALS = [EMAIL_OWNER, EMAIL_TARGET, EMAIL_OTHER];
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
function connect() {
  const socket = io(URL, { transports: ["websocket"], reconnection: false });
  const q = {
    approved:     queue(socket, "approved"),
    authOk:       queue(socket, "adminAuthOk"),
    removeResult: queue(socket, "ownerRemoveAccountResult"),
  };
  const ready = new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return { socket, ...q, ready };
}

// ── snapshot-protected cleanup (strictly run-scoped) ──────────────────────────
async function cleanup() {
  // Player rows: originals + any @deleted.invalid row that carries our run tag
  // in a re-keyed record. We locate the run's anon email precisely instead of
  // touching every anonymous row.
  const anonEmails = (await pool.query(
    `SELECT DISTINCT author_email AS e FROM jpo_announcements WHERE text=$1 AND author_email LIKE '%@deleted.invalid'
     UNION
     SELECT DISTINCT from_email AS e FROM jpo_gift_notices WHERE from_name=$2 AND from_email LIKE '%@deleted.invalid'
       AND id = ANY($3::int[])`,
    [DELETED_TEXT, DELETED_NAME, seededGiftIds.length ? seededGiftIds : [0]],
  ).catch(() => ({ rows: [] }))).rows.map((r) => r.e).filter(Boolean);

  // Delete the run's seeded announcements + gift notices by their exact ids.
  if (seededAnnIds.length) {
    await pool.query(`DELETE FROM jpo_announcements WHERE id = ANY($1::int[])`, [seededAnnIds]).catch(() => {});
  }
  if (seededGiftIds.length) {
    await pool.query(`DELETE FROM jpo_gift_notices WHERE id = ANY($1::int[])`, [seededGiftIds]).catch(() => {});
  }

  const players = [...ALL_ORIGINALS, ...anonEmails];
  await pool.query(`DELETE FROM jpo_activity_daily WHERE email = ANY($1::text[])`, [players]).catch(() => {});
  await pool.query(`DELETE FROM jpo_gift_notices WHERE email = ANY($1::text[])`, [players]).catch(() => {});
  await pool.query(`DELETE FROM jpo_players WHERE email = ANY($1::text[])`, [players]).catch(() => {});
  await pool.query(`DELETE FROM jpo_players WHERE email LIKE $1`, [`%-${run}@example.test`]).catch(() => {});
  await pool.query(`DELETE FROM jpo_players WHERE department = $1`, [RUN_DEPT]).catch(() => {});
}

function bootServer() {
  const server = spawn("node", ["server.js"], {
    cwd: "/home/runner/workspace/artifacts/jpo-huddle",
    env: { ...process.env, PORT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write(`[srv] ${d}`));
  const booted = new Promise((resolve, reject) => {
    let boot = "";
    const timer = setTimeout(() => reject(new Error("server did not boot")), 30_000);
    server.stdout.on("data", (d) => {
      boot += String(d);
      if (boot.includes("running on port")) { clearTimeout(timer); resolve(); }
    });
    server.once("exit", (code) => {
      if (!/running on port/.test(boot)) reject(new Error(`server exited during boot (${code})\n${boot}`));
    });
  });
  return { server, booted };
}

// ── main ──────────────────────────────────────────────────────────────────────
let server;
let owner;
let seededAnnIds = [];
let seededGiftIds = [];

try {
  const s = bootServer();
  server = s.server;
  await s.booted;

  // Confirm the schema nudges added the attribution columns.
  const hasAuthor = (await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='jpo_announcements' AND column_name='author_email'`,
  )).rows.length > 0;
  const hasFrom = (await pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name='jpo_gift_notices' AND column_name='from_email'`,
  )).rows.length > 0;
  ok(hasAuthor, "boot schema nudge added jpo_announcements.author_email");
  ok(hasFrom, "boot schema nudge added jpo_gift_notices.from_email");

  await cleanup();

  // ── seed accounts: owner, target, and OTHER active account sharing the name ─
  await pool.query(
    `INSERT INTO jpo_players (email, first_name, last_name, name, character, department, approved, coins, password_hash)
     VALUES ($1,'OwnerC',$4::text,'Owner C','amelia',$5::text,true,500,NULL),
            ($2,$6::text,$7::text,$8::text,'adam',$5::text,true,321,NULL),
            ($3,$6::text,$7::text,$8::text,'alex',$5::text,true,654,NULL)`,
    [EMAIL_OWNER, EMAIL_TARGET, EMAIL_OTHER, `collide-${run}`, RUN_DEPT,
     SHARED_FIRST, SHARED_LAST, SHARED_NAME],
  );

  // ── seed the three announcement cases ────────────────────────────────────
  const annLegacy = (await pool.query(
    `INSERT INTO jpo_announcements (name, text, board, author_email) VALUES ($1,$2,$3,NULL) RETURNING id`,
    [SHARED_NAME, LEGACY_ANN_TEXT, BOARD],
  )).rows[0].id;
  const annTarget = (await pool.query(
    `INSERT INTO jpo_announcements (name, text, board, author_email) VALUES ($1,$2,$3,$4) RETURNING id`,
    [SHARED_NAME, TARGET_ANN_TEXT, BOARD, EMAIL_TARGET],
  )).rows[0].id;
  const annOther = (await pool.query(
    `INSERT INTO jpo_announcements (name, text, board, author_email) VALUES ($1,$2,$3,$4) RETURNING id`,
    [SHARED_NAME, OTHER_ANN_TEXT, BOARD, EMAIL_OTHER],
  )).rows[0].id;
  seededAnnIds = [annLegacy, annTarget, annOther];

  // ── seed the three gift-notice cases (email = recipient; here the owner) ───
  const giftLegacy = (await pool.query(
    `INSERT INTO jpo_gift_notices (email, from_name, from_email, amount) VALUES ($1,$2,NULL,$3) RETURNING id`,
    [EMAIL_OWNER, SHARED_NAME, 11],
  )).rows[0].id;
  const giftTarget = (await pool.query(
    `INSERT INTO jpo_gift_notices (email, from_name, from_email, amount) VALUES ($1,$2,$3,$4) RETURNING id`,
    [EMAIL_OWNER, SHARED_NAME, EMAIL_TARGET, 22],
  )).rows[0].id;
  const giftOther = (await pool.query(
    `INSERT INTO jpo_gift_notices (email, from_name, from_email, amount) VALUES ($1,$2,$3,$4) RETURNING id`,
    [EMAIL_OWNER, SHARED_NAME, EMAIL_OTHER, 33],
  )).rows[0].id;
  seededGiftIds = [giftLegacy, giftTarget, giftOther];

  // ── owner authenticates and removes the target ────────────────────────────
  owner = connect();
  await owner.ready;
  owner.socket.emit("register", {
    firstName: "OwnerC", lastName: `collide-${run}`, email: EMAIL_OWNER,
    password: OLD_PASSWORD, character: "amelia", department: RUN_DEPT,
  });
  await owner.approved.next(18_000, "owner approved");
  owner.socket.emit("adminAuth", { password: process.env.OWNER_PASSWORD });
  const auth = await owner.authOk.next(10_000, "owner auth");
  ok(auth.owner === true, "owner authenticates (owner tier)");

  console.log("― removing the target via the owner event");
  owner.removeResult.drain();
  owner.socket.emit("ownerRemoveAccount", { email: EMAIL_TARGET, confirmEmail: EMAIL_TARGET });
  const res = await owner.removeResult.next(30_000, "owner remove result");
  ok(res.ok === true, "owner removal succeeds");

  await sleep(1_000);

  // ── read back the seeded rows ──────────────────────────────────────────────
  const anns = {};
  for (const [k, id] of [["legacy", annLegacy], ["target", annTarget], ["other", annOther]]) {
    anns[k] = (await pool.query(
      `SELECT name, text, author_email FROM jpo_announcements WHERE id=$1`, [id],
    )).rows[0];
  }
  const gifts = {};
  for (const [k, id] of [["legacy", giftLegacy], ["target", giftTarget], ["other", giftOther]]) {
    gifts[k] = (await pool.query(
      `SELECT from_name, from_email FROM jpo_gift_notices WHERE id=$1`, [id],
    )).rows[0];
  }

  // The run's anonymous email (from the target-attributed announcement re-key).
  const anonEmail = anns.target?.author_email;

  // ── (1) LEGACY ambiguous rows conservatively redacted ─────────────────────
  console.log("― legacy (unattributed, name-collision) rows");
  ok(anns.legacy && anns.legacy.name === DELETED_NAME && anns.legacy.text === DELETED_TEXT
       && anns.legacy.author_email === null,
     "legacy announcement is conservatively redacted (name + text) and stays unattributed");
  ok(gifts.legacy && gifts.legacy.from_name === DELETED_NAME && gifts.legacy.from_email === null,
     "legacy gift notice from_name is conservatively redacted and stays unattributed");

  // ── (2) TARGET-attributed rows re-keyed to anon + redacted ────────────────
  console.log("― target-attributed rows");
  ok(!!anonEmail && anonEmail.endsWith("@deleted.invalid"),
     "target-attributed announcement is re-keyed to an anonymous @deleted.invalid email");
  ok(anns.target && anns.target.name === DELETED_NAME && anns.target.text === DELETED_TEXT,
     "target-attributed announcement name + text are redacted");
  ok(gifts.target && gifts.target.from_name === DELETED_NAME
       && gifts.target.from_email && gifts.target.from_email.endsWith("@deleted.invalid"),
     "target-attributed gift notice is re-keyed to anon and from_name redacted");

  // ── (3) OTHER active player's rows remain intact despite the collision ────
  console.log("― other active player's attributed rows (must survive)");
  ok(anns.other && anns.other.author_email === EMAIL_OTHER
       && anns.other.name === SHARED_NAME && anns.other.text === OTHER_ANN_TEXT,
     "other player's announcement is fully intact (attribution, shared name, text preserved)");
  ok(gifts.other && gifts.other.from_email === EMAIL_OTHER && gifts.other.from_name === SHARED_NAME,
     "other player's gift notice is fully intact despite the name collision");

  // ── no original target email / name leaks in target or legacy records ─────
  console.log("― no leak of the original target email or name");
  const leakRows = Number((await pool.query(
    `SELECT count(*)::int AS c FROM (
        SELECT 1 FROM jpo_announcements
          WHERE id = ANY($1::int[])
            AND (author_email=$2 OR lower(name)=lower($3) OR position(lower($2) in lower(text))>0)
        UNION ALL
        SELECT 1 FROM jpo_gift_notices
          WHERE id = ANY($4::int[])
            AND (from_email=$2 OR lower(from_name)=lower($3))
     ) q`,
    [[annLegacy, annTarget], EMAIL_TARGET, SHARED_NAME, [giftLegacy, giftTarget]],
  )).rows[0].c);
  ok(leakRows === 0,
     "no original target email or shared name remains in the target/legacy announcement or gift records");

  // Sanity: the target player row itself is anonymized (old email gone).
  const oldGone = Number((await pool.query(
    `SELECT count(*)::int AS c FROM jpo_players WHERE email=$1`, [EMAIL_TARGET],
  )).rows[0].c);
  ok(oldGone === 0, "the target player row is anonymized (old email gone)");
  // The OTHER player row is untouched.
  const otherRow = (await pool.query(
    `SELECT name, approved FROM jpo_players WHERE email=$1`, [EMAIL_OTHER],
  )).rows[0];
  ok(otherRow && otherRow.name === SHARED_NAME && otherRow.approved === true,
     "the other active player account is untouched (still approved, same name)");

} catch (err) {
  console.error("TEST ERROR:", err.stack || err.message);
  fails.push(err.message);
} finally {
  owner?.socket.close();
  server?.kill();
  await sleep(500);
  await cleanup().catch(() => {});
  await pool.end();
}

console.log(fails.length ? `RESULT: FAIL (${fails.length})` : "RESULT: PASS");
process.exit(fails.length ? 1 : 0);
