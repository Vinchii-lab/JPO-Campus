// HQ-Buddy: weekly secret pairing. First player of the week gets Huddles as a
// placeholder buddy; the next unpaired player upgrades that into a real pair
// (both notified privately). Quiz: each answers 3 this-or-that questions about
// themselves, then guesses the buddy's picks (must be nearby) for coins per
// correct — one-shot per week, double-submit safe. Third player is odd one
// out and keeps Huddles. No buddy info is ever broadcast.
// Run: node tests/economy/buddy.mjs   (needs DATABASE_URL + ADMIN_PASSWORD)
import { io } from "socket.io-client";
import { spawn } from "child_process";
import { createRequire } from "module";
const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const pg = require("pg");

const PORT = process.env.TEST_BUD_PORT || "20991";
const URL = `http://localhost:${PORT}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const rand = Math.random().toString(36).slice(2, 8);
const E_A = `bud-a-${rand}@justpressone.com`;
const E_B = `bud-b-${rand}@justpressone.com`;
const E_C = `bud-c-${rand}@justpressone.com`;

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
const cleanup = async () => {
  await pool.query(`DELETE FROM jpo_players WHERE email LIKE 'bud-%@justpressone.com'`);
  await pool.query(`DELETE FROM jpo_buddies WHERE email LIKE 'bud-%@justpressone.com' OR buddy_email LIKE 'bud-%@justpressone.com'`).catch(() => {});
};
const connect = (email, first, character) => {
  const s = io(URL, { transports: ["websocket"], reconnection: false });
  const p = new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
  return { s, ready: p.then(() => s.emit("register", {
    firstName: first, lastName: "Bud", email, password: "testpass123", character, department: "IT",
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
  await pool.query(
    `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, coins, cosmetics, last_daily_bonus, x, y)
     VALUES ($1,'Alba','Bud','Alba Bud','adam',true,100,ARRAY[]::text[],CURRENT_DATE,1,1),
            ($2,'Bogs','Bud','Bogs Bud','bob', true,100,ARRAY[]::text[],CURRENT_DATE,1,1),
            ($3,'Cara','Bud','Cara Bud','amelia',true,100,ARRAY[]::text[],CURRENT_DATE,1,1)`,
    [E_A, E_B, E_C]);

  // 1) A logs in first → placeholder buddy Huddles
  const A = connect(E_A, "Alba", "adam");
  const aApr = queue(A.s, "approved"), aBud = queue(A.s, "buddyInfo");
  await A.ready;
  const base = await aApr.next(15000, "A approved");
  const ab1 = await aBud.next(10000, "A buddyInfo #1");
  ok(ab1.isNpc === true && ab1.buddyName === "Huddles", "first player of the week gets Huddles");

  // 2) B logs in → upgraded into a real pair; A gets a live refresh
  const B = connect(E_B, "Bogs", "bob");
  const bApr = queue(B.s, "approved"), bBud = queue(B.s, "buddyInfo");
  await B.ready; await bApr.next(15000, "B approved");
  const bb1 = await bBud.next(10000, "B buddyInfo");
  ok(bb1.isNpc === false && bb1.buddyName === "Alba", "second player pairs with the first");
  const ab2 = await aBud.next(10000, "A buddyInfo refresh");
  ok(ab2.isNpc === false && ab2.buddyName === "Bogs", "placeholder player is upgraded live");

  // 3) C logs in → odd one out, keeps Huddles
  const C = connect(E_C, "Cara", "amelia");
  const cApr = queue(C.s, "approved"), cBud = queue(C.s, "buddyInfo");
  await C.ready; await cApr.next(15000, "C approved");
  const cb1 = await cBud.next(10000, "C buddyInfo");
  ok(cb1.isNpc === true, "odd player out keeps Huddles");

  // 4) quiz questions are drawn server-side and identical for the pair
  const aQuiz = queue(A.s, "buddyQuiz"), bQuiz = queue(B.s, "buddyQuiz");
  A.s.emit("buddyQuizOpen"); B.s.emit("buddyQuizOpen");
  const aq = await aQuiz.next(8000, "A quiz"), bq = await bQuiz.next(8000, "B quiz");
  ok(aq.questions.length === 3 && JSON.stringify(aq.questions) === JSON.stringify(bq.questions),
     "both buddies see the same 3 questions");
  const cQuiz = queue(C.s, "buddyQuiz");
  C.s.emit("buddyQuizOpen");
  await sleep(600);
  ok(cQuiz.items.length === 0, "Huddles-buddy has no quiz");

  // 5) guessing before the buddy answered is refused
  const aMsg = queue(A.s, "buddyQuizMsg"), bMsg = queue(B.s, "buddyQuizMsg");
  const aRes = queue(A.s, "buddyQuizResult"), bRes = queue(B.s, "buddyQuizResult");
  A.s.emit("buddyQuizAnswer", { answers: [0, 1, 0] });
  const am1 = await aMsg.next(8000, "A answer saved");
  ok(!!am1.answered, "A's own answers save");
  A.s.emit("buddyQuizGuess", { guesses: [0, 0, 0] });
  const am2 = await aMsg.next(8000, "A early guess refused");
  ok(/hasn't answered/i.test(am2.message || ""), "guess refused until buddy answers");

  // 6) proximity required to guess (everyone spawns together at GRASS_SPAWN,
  //    so walk B far away first, then guess → refused)
  B.s.emit("buddyQuizAnswer", { answers: [1, 1, 1] });
  await bMsg.next(8000, "B answer saved");
  // Stay inside the anti-speed-hack budget (~195px/s × 1.6): 60px per 350ms.
  for (let i = 1; i <= 9; i++) { B.s.emit("playerMove", { x: base.x + i * 60, y: base.y, dir: "right", anim: "walk" }); await sleep(350); }
  B.s.emit("buddyQuizGuess", { guesses: [0, 1, 0] });
  const bm1 = await bMsg.next(8000, "B far guess refused");
  ok(/closer/i.test(bm1.message || ""), "guessing from far away is refused");

  // 7) close-range guess scores against the buddy's real answers and pays
  for (let i = 8; i >= 0; i--) { B.s.emit("playerMove", { x: base.x + i * 60, y: base.y, dir: "left", anim: "walk" }); await sleep(350); }
  B.s.emit("buddyQuizGuess", { guesses: [0, 1, 0] });   // A answered [0,1,0] → 3/3
  const br = await bRes.next(8000, "B quiz result");
  ok(br.score === 3 && br.pay === 300, `perfect guess pays 3×100 (got score=${br.score}, pay=${br.pay})`);
  const { rows: bcoins } = await pool.query(`SELECT coins FROM jpo_players WHERE email=$1`, [E_B]);
  ok(bcoins[0].coins === 400, `coins persisted (100 → ${bcoins[0].coins})`);

  // 8) double-guess is a no-op (no second payout)
  B.s.emit("buddyQuizGuess", { guesses: [1, 1, 1] });
  const bm2 = await bMsg.next(8000, "B re-guess refused");
  ok(/already guessed/i.test(bm2.message || ""), "second guess refused");
  const { rows: bcoins2 } = await pool.query(`SELECT coins FROM jpo_players WHERE email=$1`, [E_B]);
  ok(bcoins2[0].coins === 400, "no double payout");

  // 9) A guesses B ([1,1,1]) partially right → partial pay
  A.s.emit("buddyQuizGuess", { guesses: [1, 1, 0] });   // 2/3
  const ar = await aRes.next(8000, "A quiz result");
  ok(ar.score === 2 && ar.pay === 200, "partial guess pays per correct");

  // 10) refresh restores the same pairing + quiz state (no re-pair)
  A.s.disconnect();
  await sleep(400);
  const A2 = connect(E_A, "Alba", "adam");
  const a2Bud = queue(A2.s, "buddyInfo");
  await A2.ready;
  const ab3 = await a2Bud.next(10000, "A refresh buddyInfo");
  ok(ab3.buddyName === "Bogs" && ab3.quizScore === 2, "refresh restores buddy + quiz score");
  A2.s.disconnect();

  // 11) privacy: C never heard anything about A/B's pairing
  ok(cBud.items.every((d) => d.isNpc), "no buddy info leaked to third parties");

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
