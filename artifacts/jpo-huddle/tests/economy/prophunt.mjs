// Prop Hunt (Hide & Seek): admin starts a round from their spot; joiners
// teleport to that spot and freeze; the hider's moves are never broadcast;
// after the hide timer the prop appears at the hider's final position;
// a close-range E (phGuess) wins; far guesses do nothing; the round cleans
// up after a no-joiner start and after a hider disconnect.
// Run: node tests/economy/prophunt.mjs   (needs DATABASE_URL + ADMIN_PASSWORD)
import { io } from "socket.io-client";
import { spawn } from "child_process";
import { createRequire } from "module";
const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const pg = require("pg");

const PORT = process.env.TEST_PH_PORT || "20987";
const URL = `http://localhost:${PORT}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const ADMIN_PWD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PWD) { console.error("ADMIN_PASSWORD not set"); process.exit(1); }

const rand = Math.random().toString(36).slice(2, 8);
const E_A = `pht-a-${rand}@justpressone.com`;   // boss / hider (admin)
const E_B = `pht-b-${rand}@justpressone.com`;   // seeker
const E_C = `pht-c-${rand}@justpressone.com`;   // bystander (watches broadcasts)

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
const cleanup = () => pool.query(`DELETE FROM jpo_players WHERE email LIKE 'pht-%@justpressone.com'`);
const connect = (email, first, character) => {
  const s = io(URL, { transports: ["websocket"], reconnection: false });
  const p = new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
  return { s, ready: p.then(() => s.emit("register", {
    firstName: first, lastName: "Pht", email, password: "testpass123", character, department: "IT",
  })) };
};

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
  // Seed in the void -> the server's void-rescue respawns everyone at
  // GRASS_SPAWN, a guaranteed-painted tile (hand-picked coords risk landing
  // on walls and getting every later playerMove silently void-rejected).
  await pool.query(
    `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, coins, cosmetics, last_daily_bonus, x, y)
     VALUES ($1,'Alba','Pht','Alba Pht','adam',true,100,ARRAY[]::text[],CURRENT_DATE,1,1),
            ($2,'Bogs','Pht','Bogs Pht','bob', true,100,ARRAY[]::text[],CURRENT_DATE,1,1),
            ($3,'Cara','Pht','Cara Pht','amelia',true,100,ARRAY[]::text[],CURRENT_DATE,1,1)`,
    [E_A, E_B, E_C]);

  const A = connect(E_A, "Alba", "adam");
  const B = connect(E_B, "Bogs", "bob");
  const C = connect(E_C, "Cara", "amelia");
  const aApr = queue(A.s, "approved"), bApr = queue(B.s, "approved"), cApr = queue(C.s, "approved");
  let base = null;
  const aRes = queue(A.s, "phResult");
  const bInv = queue(B.s, "phInvite"), cInv = queue(C.s, "phInvite");
  const cVan = queue(C.s, "phVanish");
  const bJoined = queue(B.s, "phJoined");
  const aHunt = queue(A.s, "phHunt"), bHunt = queue(B.s, "phHunt");
  const aEnd = queue(A.s, "phEnd"), bEnd = queue(B.s, "phEnd"), cEnd = queue(C.s, "phEnd");
  await A.ready; await B.ready; await C.ready;
  base = await aApr.next(15000, "A approved"); await bApr.next(15000, "B approved"); await cApr.next(15000, "C approved");
  console.log(`  (spawn base ${base.x},${base.y})`);
  await sleep(400);

  // Track what C hears about A's and B's movement.
  const movedIds = [];
  C.s.on("playerMoved", (d) => movedIds.push(d.id));

  // 0) non-admin can't start
  B.s.emit("phStart", { disguise: "cooler", hideSecs: 5, huntSecs: 60 });
  await sleep(600);
  ok(bInv.items.length === 0, "non-admin can't start a round");

  // 1) admin starts: invite for all, hider vanishes
  A.s.emit("adminAuth", { password: ADMIN_PWD });
  await new Promise((res) => A.s.once("adminAuthOk", res));
  A.s.emit("phStart", { disguise: "cooler", hideSecs: 5, huntSecs: 60 });
  const r1 = await aRes.next(8000, "phResult");
  ok(r1.ok === true, "admin start accepted");
  const inv = await bInv.next(8000, "B invite");
  console.log(`  (invite: ${JSON.stringify(inv)}, A.id=${A.s.id})`);
  ok(inv.hiderName === "Alba" && inv.hiderId === A.s.id, "invite names the boss");
  const van = await cVan.next(8000, "C phVanish");
  ok(van.id === A.s.id, "hider vanishes for everyone");
  await cInv.next(8000, "C invite");

  // 2) join teleports to the gathering base (A's start spot 1000,1000)
  B.s.emit("phJoin");
  const j = await bJoined.next(8000, "phJoined");
  ok(Math.abs(j.x - base.x) <= 60 && Math.abs(j.y - base.y) <= 60, "seeker teleported to the boss's spot");

  // 3) frozen seeker: B's move is dropped (C never hears it). Wait out the
  // join-teleport broadcast first so it can't pollute the captured ids.
  await sleep(500);
  movedIds.length = 0;
  B.s.emit("playerMove", { x: j.x + 40, y: j.y, dir: "right", anim: "walk" });
  await sleep(500);
  ok(!movedIds.includes(B.s.id), "frozen seeker's move is dropped");

  // 4) hider's walk to the hiding spot is never broadcast
  for (let i = 1; i <= 3; i++) {
    A.s.emit("playerMove", { x: base.x + i * 80, y: base.y, dir: "right", anim: "walk" });
    await sleep(400);
  }
  ok(!movedIds.includes(A.s.id), "hider's movement is never broadcast");

  // 5) hunt begins: prop at the hider's final spot with the chosen disguise
  const h = await bHunt.next(10000, "phHunt");
  ok(h.prop.disguise === "cooler", "prop wears the chosen disguise");
  console.log(`  (prop at ${h.prop.x},${h.prop.y}; base ${base.x},${base.y})`);
  ok(h.prop.x >= base.x + 80 && Math.abs(h.prop.y - base.y) <= 2, "prop sits at the hider's final (moved) spot");
  await aHunt.next(3000, "A phHunt");

  // 6) far guess does nothing; hider is frozen during the hunt
  B.s.emit("phGuess");
  await sleep(700);
  ok(bEnd.items.length === 0, "guess from across the room does nothing");
  movedIds.length = 0;
  A.s.emit("playerMove", { x: 1300, y: 1000, dir: "right", anim: "walk" });
  await sleep(500);
  ok(!movedIds.includes(A.s.id), "hider can't wander during the hunt");

  // 6b) hider can't set off position-leaking items or start After Dark
  await pool.query(`UPDATE jpo_players SET items = '{"confetti":1}'::jsonb WHERE email = $1`, [E_A]);
  const aItemErr = queue(A.s, "itemError");
  const cFx = queue(C.s, "groupEffect");
  A.s.emit("useItem", { item: "confetti" });
  const ie = await aItemErr.next(8000, "hider itemError");
  ok(/hiding/i.test(ie.message || ""), "hider's confetti is refused (no position leak)");
  ok(cFx.items.length === 0, "no groupEffect broadcast from the hider");
  const aRoundErr = queue(A.s, "roundError");
  A.s.emit("roundStart");
  const re = await aRoundErr.next(8000, "roundStart refused");
  ok(/hide & seek/i.test(re.message || ""), "After Dark can't start during Hide & Seek");

  // 6c) a client (re)joining mid-round gets a MASKED snapshot + can join the hunt
  const D = connect(`pht-d-${rand}@justpressone.com`, "Dodo", "adam");
  await pool.query(
    `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, coins, cosmetics, last_daily_bonus, x, y)
     VALUES ($1,'Dodo','Pht','Dodo Pht','adam',true,100,ARRAY[]::text[],CURRENT_DATE,1,1)`,
    [`pht-d-${rand}@justpressone.com`]);
  const dSnap = queue(D.s, "currentPlayers");
  const dInv = queue(D.s, "phInvite");
  const dHunt = queue(D.s, "phHunt");
  const dJoined = queue(D.s, "phJoined");
  await D.ready;
  const snap = await dSnap.next(15000, "D snapshot");
  const hiderEntry = snap[A.s.id];
  ok(!!hiderEntry && Math.abs(hiderEntry.x - base.x) <= 1 && Math.abs(hiderEntry.y - base.y) <= 1,
     "late joiner's snapshot masks the hider at the public gather spot");
  await dInv.next(8000, "late-joiner invite");
  await dHunt.next(8000, "late-joiner phHunt");
  D.s.emit("phJoin");
  const dj = await dJoined.next(8000, "mid-hunt join");
  ok(dj.phase === "hunting" && dj.endsAt > Date.now(), "mid-hunt join works (refresh recovery path)");
  D.s.disconnect();
  await sleep(300);

  // 7) B walks to the prop (first accepted move = free baseline) and wins
  B.s.emit("playerMove", { x: h.prop.x - 30, y: h.prop.y, dir: "right", anim: "walk" });
  await sleep(300);
  B.s.emit("phGuess");
  const end = await bEnd.next(8000, "phEnd");
  ok(end.found === true && end.winnerName === "Bogs", "close-range E catches the boss");
  ok(end.hider && end.hider.id === A.s.id, "reveal payload restores the hider");
  await aEnd.next(3000, "A phEnd"); await cEnd.next(3000, "C phEnd");

  // 8) no joiners → round self-cleans and a new one can start
  aEnd.drain();
  A.s.emit("phStart", { disguise: "punchbag", hideSecs: 5, huntSecs: 60 });
  await aRes.next(8000, "restart result");
  const e2 = await aEnd.next(12000, "empty-round end");
  ok(e2.found === false && e2.reason === "nobody joined", "round with no joiners ends itself");

  // 9) hider disconnect ends the round (let round-2's phEnd reach B first)
  await sleep(600);
  bInv.drain(); bEnd.drain();
  A.s.emit("phStart", { disguise: "treadmill", hideSecs: 30, huntSecs: 60 });
  await bInv.next(8000, "round 3 invite");
  B.s.emit("phJoin"); await bJoined.next(8000, "round 3 join");
  A.s.disconnect();
  const e3 = await bEnd.next(8000, "hider-left end");
  console.log(`  (e3: ${JSON.stringify(e3)})`);
  ok(e3.found === false && e3.reason === "hider left", "hider disconnecting ends the round");

  B.s.disconnect(); C.s.disconnect();
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
