// Pet accessories: buy/equip/broadcast happy path + rejection matrix + restore.
// Run: TEST_PORT=<dev port> node tests/pets/petacc.mjs   (needs DATABASE_URL)
//
// Covers: buyPetAcc auto-equip + coin deduction + broadcast, accessory slot
// carried on petSuccess when adopting after the accessory, take-off/put-on,
// un-owned equip rejection, unknown-id silence, cross-equip guards (pet ids
// vs petacc_ ids never land in each other's slots), poor-buyer rejection,
// and the DB snapshot (approved + playerJoined carry petAcc after a real,
// out-of-grace reconnect).
import { io } from "socket.io-client";
import { createRequire } from "module";
const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const pg = require("pg");

const PORT = process.env.TEST_PORT;
if (!PORT) { console.error("TEST_PORT missing"); process.exit(1); }
const URL = `http://localhost:${PORT}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const rand = Math.random().toString(36).slice(2, 8);
const EMAIL_A = `petacc-a-${rand}@justpressone.com`.toLowerCase(); // rich buyer
const EMAIL_B = `petacc-b-${rand}@justpressone.com`.toLowerCase(); // poor observer

const fails = [];
const ok = (cond, label) => { console.log((cond ? "  ✓ " : "  ✗ ") + label); if (!cond) fails.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function queue(socket, name) {
  const q = { items: [], waiters: [] };
  socket.on(name, (d) => {
    const w = q.waiters.shift();
    if (w) w(d); else q.items.push(d);
  });
  q.next = (timeoutMs = 15000, label = name) => new Promise((res, rej) => {
    if (q.items.length) return res(q.items.shift());
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${label}`)), timeoutMs);
    q.waiters.push((d) => { clearTimeout(t); res(d); });
  });
  // Negative assertion helper: true if the event did NOT arrive in the window.
  q.silent = async (ms) => { try { await q.next(ms, "silent-check"); return false; } catch { return true; } };
  return q;
}

async function cleanup() {
  await pool.query(`DELETE FROM jpo_players WHERE email LIKE 'petacc-%@justpressone.com'`);
}

const connect = (email, first) => {
  const s = io(URL, { transports: ["websocket"], reconnection: false });
  const p = new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
  return { s, ready: p.then(() => s.emit("register", {
    firstName: first, lastName: "Petacctest", email, password: "testpass123", character: "adam", department: "IT",
  })) };
};

