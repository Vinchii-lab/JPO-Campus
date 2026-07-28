// Pet breed/color variants: a variant IS a pet id, so adopt/switch/broadcast/
// persist must flow through the existing pipeline untouched.
// Run: TEST_PORT=<dev port> node tests/pets/variants.mjs   (needs DATABASE_URL)
import { io } from "socket.io-client";
import { createRequire } from "module";
const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const pg = require("pg");

const PORT = process.env.TEST_PORT;
if (!PORT) { console.error("TEST_PORT missing"); process.exit(1); }
const URL = `http://localhost:${PORT}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const rand = Math.random().toString(36).slice(2, 8);
const EMAIL_A = `petvar-a-${rand}@justpressone.com`.toLowerCase();
const EMAIL_B = `petvar-b-${rand}@justpressone.com`.toLowerCase();

const fails = [];
const ok = (cond, label) => { console.log((cond ? "  ✓ " : "  ✗ ") + label); if (!cond) fails.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function queue(socket, name) {
  const q = { items: [], waiters: [] };
  socket.on(name, (d) => { const w = q.waiters.shift(); if (w) w(d); else q.items.push(d); });
  q.next = (timeoutMs = 15000, label = name) => new Promise((res, rej) => {
    if (q.items.length) return res(q.items.shift());
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${label}`)), timeoutMs);
    q.waiters.push((d) => { clearTimeout(t); res(d); });
  });
  q.silent = async (ms) => { try { await q.next(ms, "silent-check"); return false; } catch { return true; } };
  return q;
}

async function cleanup() {
  await pool.query(`DELETE FROM jpo_players WHERE email LIKE 'petvar-%@justpressone.com'`);
}

const connect = (email, first) => {
  const s = io(URL, { transports: ["websocket"], reconnection: false });
  const p = new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
  return { s, ready: p.then(() => s.emit("register", {
    firstName: first, lastName: "Petvartest", email, password: "testpass123", character: "adam", department: "IT",
  })) };
};

try {
  await cleanup();
  await pool.query(
    `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, coins, last_daily_bonus)
     VALUES ($1, 'Alpha', 'Petvartest', 'Alpha Petvartest', 'adam', true, 200000, CURRENT_DATE),
            ($2, 'Beta',  'Petvartest', 'Beta Petvartest',  'bob',  true, 50,     CURRENT_DATE)`,
    [EMAIL_A, EMAIL_B]);
  console.log("seeded", EMAIL_A, EMAIL_B);

  const A = connect(EMAIL_A, "Alpha"), B = connect(EMAIL_B, "Beta");
  const aApproved = queue(A.s, "approved"),   bApproved = queue(B.s, "approved");
  const aPetOk    = queue(A.s, "petSuccess"), aPetUpd   = queue(A.s, "petUpdate");
  const aCoins    = queue(A.s, "coinUpdate"), aErr      = queue(A.s, "shopError");
  const bBroad    = queue(B.s, "playerPetUpdate"), bJoined = queue(B.s, "playerJoined");
  await Promise.all([A.ready, B.ready]);
  await aApproved.next(15000, "A approved");
  await bApproved.next(15000, "B approved");
  const aId = A.s.id;
  bBroad.items.length = 0;

  // 1. Adopt a fancy variant (obsidian dragon, top of the ladder).
  A.s.emit("buyPet", { item: "pet_dragon_obsidian" });
  const buy1 = await aPetOk.next(8000, "petSuccess(obsidian)");
  ok(buy1.item === "pet_dragon_obsidian" && buy1.pet === "pet_dragon_obsidian", "variant adopt auto-brings it out");
  const c1 = (await aCoins.next(8000, "coinUpdate")).coins;
  ok(c1 >= 155000 && c1 <= 155010, `variant price 45000 charged (now ${c1})`);
  const br1 = await bBroad.next(8000, "broadcast(obsidian)");
  ok(br1.id === aId && br1.pet === "pet_dragon_obsidian", "broadcast carries the variant id");
  await sleep(700);

  // 2. Adopt the classic of the same species — both owned, switching is free.
  A.s.emit("buyPet", { item: "pet_dragon" });
  ok((await aPetOk.next(8000, "petSuccess(classic)")).pet === "pet_dragon", "classic adopt of same species");
  await aCoins.next(8000, "coinUpdate(classic)");   // drain the classic purchase's coin event
  await bBroad.next(8000, "broadcast(classic)");
  await sleep(700);
  A.s.emit("equipPet", { item: "pet_dragon_obsidian" });
  const sw = await aPetUpd.next(8000, "petUpdate(switch back)");
  ok(sw.pet === "pet_dragon_obsidian", "free switch back to the owned variant");
  const c2 = aCoins.items.length === 0;
  ok(c2, "switching variants moved no coins");
  await bBroad.next(8000, "broadcast(switch)");
  await sleep(700);

  // 3. Unknown variant id rejected exactly like any unknown pet id.
  A.s.emit("buyPet", { item: "pet_dragon_gold" });
  ok(await aPetOk.silent(2000), "unknown variant id: silent drop, no purchase");
  await sleep(700);
  A.s.emit("equipPet", { item: "pet_cat_black" });   // valid id, NOT owned
  ok(await aPetUpd.silent(2000), "un-owned variant equip rejected");

  // 4. Persistence through a real out-of-grace reconnect.
  A.s.disconnect();
  bJoined.items.length = 0;   // drop any join noise from A's original connect
  console.log("  (waiting out the disconnect grace window…)");
  await sleep(13000);
  const A2 = connect(EMAIL_A, "Alpha");
  const a2Approved = queue(A2.s, "approved");
  await A2.ready;
  const appr2 = await a2Approved.next(15000, "A re-approved");
  ok(appr2.pet === "pet_dragon_obsidian", `DB restore keeps the variant (${appr2.pet})`);
  ok(appr2.cosmetics.includes("pet_dragon") && appr2.cosmetics.includes("pet_dragon_obsidian"), "both looks owned after restore");
  const j = await bJoined.next(8000, "playerJoined(A back)");
  ok(j.pet === "pet_dragon_obsidian", "join snapshot carries the variant id");
  A2.s.disconnect();
} catch (err) {
  console.error("  ✗ EXCEPTION:", err.message);
  fails.push(err.message);
} finally {
  try { await cleanup(); } catch {}
  await pool.end();
}
console.log(fails.length ? `RESULT: FAIL (${fails.join(" | ")})` : "RESULT: PASS");
process.exit(fails.length ? 1 : 0);
