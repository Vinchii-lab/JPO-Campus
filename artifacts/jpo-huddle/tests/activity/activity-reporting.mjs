// Privacy-safe Huddle activity reporting integration:
// - only OWNER_PASSWORD sockets can read aggregate reports
// - pulses accept only a coarse boolean and never alter coin balances
// - active/idle aggregates are persisted and rows older than 30 days are pruned
// - the browser classifier requires a visible, focused Huddle tab and emits no
//   event details
// Run: node tests/activity/activity-reporting.mjs
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { io } from "socket.io-client";

const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PORT = process.env.TEST_ACTIVITY_PORT || "20996";
const URL = `http://localhost:${PORT}`;
const run = Math.random().toString(36).slice(2, 9);
const EMAIL_WORKER = `activity-worker-${run}@justpressone.com`;
const EMAIL_ADMIN = `activity-admin-${run}@justpressone.com`;
const EMAIL_OWNER = `activity-owner-${run}@justpressone.com`;
const EMAIL_OLD = `activity-old-${run}@justpressone.com`;
const EMAILS = [EMAIL_WORKER, EMAIL_ADMIN, EMAIL_OWNER, EMAIL_OLD];
const fails = [];

const ok = (value, label) => {
  console.log(`${value ? "  ✓" : "  ✗"} ${label}`);
  if (!value) fails.push(label);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    next(timeout = 12_000, label = event) {
      return new Promise((resolve, reject) => {
        if (items.length) return resolve(items.shift());
        const waiter = (data) => {
          clearTimeout(timer);
          resolve(data);
        };
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

function connect(email, firstName, character) {
  const socket = io(URL, { transports: ["websocket"], reconnection: false });
  const approved = queue(socket, "approved");
  const auth = queue(socket, "adminAuthOk");
  const report = queue(socket, "ownerActivityReport");
  const ready = new Promise((resolve, reject) => {
    socket.once("connect", () => {
      socket.emit("register", {
        firstName,
        lastName: "Activity",
        email,
        password: "testpass123",
        character,
        department: "IT",
      });
      resolve();
    });
    socket.once("connect_error", reject);
  });
  return { socket, approved, auth, report, ready };
}

async function cleanup() {
  await pool.query(`DELETE FROM jpo_activity_daily WHERE email = ANY($1::text[])`, [EMAILS]).catch(() => {});
  await pool.query(`DELETE FROM jpo_players WHERE email = ANY($1::text[])`, [EMAILS]).catch(() => {});
}

let server;
let worker;
let admin;
let owner;
try {
  server = spawn("node", ["server.js"], {
    cwd: "/home/runner/workspace/artifacts/jpo-huddle",
    env: {
      ...process.env,
      PORT,
      ACTIVITY_PULSE_MIN_MS: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (data) => process.stderr.write(`[srv] ${data}`));
  let boot = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("activity test server did not boot")), 25_000);
    server.stdout.on("data", (data) => {
      boot += String(data);
      if (boot.includes("running on port")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once("exit", (code) => reject(new Error(`server exited during boot (${code})\n${boot}`)));
  });

  await cleanup();
  await pool.query(
    `INSERT INTO jpo_players
       (email, first_name, last_name, name, character, department, approved, coins, cosmetics, last_daily_bonus)
     VALUES
       ($1, 'ActivityWorker', 'Activity', 'ActivityWorker Activity', 'adam', 'IT', true, 1000, ARRAY[]::text[], CURRENT_DATE),
       ($2, 'ActivityAdmin',  'Activity', 'ActivityAdmin Activity',  'alex', 'IT', true, 1000, ARRAY[]::text[], CURRENT_DATE),
       ($3, 'ActivityOwner',  'Activity', 'ActivityOwner Activity',  'bob',  'IT', true, 1000, ARRAY[]::text[], CURRENT_DATE)`,
    [EMAIL_WORKER, EMAIL_ADMIN, EMAIL_OWNER],
  );
  await pool.query(
    `INSERT INTO jpo_activity_daily
       (day, email, active_seconds, idle_seconds, meaningful_actions, passive_coins)
     VALUES (CURRENT_DATE - 45, $1, 999, 999, 99, 99)`,
    [EMAIL_OLD],
  );

  worker = connect(EMAIL_WORKER, "ActivityWorker", "adam");
  admin = connect(EMAIL_ADMIN, "ActivityAdmin", "alex");
  owner = connect(EMAIL_OWNER, "ActivityOwner", "bob");
  await Promise.all([worker.ready, admin.ready, owner.ready]);
  const [workerApproved] = await Promise.all([
    worker.approved.next(15_000, "worker approved"),
    admin.approved.next(15_000, "admin approved"),
    owner.approved.next(15_000, "owner approved"),
  ]);
  const originalCoins = Number(workerApproved.coins);

  console.log("― coarse pulse storage");
  worker.socket.emit("activityPulse", {
    active: true,
    key: "SHOULD_NOT_BE_ACCEPTED",
    text: "SHOULD_NOT_BE_ACCEPTED",
    x: 123,
    y: 456,
    url: "https://example.invalid/private",
  });
  await sleep(1_150);
  worker.socket.emit("activityPulse", { active: false });
  await sleep(1_150);
  worker.socket.emit("activityPulse", { active: false });
  await sleep(500);

  const activityRow = (await pool.query(
    `SELECT active_seconds, idle_seconds, meaningful_actions, passive_coins
       FROM jpo_activity_daily WHERE email=$1 AND day=CURRENT_DATE`,
    [EMAIL_WORKER],
  )).rows[0];
  ok(Number(activityRow?.active_seconds) >= 1, "active time is stored as a coarse aggregate");
  ok(Number(activityRow?.idle_seconds) >= 1, "idle time is stored as a coarse aggregate");
  ok(Number(activityRow?.meaningful_actions) === 0, "client pulses cannot forge meaningful completed actions");
  ok(Number(activityRow?.passive_coins) === 0, "client pulses cannot forge passive-coin context");

  const storedCoins = Number((await pool.query(
    `SELECT coins FROM jpo_players WHERE email=$1`,
    [EMAIL_WORKER],
  )).rows[0]?.coins);
  ok(storedCoins === originalCoins, "activity pulses do not change the player's coin balance");

  const columns = (await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='jpo_activity_daily'
      ORDER BY ordinal_position`,
  )).rows.map((row) => row.column_name);
  const allowedColumns = [
    "day", "email", "active_seconds", "idle_seconds", "meaningful_actions",
    "passive_coins",
  ];
  ok(
    columns.length === allowedColumns.length && allowedColumns.every((name) => columns.includes(name)),
    "the storage schema has aggregate fields only and no raw-input columns",
  );

  console.log("― owner-only authorization");
  worker.socket.emit("ownerActivityReport", { days: 7 });
  await sleep(1_200);
  ok(worker.report.items.length === 0, "regular workers receive no activity report");

  admin.socket.emit("adminAuth", { password: process.env.ADMIN_PASSWORD });
  const adminAuth = await admin.auth.next(8_000, "plain admin auth");
  ok(adminAuth.owner === false, "plain admin authentication does not grant the owner tier");
  admin.socket.emit("ownerActivityReport", { days: 7 });
  await sleep(1_200);
  ok(admin.report.items.length === 0, "plain admins receive no activity report");

  owner.socket.emit("adminAuth", { password: process.env.OWNER_PASSWORD });
  const ownerAuth = await owner.auth.next(8_000, "owner auth");
  ok(ownerAuth.owner === true, "owner password grants the owner report tier");
  owner.socket.emit("ownerActivityReport", { days: 7 });
  const report = await owner.report.next(8_000, "owner activity report");
  const workerReport = report.rows?.find((row) => row.email === EMAIL_WORKER);
  ok(report.ok && report.days === 7 && report.retentionDays === 30, "owner receives the fixed-range aggregate report");
  ok(
    workerReport
      && Number(workerReport.activeSeconds) >= 1
      && Number(workerReport.idleSeconds) >= 1,
    "owner report includes aggregate active and idle time",
  );
  const safeReportKeys = [
    "email", "name", "department", "activeSeconds", "idleSeconds",
    "meaningfulActions", "passiveCoins",
  ];
  ok(
    workerReport
      && Object.keys(workerReport).every((key) => safeReportKeys.includes(key))
      && !Object.hasOwn(workerReport, "lastActiveAt")
      && !Object.hasOwn(workerReport, "currentState")
      && !JSON.stringify(workerReport).includes("SHOULD_NOT_BE_ACCEPTED"),
    "owner response contains aggregates only, with no raw details or live timing telemetry",
  );
  const oldCount = Number((await pool.query(
    `SELECT count(*) AS count FROM jpo_activity_daily WHERE email=$1`,
    [EMAIL_OLD],
  )).rows[0].count);
  ok(oldCount === 0, "owner report read prunes aggregate rows older than 30 days");

  console.log("― browser privacy boundary");
  const html = await readFile(
    "/home/runner/workspace/artifacts/jpo-huddle/public/index.html",
    "utf8",
  );
  const tracker = html.slice(
    html.indexOf("Privacy-safe in-Huddle activity signal"),
    html.indexOf("Build handshake: stale tabs"),
  );
  ok(
    tracker.includes("document.hidden") && tracker.includes("document.hasFocus()"),
    "browser classifier treats hidden or unfocused Huddle tabs as idle",
  );
  ok(
    tracker.includes("socket.emit('activityPulse', { active })")
      && !/clipboardData|clientX|clientY|\\.key\\b|document\\.title|getDisplayMedia|mediaDevices/.test(tracker),
    "browser pulse sends only the boolean and reads no input contents or coordinates",
  );
  ok(
    html.includes("Activity privacy in JPO Huddle")
      && html.includes("participation signal, not proof of productivity")
      && html.includes("Records are deleted after 30 days"),
    "the sign-in and in-game UI clearly disclose scope, limitations, and retention",
  );
} catch (error) {
  console.error("TEST ERROR:", error.stack || error.message);
  fails.push(error.message);
} finally {
  worker?.socket.close();
  admin?.socket.close();
  owner?.socket.close();
  server?.kill();
  await cleanup().catch(() => {});
  await pool.end();
}

console.log(fails.length ? `RESULT: FAIL (${fails.length})` : "RESULT: PASS");
process.exit(fails.length ? 1 : 0);