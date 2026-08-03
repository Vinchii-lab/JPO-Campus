// Shared-treat earnings buff: coffee_round/pizza_party grant 1.5× earnings
// (earnBoost event + persisted earn_until) to everyone in range — but ONLY
// when the treat reached someone besides the buyer. Solo use = speed only.
// Re-login restores a still-running buff. Solo coffee never grants it.
// Run: node tests/economy/earnboost.mjs   (needs DATABASE_URL)
import { io } from "socket.io-client";
import { spawn } from "child_process";
import { createRequire } from "module";
const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const pg = require("pg");

const PORT = process.env.TEST_EARNBOOST_PORT || "20983";
const URL = `http://localhost:${PORT}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const rand = Math.random().toString(36).slice(2, 8);
const E_A = `ebt-a-${rand}@justpressone.com`;   // buyer
const E_B = `ebt-b-${rand}@justpressone.com`;   // nearby coworker
const E_C = `ebt-c-${rand}@justpressone.com`;   // far away

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
const earnUntilOf = async (email) => {
  const { rows } = await pool.query(`SELECT earn_until FROM jpo_players WHERE email=$1`, [email]);
  return rows[0]?.earn_until ? new Date(rows[0].earn_until).getTime() : 0;
};
const cleanup = () => pool.query(`DELETE FROM jpo_players WHERE email LIKE 'ebt-%@justpressone.com'`);

const connect = (email, first, character) => {
  const s = io(URL, { transports: ["websocket"], reconnection: false });
  const p = new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
  return { s, ready: p.then(() => s.emit("register", {
    firstName: first, lastName: "Ebt", email, password: "testpass123", character, department: "IT",
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
  // A and B side by side; C far away. A owns the treats.
  await pool.query(
    `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, coins, cosmetics, last_daily_bonus, x, y, items)
     VALUES ($1,'Alba','Ebt','Alba Ebt','adam',true,1000,ARRAY[]::text[],CURRENT_DATE,1000,1000,'{"coffee_round":2,"pizza_party":1,"coffee":1}'::jsonb),
            ($2,'Bogs','Ebt','Bogs Ebt','bob', true,1000,ARRAY[]::text[],CURRENT_DATE,1100,1000,'{}'::jsonb),
            ($3,'Cara','Ebt','Cara Ebt','amelia',true,1000,ARRAY[]::text[],CURRENT_DATE,5000,5000,'{}'::jsonb)`,
    [E_A, E_B, E_C]);

  const A = connect(E_A, "Alba", "adam");
  const B = connect(E_B, "Bogs", "bob");
  const C = connect(E_C, "Cara", "amelia");
  const aApr = queue(A.s, "approved"), bApr = queue(B.s, "approved"), cApr = queue(C.s, "approved");
  const aEarn = queue(A.s, "earnBoost"), bEarn = queue(B.s, "earnBoost"), cEarn = queue(C.s, "earnBoost");
  await A.ready; await B.ready; await C.ready;
  await aApr.next(15000, "A approved"); await bApr.next(15000, "B approved"); await cApr.next(15000, "C approved");
  await sleep(500);

  // 1) coffee round with B nearby → both get earnBoost (~10 min), C gets none
  const t0 = Date.now();
  A.s.emit("useItem", { item: "coffee_round" });
  const ea = await aEarn.next(8000, "buyer earnBoost");
  const eb = await bEarn.next(8000, "neighbor earnBoost");
  ok(ea.mult === 1.5 && eb.mult === 1.5, "both get the 1.5× buff event");
  const tenMin = 10 * 60_000;
  ok(Math.abs(ea.until - (t0 + tenMin)) < 15_000, "buyer buff runs ~10 minutes");
  ok(Math.abs(eb.until - (t0 + tenMin)) < 15_000, "neighbor buff runs ~10 minutes");
  await sleep(700);
  ok(cEarn.items.length === 0, "far-away player gets nothing");
  const dbA = await earnUntilOf(E_A), dbB = await earnUntilOf(E_B), dbC = await earnUntilOf(E_C);
  ok(dbA > Date.now() && dbB > Date.now(), "earn_until persisted for both recipients");
  ok(dbC === 0, "far-away player has no earn_until");

  // 2) pizza party EXTENDS to ~20 min (never shortens)
  A.s.emit("useItem", { item: "pizza_party" });
  const pa = await aEarn.next(8000, "pizza earnBoost");
  ok(Math.abs(pa.until - (Date.now() + 20 * 60_000)) < 15_000, "pizza extends the buff to ~20 minutes");

  // 3) re-login restores the running buff
  B.s.disconnect();
  await sleep(500);
  const B2 = connect(E_B, "Bogs", "bob");
  const b2Earn = queue(B2.s, "earnBoost");
  await B2.ready;
  const rb = await b2Earn.next(15000, "restored earnBoost");
  ok(rb.until > Date.now() && rb.mult === 1.5, "re-login restores the running buff");

  // 4) solo coffee round (C alone, nobody in range) → NO earnings buff
  cEarn.drain();
  await pool.query(`UPDATE jpo_players SET items = '{"coffee_round":1}'::jsonb, earn_until = NULL WHERE email = $1`, [E_C]);
  C.s.disconnect(); await sleep(400);
  const C2 = connect(E_C, "Cara", "amelia");
  const c2Earn = queue(C2.s, "earnBoost");
  const c2Boost = queue(C2.s, "coffeeBoost");
  await C2.ready; await sleep(700);
  c2Earn.drain();
  C2.s.emit("useItem", { item: "coffee_round" });
  await c2Boost.next(8000, "solo speed boost");   // speed boost still fires
  let soloEarn = false;
  try { await c2Earn.next(2500, "earnBoost (should NOT arrive)"); soloEarn = true; } catch {}
  ok(!soloEarn, "solo round in an empty corner grants NO earnings buff");
  ok((await earnUntilOf(E_C)) === 0, "no earn_until written for the solo buyer");

  // 5) plain solo coffee never grants it either (fresh, never-boosted player)
  const E_D = `ebt-d-${rand}@justpressone.com`;
  await pool.query(
    `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, coins, cosmetics, last_daily_bonus, x, y, items)
     VALUES ($1,'Dodo','Ebt','Dodo Ebt','adam',true,1000,ARRAY[]::text[],CURRENT_DATE,8000,8000,'{"coffee":1}'::jsonb)`, [E_D]);
  const D = connect(E_D, "Dodo", "adam");
  const dEarn = queue(D.s, "earnBoost");
  const dBoost = queue(D.s, "coffeeBoost");
  await D.ready; await sleep(700);
  dEarn.drain(); dBoost.drain();
  D.s.emit("useItem", { item: "coffee" });
  let gotOwnBoost = false;
  for (let i = 0; i < 5 && !gotOwnBoost; i++) {
    const ev = await dBoost.next(8000, "solo coffee speed boost");
    if (ev.id === D.s.id) gotOwnBoost = true;
  }
  ok(gotOwnBoost, "solo coffee speed boost fires");
  let soloCoffee = false;
  try { await dEarn.next(2500, "earnBoost (should NOT arrive)"); soloCoffee = true; } catch {}
  ok(!soloCoffee, "plain solo coffee stays speed-only");

  A.s.disconnect(); B2.s.disconnect(); C2.s.disconnect(); D.s.disconnect();
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