try {
  await cleanup();
  // last_daily_bonus = today keeps the +10 login bonus out of the coin math
  // (the +2/min tick still gets range slack below).
  await pool.query(
    `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, coins, last_daily_bonus)
     VALUES ($1, 'Alpha', 'Petacctest', 'Alpha Petacctest', 'adam', true, 100000, CURRENT_DATE),
            ($2, 'Beta',  'Petacctest', 'Beta Petacctest',  'bob',  true, 50,     CURRENT_DATE)`,
    [EMAIL_A, EMAIL_B]);
  console.log("seeded", EMAIL_A, EMAIL_B);

  const A = connect(EMAIL_A, "Alpha"), B = connect(EMAIL_B, "Beta");
  const aApproved = queue(A.s, "approved"),      bApproved = queue(B.s, "approved");
  const aAccOk    = queue(A.s, "petAccSuccess"), aAccUpd   = queue(A.s, "petAccUpdate");
  const aPetOk    = queue(A.s, "petSuccess"),    aPetUpd   = queue(A.s, "petUpdate");
  const aCoins    = queue(A.s, "coinUpdate"),    aErr      = queue(A.s, "shopError");
  const bBroad    = queue(B.s, "playerPetUpdate"), bErr    = queue(B.s, "shopError");
  const bJoined   = queue(B.s, "playerJoined");
  await Promise.all([A.ready, B.ready]);
  const apprA = await aApproved.next(15000, "A approved");
  await bApproved.next(15000, "B approved");
  const aId = A.s.id;
  ok(apprA.petAcc === "", `fresh approved payload has empty petAcc slot`);
  await bJoined.silent(50); // drain any join noise before the assertions below
  bBroad.items.length = 0;

  // 1. Buy an accessory BEFORE owning any pet — allowed, auto-equips, waits invisibly.
  A.s.emit("buyPetAcc", { item: "petacc_bow" });
  const buy1 = await aAccOk.next(8000, "petAccSuccess(bow)");
  ok(buy1.item === "petacc_bow" && buy1.petAcc === "petacc_bow", `buy auto-equips (petAcc=${buy1.petAcc})`);
  const c1 = (await aCoins.next(8000, "coinUpdate")).coins;
  ok(c1 >= 98000 && c1 <= 98010 && (c1 - 98000) % 2 === 0, `coins deducted 2000 (now ${c1})`);
  const br1 = await bBroad.next(8000, "playerPetUpdate(broadcast)");
  ok(br1.id === aId && br1.pet === "" && br1.petAcc === "petacc_bow", `broadcast carries petAcc with no pet out`);
  await sleep(700);

  // 2. Adopt a pet — the already-owned accessory carries over on the ack + broadcast.
  A.s.emit("buyPet", { item: "pet_duck" });
  const pet1 = await aPetOk.next(8000, "petSuccess(duck)");
  ok(pet1.pet === "pet_duck" && pet1.petAcc === "petacc_bow", `petSuccess carries the worn accessory`);
  const br2 = await bBroad.next(8000, "playerPetUpdate(duck)");
  ok(br2.pet === "pet_duck" && br2.petAcc === "petacc_bow", `broadcast: duck arrives wearing the bow`);
  await sleep(700);

  // 3. Take it off ('' = bare pet) and put it back on.
  A.s.emit("equipPetAcc", { item: "" });
  ok((await aAccUpd.next(8000, "petAccUpdate(off)")).petAcc === "", "take off → petAcc ''");
  ok((await bBroad.next(8000, "broadcast(off)")).petAcc === "", "broadcast: bare pet");
  await sleep(700);
  A.s.emit("equipPetAcc", { item: "petacc_bow" });
  ok((await aAccUpd.next(8000, "petAccUpdate(on)")).petAcc === "petacc_bow", "put back on");
  await bBroad.next(8000, "broadcast(on)");
  await sleep(700);

  // 4. Rejections: un-owned equip, unknown buy id, cross-slot equips.
  A.s.emit("equipPetAcc", { item: "petacc_crown" });
  ok(/don't own/i.test(await aErr.next(8000, "shopError(unowned)")), "un-owned accessory equip rejected");
  await sleep(700);
  A.s.emit("buyPetAcc", { item: "petacc_bogus" });
  ok(await aAccOk.silent(2000), "unknown accessory id: silent drop, no purchase");
  await sleep(700);
  A.s.emit("equipPet", { item: "petacc_bow" });       // accessory id into the PET slot
  ok(await aPetUpd.silent(2000), "petacc_ id rejected by equipPet (cross-slot guard)");
  await sleep(700);
  A.s.emit("equipPetAcc", { item: "pet_duck" });      // pet id into the ACCESSORY slot
  ok(await aAccUpd.silent(2000), "pet_ id rejected by equipPetAcc (cross-slot guard)");
  await sleep(700);

  // 5. Poor buyer.
  B.s.emit("buyPetAcc", { item: "petacc_bow" });
  ok(/not enough/i.test(await bErr.next(8000, "shopError(poor)")), "50-coin buyer rejected");

  // 6. Persistence: real reconnect OUTSIDE the grace window → DB restore path.
  A.s.disconnect();
  console.log("  (waiting out the disconnect grace window…)");
  await sleep(13000);
  const A2 = connect(EMAIL_A, "Alpha");
  const a2Approved = queue(A2.s, "approved");
  await A2.ready;
  const appr2 = await a2Approved.next(15000, "A re-approved");
  ok(appr2.pet === "pet_duck" && appr2.petAcc === "petacc_bow", `DB restore: approved carries pet+petAcc (${appr2.pet}/${appr2.petAcc})`);
  ok(appr2.cosmetics.includes("petacc_bow") && appr2.cosmetics.includes("pet_duck"), "ownership survived in cosmetics array");
  const j = await bJoined.next(8000, "playerJoined(A back)");
  ok(j.pet === "pet_duck" && j.petAcc === "petacc_bow", "playerJoined snapshot carries petAcc");
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
