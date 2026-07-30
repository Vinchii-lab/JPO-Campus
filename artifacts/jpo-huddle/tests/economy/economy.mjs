// Economy features (July 2026): coin gifting, pet trades, admin price control.
// Run: TEST_PORT=<dev port> node tests/economy/economy.mjs   (needs DATABASE_URL + ADMIN_PASSWORD)
//
// Covers: sendCoins happy path (both balances move atomically, receiver
// toast payload), self/overdraw/daily-cap rejections, tradePetsOf lists,
// tradeOffer → tradeIncoming → tradeAccept (pets swap in the DB, sweetener
// coins move, auto-adopt broadcast), decline path, and adminSetPrice
// (persisted override + priceUpdate broadcast + buy at the NEW price).
import { io } from "socket.io-client";
import { createRequire } from "module";
const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const pg = require("pg");

const PORT = process.env.TEST_PORT;
if (!PORT) { console.error("TEST_PORT missing"); process.exit(1); }
const URL = `http://localhost:${PORT}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const rand = Math.random().toString(36).slice(2, 8);
const EMAIL_A = `econ-a-${rand}@justpressone.com`.toLowerCase(); // rich sender/trader
const EMAIL_B = `econ-b-${rand}@justpressone.com`.toLowerCase(); // receiver/trader

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
    const w = (d) => { clearTimeout(t); res(d); };
    const t = setTimeout(() => { const i = q.waiters.indexOf(w); if (i >= 0) q.waiters.splice(i, 1); rej(new Error(`timeout waiting for ${label}`)); }, timeoutMs);
    q.waiters.push(w);
  });
  q.silent = async (ms) => { try { await q.next(ms, "silent-check"); return false; } catch { return true; } };
  return q;
}

async function cleanup() {
  await pool.query(`DELETE FROM jpo_players WHERE email LIKE 'econ-%@justpressone.com'`);
  await pool.query(`DELETE FROM jpo_shop_prices WHERE item_id = 'petacc_bow'`);
}

const connect = (email, first, character) => {
  const s = io(URL, { transports: ["websocket"], reconnection: false });
  const p = new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
  return { s, ready: p.then(() => s.emit("register", {
    firstName: first, lastName: "Econtest", email, password: "testpass123", character, department: "IT",
  })) };
};

try {
  await cleanup();
  await pool.query(
    `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, coins, cosmetics, last_daily_bonus)
     VALUES ($1, 'Alpha', 'Econtest', 'Alpha Econtest', 'adam', true, 100000, ARRAY['pet_cat'],  CURRENT_DATE),
            ($2, 'Beta',  'Econtest', 'Beta Econtest',  'bob',  true, 1000,   ARRAY['pet_duck'], CURRENT_DATE)`,
    [EMAIL_A, EMAIL_B]);
  console.log("seeded", EMAIL_A, EMAIL_B);

  const A = connect(EMAIL_A, "Alpha", "adam"), B = connect(EMAIL_B, "Beta", "bob");
  const aApproved = queue(A.s, "approved"), bApproved = queue(B.s, "approved");
  const aGiftRes  = queue(A.s, "giftResult"),  bGiftRecv = queue(B.s, "giftReceived");
  const aCoins    = queue(A.s, "coinUpdate"),  bCoins    = queue(B.s, "coinUpdate");
  const aTradeErr = queue(A.s, "tradeError"),  aTradePets = queue(A.s, "tradePets");
  const aTradeSent = queue(A.s, "tradeSent"),  bTradeIn  = queue(B.s, "tradeIncoming");
  const aTradeDone = queue(A.s, "tradeComplete"), bTradeDone = queue(B.s, "tradeComplete");
  const aTradeEnd = queue(A.s, "tradeEnded"),  bTradeEnd = queue(B.s, "tradeEnded");
  const aPriceUpd = queue(A.s, "priceUpdate"), aAccOk    = queue(A.s, "petAccSuccess");
  const aShopErr  = queue(A.s, "shopError");
  await Promise.all([A.ready, B.ready]);
  await aApproved.next(15000, "A approved");
  await bApproved.next(15000, "B approved");
  const aId = A.s.id, bId = B.s.id;

  // ── 1) Coin gifting ────────────────────────────────────────────────────
  console.log("― gifting");
  A.s.emit("sendCoins", { targetId: bId, amount: 500 });
  const g1 = await aGiftRes.next(8000, "giftResult ok");
  ok(g1.ok === true, "gift 500 accepted");
  const recv = await bGiftRecv.next(8000, "giftReceived");
  ok(recv.amount === 500 && /Alpha/.test(recv.fromName), "B told: 500 coins from Alpha");
  const aBal = (await aCoins.next(8000, "A coinUpdate")).coins;
  const bBal = (await bCoins.next(8000, "B coinUpdate")).coins;
  ok(aBal <= 99500 + 6, `A balance debited (${aBal})`);
  ok(bBal >= 1500,      `B balance credited (${bBal})`);

  await sleep(2100); // buyBucket pacing
  A.s.emit("sendCoins", { targetId: aId, amount: 100 });
  const gSelf = await aGiftRes.next(8000, "self-gift result");
  ok(gSelf.ok === false, "self-gift rejected");

  await sleep(2100);
  A.s.emit("sendCoins", { targetId: bId, amount: 4900 });   // 500 already sent today → over the 5000 cap
  const gCap = await aGiftRes.next(8000, "cap result");
  ok(gCap.ok === false && /limit/i.test(gCap.message), `daily cap enforced (${gCap.message})`);

  // ── 2) Pet trade ───────────────────────────────────────────────────────
  console.log("― trade");
  await sleep(2100);
  A.s.emit("tradePetsOf", { targetId: bId });
  const lists = await aTradePets.next(8000, "tradePets");
  ok(lists.mine.includes("pet_cat") && lists.theirs.includes("pet_duck"), "composer lists both pets");

  A.s.emit("tradeOffer", { targetId: bId, offerPet: "pet_cat", askPet: "pet_duck", coins: 250 });
  await aTradeSent.next(8000, "tradeSent");
  const inc = await bTradeIn.next(8000, "tradeIncoming");
  ok(inc.offerPet === "pet_cat" && inc.askPet === "pet_duck" && inc.coins === 250, "B sees the exact offer");

  B.s.emit("tradeDecline");
  const end = await aTradeEnd.next(8000, "tradeEnded after decline");
  ok(/declined/i.test(end.message), "A told about the decline");

  await sleep(2100);
  A.s.emit("tradeOffer", { targetId: bId, offerPet: "pet_cat", askPet: "pet_duck", coins: 250 });
  await aTradeSent.next(8000, "tradeSent 2");
  await bTradeIn.next(8000, "tradeIncoming 2");
  B.s.emit("tradeAccept");
  const adone = await aTradeDone.next(10000, "A tradeComplete");
  const bdone = await bTradeDone.next(10000, "B tradeComplete");
  ok(adone.got === "pet_duck" && adone.gave === "pet_cat" && adone.coins === -250, "A got the duck, paid 250");
  ok(bdone.got === "pet_cat" && bdone.gave === "pet_duck" && bdone.coins === 250, "B got the cat, +250");
  const { rows: dbRows } = await pool.query(
    `SELECT email, coins, cosmetics, equipped_pet FROM jpo_players WHERE email = ANY($1)`, [[EMAIL_A, EMAIL_B]]);
  const dbA = dbRows.find(r => r.email === EMAIL_A), dbB = dbRows.find(r => r.email === EMAIL_B);
  ok(dbA.cosmetics.includes("pet_duck") && !dbA.cosmetics.includes("pet_cat"), "DB: A owns duck, not cat");
  ok(dbB.cosmetics.includes("pet_cat") && !dbB.cosmetics.includes("pet_duck"), "DB: B owns cat, not duck");
  ok(dbA.equipped_pet === "pet_duck" && dbB.equipped_pet === "pet_cat", "DB: both auto-adopted the new pet");

  // ── 3) Admin price control ─────────────────────────────────────────────
  console.log("― admin prices");
  const ADM = io(URL, { transports: ["websocket"], reconnection: false });
  await new Promise((res, rej) => { ADM.on("connect", res); ADM.on("connect_error", rej); });
  const admOk = queue(ADM, "adminAuthOk"), admRes = queue(ADM, "adminPriceResult");
  ADM.emit("adminAuth", { password: process.env.ADMIN_PASSWORD });
  await admOk.next(8000, "adminAuthOk");
  ADM.emit("adminSetPrice", { item: "petacc_bow", price: 123 });
  const pr = await admRes.next(8000, "adminPriceResult");
  ok(pr.ok === true, `price change accepted (${pr.message})`);
  const upd = await aPriceUpd.next(8000, "priceUpdate broadcast");
  ok(upd.item === "petacc_bow" && upd.price === 123, "players got the live price broadcast");
  const { rows: pRows } = await pool.query(`SELECT price FROM jpo_shop_prices WHERE item_id = 'petacc_bow'`);
  ok(pRows[0]?.price === 123, "override persisted in jpo_shop_prices");

  await sleep(2100);
  const preBuy = dbA.coins;
  A.s.emit("buyPetAcc", { item: "petacc_bow" });
  const accOk = await aAccOk.next(8000, "petAccSuccess at new price");
  ok(accOk.item === "petacc_bow", "bow bought");
  const { rows: postRows } = await pool.query(`SELECT coins FROM jpo_players WHERE email = $1`, [EMAIL_A]);
  const spent = preBuy - postRows[0].coins;
  ok(spent >= 123 - 6 && spent <= 123, `bought at the OVERRIDDEN price (spent ~${spent}, not 2000)`);

  // reset override back to default → row deleted
  ADM.emit("adminSetPrice", { item: "petacc_bow", price: 2000 });
  const pr2 = await admRes.next(8000, "adminPriceResult reset");
  ok(pr2.ok === true, "reset to default accepted");
  const { rows: goneRows } = await pool.query(`SELECT 1 FROM jpo_shop_prices WHERE item_id = 'petacc_bow'`);
  ok(goneRows.length === 0, "default price clears the override row");

  A.s.disconnect(); B.s.disconnect(); ADM.disconnect();
} catch (err) {
  console.error("TEST ERROR:", err);
  fails.push(String(err));
} finally {
  try { await cleanup(); } catch {}
  await pool.end();
}
console.log(fails.length ? `RESULT: FAIL (${fails.length})` : "RESULT: PASS");
process.exit(fails.length ? 1 : 0);
