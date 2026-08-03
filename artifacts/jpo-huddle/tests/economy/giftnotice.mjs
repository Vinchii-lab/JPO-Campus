// Lingering gift receipts: sendCoins writes a jpo_gift_notices row for the
// recipient, the live giftReceived event carries the row id, a reconnect
// replays undismissed notices (giftNotices), ✕ (giftNoticeSeen) deletes only
// the recipient's own row, and someone else's id can't be used to dismiss.
// Run: node tests/economy/giftnotice.mjs   (needs DATABASE_URL)
import { io } from "socket.io-client";
import { spawn } from "child_process";
import { createRequire } from "module";
const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const pg = require("pg");

const PORT = process.env.TEST_GIFTNOTICE_PORT || "20981";
const URL = `http://localhost:${PORT}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const rand = Math.random().toString(36).slice(2, 8);
const E_A = `gnt-a-${rand}@justpressone.com`;   // sender
const E_B = `gnt-b-${rand}@justpressone.com`;   // recipient

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
const noticesOf = async (email) =>
  (await pool.query(`SELECT id, from_name, amount FROM jpo_gift_notices WHERE email=$1 ORDER BY id`, [email])).rows;
const cleanup = async () => {
  await pool.query(`DELETE FROM jpo_players WHERE email LIKE 'gnt-%@justpressone.com'`);
  await pool.query(`DELETE FROM jpo_gift_notices WHERE email LIKE 'gnt-%@justpressone.com'`);
};

const connect = (email, first, character) => {
  const s = io(URL, { transports: ["websocket"], reconnection: false });
  const p = new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
  return { s, ready: p.then(() => s.emit("register", {
    firstName: first, lastName: "Gnt", email, password: "testpass123", character, department: "IT",
  })) };
};
// Re-login: approved emails restore straight into the office via register.
const signin = (email, first, character) => connect(email, first, character);

const server = spawn("node", ["server.js"], {
  cwd: "/home/runner/workspace/artifacts/jpo-huddle",
  env: { ...process.env, PORT },
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
     VALUES ($1,'Alba','Gnt','Alba Gnt','adam',true,2000,ARRAY[]::text[],CURRENT_DATE),
            ($2,'Bogs','Gnt','Bogs Gnt','bob', true,1000,ARRAY[]::text[],CURRENT_DATE)`,
    [E_A, E_B]);

  // A (sender) + B (recipient) online
  const A = connect(E_A, "Alba", "adam");
  const B = connect(E_B, "Bogs", "bob");
  const aApr = queue(A.s, "approved");
  const bApr = queue(B.s, "approved");
  const aCur = queue(A.s, "currentPlayers");
  const bGift = queue(B.s, "giftReceived");
  await A.ready; await B.ready;
  await aApr.next(15000, "A approved"); await bApr.next(15000, "B approved");
  await aCur.next();   // A is in the office
  await sleep(400);
  const bId = B.s.id;  // socket.io client id === server-side socket.id
  ok(!!bId, "found recipient socket id");

  // 1) live gift → giftReceived carries a DB id + a row exists
  A.s.emit("sendCoins", { targetId: bId, amount: 500 });
  const g1 = await bGift.next();
  ok(g1.fromName === "Alba" && g1.amount === 500, "live receipt has sender + amount");
  ok(Number.isInteger(g1.id), "live receipt carries a persistent id");
  let rows = await noticesOf(E_B);
  ok(rows.length === 1 && rows[0].amount === 500 && rows[0].from_name === "Alba", "notice row persisted for recipient");

  // 2) second gift, then B disconnects WITHOUT dismissing; on re-login both replay
  A.s.emit("sendCoins", { targetId: bId, amount: 250 });
  const g2 = await bGift.next();
  ok(Number.isInteger(g2.id) && g2.amount === 250, "second receipt persisted too");
  B.s.disconnect();
  await sleep(500);

  const B2 = signin(E_B, "Bogs", "bob");
  const b2Notices = queue(B2.s, "giftNotices");
  await B2.ready;
  const replay = await b2Notices.next();
  ok(Array.isArray(replay.notices) && replay.notices.length === 2, "re-login replays both undismissed notices");
  ok(replay.notices[0].amount === 250 && replay.notices[1].amount === 500, "replay is newest-first with amounts intact");

  // 3) someone else's id can't dismiss B's notice (A tries with B's row id)
  A.s.emit("giftNoticeSeen", { id: g1.id });
  await sleep(400);
  rows = await noticesOf(E_B);
  ok(rows.length === 2, "another player's dismiss doesn't touch the recipient's rows");

  // 4) B dismisses one → only that row is deleted
  B2.s.emit("giftNoticeSeen", { id: g1.id });
  await sleep(400);
  rows = await noticesOf(E_B);
  ok(rows.length === 1 && rows[0].id === g2.id, "✕ deletes exactly the dismissed notice");

  // 5) dismissing the other → none left; a fresh login replays nothing
  B2.s.emit("giftNoticeSeen", { id: g2.id });
  await sleep(400);
  rows = await noticesOf(E_B);
  ok(rows.length === 0, "second ✕ clears the last notice");
  B2.s.disconnect();
  await sleep(300);
  const B3 = signin(E_B, "Bogs", "bob");
  const b3Notices = queue(B3.s, "giftNotices");
  await B3.ready;
  let replayed = false;
  try { await b3Notices.next(2500, "giftNotices (should NOT arrive)"); replayed = true; } catch {}
  ok(!replayed, "clean login gets no giftNotices event");

  A.s.disconnect(); B3.s.disconnect();
} catch (err) {
  console.error("TEST ERROR:", err);
  fails.push(String(err));
} finally {
  await cleanup().catch(() => {});
  server.kill();
  await pool.end();
}
console.log(fails.length ? `\nFAILED: ${fails.length}` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
