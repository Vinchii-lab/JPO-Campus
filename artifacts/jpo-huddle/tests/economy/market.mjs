// Bid stores / office market: list → bid (escrow) → raise → withdraw →
// accept (settle + refunds) → unlist, plus the offline-outcome mail queue.
// Run: TEST_PORT=<dev port> node tests/economy/market.mjs  (needs DATABASE_URL)
import { io } from "socket.io-client";
import { createRequire } from "module";
const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const pg = require("pg");

const PORT = process.env.TEST_PORT;
if (!PORT) { console.error("TEST_PORT missing"); process.exit(1); }
const URL = `http://localhost:${PORT}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const rand = Math.random().toString(36).slice(2, 8);
const E_A = `mkt-a-${rand}@justpressone.com`;  // seller (owns pet_cat)
const E_B = `mkt-b-${rand}@justpressone.com`;  // bidder, will win
const E_C = `mkt-c-${rand}@justpressone.com`;  // bidder, goes offline, loses

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
  await pool.query(`DELETE FROM jpo_store_listings WHERE seller_email LIKE 'mkt-%@justpressone.com'`);
  await pool.query(`DELETE FROM jpo_store_msgs WHERE email LIKE 'mkt-%@justpressone.com'`);
  await pool.query(`DELETE FROM jpo_players WHERE email LIKE 'mkt-%@justpressone.com'`);
}

const connect = (email, first, character) => {
  const s = io(URL, { transports: ["websocket"], reconnection: false });
  const p = new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
  return { s, ready: p.then(() => s.emit("register", {
    firstName: first, lastName: "Mkt", email, password: "testpass123", character, department: "IT",
  })) };
};

try {
  await cleanup();
  await pool.query(
    `INSERT INTO jpo_players (email, first_name, last_name, name, character, approved, coins, cosmetics, equipped_pet, last_daily_bonus)
     VALUES ($1,'Sella','Mkt','Sella Mkt','adam',true,1000,ARRAY['pet_cat'],'pet_cat',CURRENT_DATE),
            ($2,'Bidda','Mkt','Bidda Mkt','bob', true,5000,ARRAY[]::text[],'',CURRENT_DATE),
            ($3,'Cedric','Mkt','Cedric Mkt','amelia',true,5000,ARRAY[]::text[],'',CURRENT_DATE)`,
    [E_A, E_B, E_C]);
  console.log("seeded", rand);

  const A = connect(E_A, "Sella", "adam"), B = connect(E_B, "Bidda", "bob"), C = connect(E_C, "Cedric", "amelia");
  const aApr = queue(A.s, "approved"), bApr = queue(B.s, "approved"), cApr = queue(C.s, "approved");
  const aOk = queue(A.s, "storeOk"), bOk = queue(B.s, "storeOk"), cOk = queue(C.s, "storeOk");
  const aErr = queue(A.s, "storeError"), bErr = queue(B.s, "storeError");
  const aMkt = queue(A.s, "marketState"), bMkt = queue(B.s, "marketState");
  const bColl = queue(B.s, "collectionUpdate");
  await Promise.all([A.ready, B.ready, C.ready]);
  await aApr.next(15000, "A approved"); await bApr.next(15000, "B approved"); await cApr.next(15000, "C approved");

  // ── list ──
  A.s.emit("storeList", { item: "pet_cat", minBid: 200 });
  ok(/up for bids/.test((await aOk.next(8000, "listed")).message), "listing created");
  await sleep(2100);
  A.s.emit("storeList", { item: "pet_cat", minBid: 300 });
  ok(/already/.test((await aErr.next(8000, "dup list")).message), "double-list rejected");

  B.s.emit("marketOpen", {});
  const snap = await bMkt.next(8000, "B marketState");
  const listing = snap.listings.find((l) => l.sellerName === "Sella Mkt" && l.item === "pet_cat");
  ok(!!listing && listing.minBid === 200 && !listing.mine, "B sees the stall");
  const LID = listing.id;

  // ── bids escrow ──
  B.s.emit("storeBid", { listingId: LID, amount: 100 });
  ok(/start at/.test((await bErr.next(8000, "low bid")).message), "below-min bid rejected");
  await sleep(2100);
  B.s.emit("storeBid", { listingId: LID, amount: 500 });
  ok(/held/.test((await bOk.next(8000, "bid ok")).message), "B bid 500 placed");
  ok(/bid 500/.test((await aOk.next(8000, "seller notified")).message), "seller pinged live");
  ok(await coinsOf(E_B) <= 4500 + 6, "B escrow debited");
  await sleep(2100);
  B.s.emit("storeBid", { listingId: LID, amount: 800 });   // raise = escrow swap
  await bOk.next(8000, "raise ok"); aOk.drain();
  const bAfterRaise = await coinsOf(E_B);
  ok(bAfterRaise >= 4200 - 1 && bAfterRaise <= 4200 + 8, `raise swapped escrow, not stacked (${bAfterRaise})`);
  await sleep(2100);
  C.s.emit("storeBid", { listingId: LID, amount: 600 });
  await cOk.next(8000, "C bid ok");
  ok(await coinsOf(E_C) <= 4400 + 6, "C escrow debited");
  await sleep(2100);
  A.s.emit("storeBid", { listingId: LID, amount: 900 });
  ok(/own store/.test((await aErr.next(8000, "self bid")).message), "own-store bid rejected");

  // ── withdraw + rebid ──
  await sleep(2100);
  B.s.emit("storeWithdraw", { listingId: LID });
  await bOk.next(8000, "withdraw ok");
  ok(await coinsOf(E_B) >= 5000, "B refunded on withdraw");
  await sleep(2100);
  B.s.emit("storeBid", { listingId: LID, amount: 800 });
  await bOk.next(8000, "rebid ok"); aOk.drain();

  // ── C goes offline; seller accepts B — C's refund becomes mail ──
  C.s.disconnect();
  await sleep(500);
  aMkt.drain();
  A.s.emit("marketOpen", {});
  const mySnap = await aMkt.next(8000, "A marketState");
  const mine = mySnap.listings.find((l) => l.id === LID);
  ok(mine.mine && mine.bids.length === 2, "seller sees both bids");
  const winBid = mine.bids.find((b) => b.amount === 800);
  await sleep(2100);
  A.s.emit("storeAccept", { listingId: LID, bidId: winBid.bidId });
  ok(/Sold!/.test((await aOk.next(10000, "sold")).message), "seller: sold toast");
  ok(/You won/.test((await bOk.next(10000, "won")).message), "winner: won toast");
  const coll = await bColl.next(8000, "B collectionUpdate");
  ok(coll.cosmetics.includes("pet_cat"), "winner collection updated live");

  const { rows: dbRows } = await pool.query(`SELECT email, coins, cosmetics FROM jpo_players WHERE email = ANY($1)`, [[E_A, E_B, E_C]]);
  const dA = dbRows.find(r => r.email === E_A), dB = dbRows.find(r => r.email === E_B), dC = dbRows.find(r => r.email === E_C);
  ok(!dA.cosmetics.includes("pet_cat") && dB.cosmetics.includes("pet_cat"), "DB: cat moved A→B");
  ok(dA.coins >= 1800, `DB: seller credited 800 (${dA.coins})`);
  ok(dC.coins >= 5000, `DB: offline loser refunded (${dC.coins})`);
  const { rows: eqRows } = await pool.query(`SELECT equipped_pet FROM jpo_players WHERE email=$1`, [E_A]);
  ok(eqRows[0].equipped_pet === "", "seller's equipped cat un-equipped on sale");
  await sleep(1200);   // loser mail is queued after the sold/won emits
  const { rows: msgRows } = await pool.query(`SELECT message FROM jpo_store_msgs WHERE email=$1`, [E_C]);
  ok(msgRows.length === 1 && /Outbid/.test(msgRows[0].message), "offline loser has mail queued");
  const { rows: leftovers } = await pool.query(`SELECT 1 FROM jpo_store_listings WHERE id=$1`, [LID]);
  ok(leftovers.length === 0, "listing gone after sale");

  // ── unlist refunds ── (B lists the cat back, A bids, B unlists)
  await sleep(2100);
  bOk.drain(); aOk.drain();   // stale "new bid" seller pings from the previous scenario
  B.s.emit("storeList", { item: "pet_cat", minBid: 50 });
  await bOk.next(8000, "B listed");
  bMkt.drain();
  B.s.emit("marketOpen", {});
  const snap2 = await bMkt.next(8000, "B snapshot 2");
  const L2 = snap2.listings.find((l) => l.mine).id;
  await sleep(2100);
  A.s.emit("storeBid", { listingId: L2, amount: 300 });
  await aOk.next(8000, "A bid ok");
  const aPre = await coinsOf(E_A);
  await sleep(2100);
  B.s.emit("storeUnlist", { listingId: L2 });
  await bOk.next(8000, "unlisted");
  ok(/refunded/i.test((await aOk.next(8000, "A refund toast")).message), "bidder told about unlist refund");
  ok(await coinsOf(E_A) >= aPre + 300, "unlist refunded the escrow");

  // ── voided listing: item vanished from seller → accept refunds EVERYONE ──
  // (Simulates an old-build trade sneaking a listed item away; the guards now
  // block that path, but escrow must survive even if something slips through.)
  await sleep(2100);
  bOk.drain(); aOk.drain();   // stale "new bid" seller pings from the previous scenario
  B.s.emit("storeList", { item: "pet_cat", minBid: 50 });
  await bOk.next(8000, "B re-listed");
  bMkt.drain();
  B.s.emit("marketOpen", {});
  const snap3 = await bMkt.next(8000, "B snapshot 3");
  const L3 = snap3.listings.find((l) => l.mine).id;
  await sleep(2100);
  A.s.emit("storeBid", { listingId: L3, amount: 400 });
  await aOk.next(8000, "A bid on doomed listing");
  const aPre2 = await coinsOf(E_A);
  await pool.query(`UPDATE jpo_players SET cosmetics = array_remove(cosmetics, 'pet_cat') WHERE email = $1`, [E_B]);
  bMkt.drain();
  B.s.emit("marketOpen", {});
  const snap4 = await bMkt.next(8000, "B snapshot 4");
  const doomedBid = snap4.listings.find((l) => l.id === L3).bids[0];
  await sleep(2100);
  B.s.emit("storeAccept", { listingId: L3, bidId: doomedBid.bidId });
  const voidMsg = await queue(B.s, "storeError").next(10000, "voided listing error");
  ok(/no longer own/.test(voidMsg.message), "seller told the listing was voided");
  ok(/refunded/i.test((await aOk.next(8000, "A void refund toast")).message), "bidder told about void refund");
  ok(await coinsOf(E_A) >= aPre2 + 400, "voided listing refunded the escrow");
  const { rows: gone3 } = await pool.query(`SELECT 1 FROM jpo_store_listings WHERE id=$1`, [L3]);
  ok(gone3.length === 0, "voided listing removed");

  A.s.disconnect(); B.s.disconnect();
} catch (err) {
  console.error("TEST ERROR:", err);
  fails.push(String(err));
} finally {
  try { await cleanup(); } catch {}
  await pool.end();
}
console.log(fails.length ? `RESULT: FAIL (${fails.length})` : "RESULT: PASS");
process.exit(fails.length ? 1 : 0);
