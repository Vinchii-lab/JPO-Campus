// Owner coin adjust: OWNER_PASSWORD tier can add/remove coins (self included),
// plain ADMIN_PASSWORD cannot, balances clamp at 0, online targets get a live
// coinUpdate, and nothing is written to the activity log. Throwaway server.
// Run: node tests/economy/ownercoins.mjs   (needs DATABASE_URL + ADMIN_PASSWORD)
import { io } from "socket.io-client";
import { spawn } from "child_process";
import { createRequire } from "module";
const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const pg = require("pg");

const PORT = process.env.TEST_OWNERCOIN_PORT || "20980";
const OWNER_PWD = "owner-test-" + Math.random().toString(36).slice(2, 10);
const URL = `http://localhost:${PORT}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const rand = Math.random().toString(36).slice(2, 8);
const E_A = `ocn-a-${rand}@justpressone.com`;   // owner
const E_B = `ocn-b-${rand}@justpressone.com`;   // plain admin + target

const fails = [];
const ok = (c, l) => { console.log((c ? "  ✓ " : "  ✗ ") + l); if (!c) fails.push(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function queue(socket, name) {
  const q = { items: [], waiters: [] };
  socket.on(name, (d) => { const w = q.waiters.shift(); if (w) w(d); else q.items.push(d); });
  q.next = (timeoutMs = 15000, label = name) => new Promise((res, rej) => {
    if (q.items.length) return res(q.items.shift());
    const w = (d) => { clearTimeout(t); res(d); };
    const t = setTimeout(() => { const i = q.waiters.indexOf(w); if (i >= 0) q.waiters.splice(i, 1); rej(new Error(`timeout waiting for ${label}`)); }, timeoutMs);
    q.waiters.push(w);
  });
  q.drain = () => { q.items.length = 0; };
  return q;
}
const coinsOf = async (email) =>
  (await pool.query(`SELECT coins FROM jpo_players WHERE email=$1`, [email])).rows[0]?.coins;
const cleanup = () => pool.query(`DELETE FROM jpo_players WHERE email LIKE 'ocn-%@justpressone.com'`);

const connect = (email, first, character) => {
  const s = io(URL, { transports: ["websocket"], reconnection: false });
  const p = new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
  return { s, ready: p.then(() => s.emit("register", {
    firstName: first, lastName: "Ocn", email, password: "testpass123", character, department: "IT",
  })) };
};

// ── throwaway server with a known owner key ──
const server = spawn("node", ["server.js"], {
  cwd: "/home/runner/workspace/artifacts/jpo-huddle",
  env: { ...process.env, PORT, OWNER_PASSWORD: OWNER_PWD },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(`[srv] ${d}`));
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("server didn't boot")), 20000);
  server.stdout.on("data", (d) => { if (String(d).includes("running on port")) { clearTimeout(t); res(); } });
});

try {
  await cleanup();
  await pool.query(
    `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, coins, cosmetics, last_daily_bonus)
     VALUES ($1,'Owna','Ocn','Owna Ocn','adam',true,1000,ARRAY[]::text[],CURRENT_DATE),
            ($2,'Plaina','Ocn','Plaina Ocn','bob', true,500,ARRAY[]::text[],CURRENT_DATE)`,
    [E_A, E_B]);
  console.log("seeded", rand);

  const logCountBefore = Number((await pool.query(`SELECT count(*) AS c FROM jpo_admin_log`)).rows[0].c);

  const A = connect(E_A, "Owna", "adam"), B = connect(E_B, "Plaina", "bob");
  const aApr = queue(A.s, "approved"), bApr = queue(B.s, "approved");
  const aAuth = queue(A.s, "adminAuthOk"), bAuth = queue(B.s, "adminAuthOk");
  const aCoinRes = queue(A.s, "adminCoinResult"), bCoinRes = queue(B.s, "adminCoinResult");
  const aCoinUpd = queue(A.s, "coinUpdate"), bCoinUpd = queue(B.s, "coinUpdate");
  await Promise.all([A.ready, B.ready]);
  await aApr.next(15000, "A approved"); await bApr.next(15000, "B approved");
  aCoinUpd.drain(); bCoinUpd.drain();

  // Owner key unlocks with owner flag; plain admin key does not.
  A.s.emit("adminAuth", { password: OWNER_PWD });
  const aOk = await aAuth.next(8000, "owner auth");
  ok(aOk && aOk.owner === true, "owner key unlocks with owner=true");
  B.s.emit("adminAuth", { password: process.env.ADMIN_PASSWORD });
  const bOk = await bAuth.next(8000, "admin auth");
  ok(!bOk || !bOk.owner, "plain admin key gets owner=false");

  // Plain admin cannot adjust coins.
  B.s.emit("adminAdjustCoins", { email: E_B, delta: 99999 });
  await sleep(1500);
  ok(bCoinRes.items.length === 0, "plain admin's adjust request is ignored");
  ok(Number(await coinsOf(E_B)) === 500, "target balance untouched by non-owner");

  // Owner tops up THEMSELVES.
  A.s.emit("adminAdjustCoins", { email: E_A, delta: 4000 });
  const r1 = await aCoinRes.next(8000, "self top-up result");
  ok(r1.ok && /5,000/.test(r1.message), `owner self top-up ok (${r1.message})`);
  const u1 = await aCoinUpd.next(8000, "self coinUpdate");
  ok(u1.coins === 5000, "owner's live balance updated to 5000");
  ok(Number(await coinsOf(E_A)) === 5000, "owner's DB balance is 5000");

  // Owner adjusts an ONLINE other player; they get a live update.
  bCoinUpd.drain();
  A.s.emit("adminAdjustCoins", { email: E_B, delta: -200 });
  const r2 = await aCoinRes.next(8000, "other adjust result");
  ok(r2.ok, "adjusting another player works");
  const u2 = await bCoinUpd.next(8000, "B coinUpdate");
  ok(u2.coins === 300, "online target sees new balance live (300)");

  // Clamp at zero.
  A.s.emit("adminAdjustCoins", { email: E_B, delta: -1000000 });
  await aCoinRes.next(8000, "clamp result");
  ok(Number(await coinsOf(E_B)) === 0, "balance clamps at 0, never negative");

  // Unknown email + bad amounts rejected.
  A.s.emit("adminAdjustCoins", { email: `nobody-${rand}@justpressone.com`, delta: 100 });
  ok(!(await aCoinRes.next(8000, "unknown email result")).ok, "unknown email rejected");
  A.s.emit("adminAdjustCoins", { email: E_B, delta: 0 });
  ok(!(await aCoinRes.next(8000, "zero delta result")).ok, "zero amount rejected");

  // Nothing hit the activity log.
  await sleep(600);
  const logCountAfter = Number((await pool.query(`SELECT count(*) AS c FROM jpo_admin_log WHERE action NOT IN ('Panel unlocked')`)).rows[0].c);
  const logCountBeforeSame = Number((await pool.query(`SELECT count(*) AS c FROM jpo_admin_log WHERE action NOT IN ('Panel unlocked') AND ts < now() - interval '10 seconds'`)).rows[0].c);
  const newRows = (await pool.query(`SELECT action FROM jpo_admin_log WHERE ts > now() - interval '60 seconds' AND action <> 'Panel unlocked'`)).rows;
  ok(newRows.length === 0, "coin adjustments left NO activity-log entries");

  A.s.close(); B.s.close();
} catch (err) {
  console.error("TEST ERROR:", err.message);
  fails.push(err.message);
} finally {
  server.kill();
  await cleanup().catch(() => {});
  await pool.end();
}
console.log(fails.length ? `RESULT: FAIL (${fails.length})` : "RESULT: PASS");
process.exit(fails.length ? 1 : 0);
