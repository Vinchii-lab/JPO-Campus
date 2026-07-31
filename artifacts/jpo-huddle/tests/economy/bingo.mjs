// Office Bingo + admin banner: banner post/sync/clear, bingo lobby → join →
// calls → manual daub → false claim rejected → valid claim pays the prize.
// Spawns a THROWAWAY server on TEST_BINGO_PORT with fast timers (the dev
// server's 60s join / 4s calls are too slow for a test).
// Run: node tests/economy/bingo.mjs   (needs DATABASE_URL + ADMIN_PASSWORD)
import { io } from "socket.io-client";
import { spawn } from "child_process";
import { createRequire } from "module";
const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const pg = require("pg");

const PORT = process.env.TEST_BINGO_PORT || "20977";
const URL = `http://localhost:${PORT}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const rand = Math.random().toString(36).slice(2, 8);
const E_A = `bgo-a-${rand}@justpressone.com`;  // admin
const E_B = `bgo-b-${rand}@justpressone.com`;  // daubs, wins
const E_C = `bgo-c-${rand}@justpressone.com`;  // never daubs

const fails = [];
const ok = (cond, label) => { console.log((cond ? "  ✓ " : "  ✗ ") + label); if (!cond) fails.push(label); };
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
const coinsOf = async (email) => (await pool.query(`SELECT coins FROM jpo_players WHERE email=$1`, [email])).rows[0].coins;

async function cleanup() {
  await pool.query(`DELETE FROM jpo_players WHERE email LIKE 'bgo-%@justpressone.com'`);
}

const connect = (email, first, character) => {
  const s = io(URL, { transports: ["websocket"], reconnection: false });
  const p = new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
  return { s, ready: p.then(() => s.emit("register", {
    firstName: first, lastName: "Bgo", email, password: "testpass123", character, department: "IT",
  })) };
};

function hasLine(card, daubs) {
  const hit = (r, c) => card[r][c] === 0 || daubs.has(card[r][c]);
  for (let r = 0; r < 5; r++) if ([0,1,2,3,4].every((c) => hit(r, c))) return true;
  for (let c = 0; c < 5; c++) if ([0,1,2,3,4].every((r) => hit(r, c))) return true;
  if ([0,1,2,3,4].every((i) => hit(i, i))) return true;
  if ([0,1,2,3,4].every((i) => hit(i, 4 - i))) return true;
  return false;
}

// ── throwaway fast-timer server ──
const child = spawn("node", ["server.js"], {
  cwd: "/home/runner/workspace/artifacts/jpo-huddle",
  env: { ...process.env, PORT, BINGO_JOIN_MS: "2500", BINGO_CALL_MS: "120" },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr.on("data", (d) => process.stderr.write(`[srv] ${d}`));
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("server didn't boot")), 20000);
  child.stdout.on("data", (d) => { if (String(d).includes("running on port")) { clearTimeout(t); res(); } });
});

try {
  await cleanup();
  await pool.query(
    `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, coins, cosmetics, last_daily_bonus)
     VALUES ($1,'Admina','Bgo','Admina Bgo','adam',true,1000,ARRAY[]::text[],CURRENT_DATE),
            ($2,'Winnie','Bgo','Winnie Bgo','bob', true,1000,ARRAY[]::text[],CURRENT_DATE),
            ($3,'Sleepy','Bgo','Sleepy Bgo','amelia',true,1000,ARRAY[]::text[],CURRENT_DATE)`,
    [E_A, E_B, E_C]);
  console.log("seeded", rand);

  const A = connect(E_A, "Admina", "adam"), B = connect(E_B, "Winnie", "bob"), C = connect(E_C, "Sleepy", "amelia");
  const aApr = queue(A.s, "approved"), bApr = queue(B.s, "approved"), cApr = queue(C.s, "approved");
  const aAuth = queue(A.s, "adminAuthOk"), aRes = queue(A.s, "adminPriceResult"), aBg = queue(A.s, "adminBingoResult");
  const bBan = queue(B.s, "bannerUpdate"), cBan = queue(C.s, "bannerUpdate");
  const bLobby = queue(B.s, "bingoLobby"), cLobby = queue(C.s, "bingoLobby");
  const bCard = queue(B.s, "bingoCard"), cCard = queue(C.s, "bingoCard");
  const bStart = queue(B.s, "bingoStart");
  const bErr = queue(B.s, "bingoError");
  const bOver = queue(B.s, "bingoOver"), cOver = queue(C.s, "bingoOver");
  await Promise.all([A.ready, B.ready, C.ready]);
  await aApr.next(15000, "A approved"); await bApr.next(15000, "B approved"); await cApr.next(15000, "C approved");

  // ── admin banner ──
  A.s.emit("adminAuth", { password: process.env.ADMIN_PASSWORD });
  await aAuth.next(8000, "admin auth");
  bBan.drain(); cBan.drain();
  A.s.emit("adminBanner", { text: "Bingo in 5 minutes! 🎱" });
  ok(/every screen/.test((await aRes.next(8000, "banner ack")).message), "admin told banner is up");
  const bb = await bBan.next(8000, "B banner");
  ok(bb.banner && /Bingo in 5/.test(bb.banner.text), "banner reached another player live");
  cBan.drain();
  C.s.emit("uiSync");
  const cb = await cBan.next(8000, "C uiSync banner");
  ok(cb.banner && /Bingo in 5/.test(cb.banner.text), "late-login sync also serves the banner");
  A.s.emit("adminBanner", { text: "" });
  await aRes.next(8000, "banner clear ack");   // consume — keeps aRes in lockstep
  const bb2 = await bBan.next(8000, "B banner cleared");
  ok(bb2.banner === null, "clearing removes the banner everywhere");

  // ── bingo: not-enough-players round ──
  A.s.emit("adminBingoStart", { prize: 500 });
  ok(/announced/.test((await aBg.next(8000, "bingo ack")).message), "bingo announced");
  await bLobby.next(8000, "B lobby");
  B.s.emit("bingoJoin");
  await bCard.next(8000, "B card (solo)");
  const solo = await bOver.next(10000, "solo cancelled");
  ok(/not enough players/.test(solo.message), "solo game cancels itself");

  // ── bingo: full game ──
  await sleep(300); cOver.drain(); bOver.drain();   // solo-round broadcast went to everyone
  const bPre = await coinsOf(E_B), cPre = await coinsOf(E_C);
  A.s.emit("adminBingoStart", { prize: 500, mode: "manual" });
  const ack2 = await aBg.next(8000, "bingo2 ack");
  ok(/YOU call/.test(ack2.message) && ack2.mode === "manual", "manual (host) mode announced");
  await bLobby.next(8000, "B lobby 2"); await cLobby.next(8000, "C lobby 2");
  B.s.emit("bingoJoin"); C.s.emit("bingoJoin");
  const bc = await bCard.next(8000, "B card"); await cCard.next(8000, "C card");
  ok(Array.isArray(bc.card) && bc.card.length === 5 && bc.card[2][2] === 0, "card is 5x5 with a free center");
  const colOk = bc.card.every((row) => row.every((n, c) => n === 0 || (n > c * 15 && n <= (c + 1) * 15)));
  ok(colOk, "columns use real bingo ranges (B1-15 … O61-75)");
  const st = await bStart.next(8000, "game started");
  ok(st.mode === "manual", "players told the host is calling");

  // no auto balls in manual mode
  const bCallQ = queue(B.s, "bingoCall");
  await sleep(600);   // > 4 fast-call intervals — nothing should arrive
  ok(bCallQ.items.length === 0, "manual mode: no balls until the host deals");
  A.s.emit("adminBingoCall");
  ok((await bCallQ.next(8000, "hosted ball")).n >= 1, "host-dealt ball reaches players");
  const callAck = await aBg.next(8000, "call ack"); aBg.drain();
  ok(/Called [BINGO]-?\d*/.test(callAck.message) || /Called/.test(callAck.message), "host sees what was called");
  // a few more hand-dealt balls, then flip to auto for the rest
  for (let i = 0; i < 5; i++) { A.s.emit("adminBingoCall"); await sleep(60); }
  aBg.drain();
  A.s.emit("adminBingoMode", { mode: "auto" });
  ok(/Auto-calling ON/.test((await aBg.next(8000, "mode ack")).message), "mid-game switch to auto works");

  // false claim straight away
  B.s.emit("bingoClaim");
  ok(/Not a bingo/.test((await bErr.next(8000, "false claim")).message), "false BINGO rejected");

  // daub everything called that's on B's card; uncalled daubs must be ignored
  const daubs = new Set();
  const bDaubOk = queue(B.s, "bingoDaubOk");
  B.s.emit("bingoDaub", { n: bc.card.flat().find((n) => n !== 0) });   // nothing called yet → ignored
  let claimed = false;
  B.s.on("bingoCall", ({ n }) => {
    if (bc.card.some((row) => row.includes(n))) B.s.emit("bingoDaub", { n });
  });
  B.s.on("bingoDaubOk", ({ n }) => {
    daubs.add(n);
    if (!claimed && hasLine(bc.card, daubs)) { claimed = true; B.s.emit("bingoClaim"); }
  });
  const over = await bOver.next(60000, "game over");
  ok(/^Winnie/.test(over.winnerName) && over.prize === 500, "the dauber wins the 500-coin prize");
  ok(/BINGO!/.test((await cOver.next(8000, "C sees result")).message), "everyone sees the winner announcement");
  ok(await coinsOf(E_B) === bPre + 500, "DB: winner credited exactly the prize");
  ok(await coinsOf(E_C) === cPre, "DB: non-dauber earned nothing (no AFK farming)");

  console.log(fails.length ? `RESULT: FAIL (${fails.length})` : "RESULT: PASS");
} catch (err) {
  console.log("TEST ERROR:", err);
  console.log(`RESULT: FAIL (${fails.length + 1})`);
} finally {
  try { await cleanup(); } catch {}
  child.kill("SIGKILL");
  await pool.end();
  process.exit(0);
}
