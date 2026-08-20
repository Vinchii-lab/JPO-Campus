// Direct item gifting: every non-rare catalog category, atomic ownership move,
// equipped-slot cleanup, recipient equipment preservation, pet history transfer,
// duplicate/rare rejection, and replay safety.
// Run: node tests/economy/item-gifting.mjs (needs DATABASE_URL)
import { io } from "socket.io-client";
import { spawn } from "child_process";
import { createRequire } from "module";

const require = createRequire("/home/runner/workspace/artifacts/jpo-huddle/server.js");
const pg = require("pg");
const PORT = process.env.TEST_ITEM_GIFT_PORT || "20982";
const URL = `http://localhost:${PORT}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const rand = Math.random().toString(36).slice(2, 8);
const E_A = `itemgift-a-${rand}@justpressone.com`;
const E_B = `itemgift-b-${rand}@justpressone.com`;
const fails = [];
const ok = (cond, label) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + label);
  if (!cond) fails.push(label);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function queue(socket, event) {
  const q = { items: [], waiters: [] };
  socket.on(event, (data) => {
    const waiter = q.waiters.shift();
    if (waiter) waiter(data);
    else q.items.push(data);
  });
  q.next = (timeoutMs = 15000, label = event) => new Promise((resolve, reject) => {
    if (q.items.length) return resolve(q.items.shift());
    const waiter = (data) => { clearTimeout(timer); resolve(data); };
    const timer = setTimeout(() => {
      const i = q.waiters.indexOf(waiter);
      if (i >= 0) q.waiters.splice(i, 1);
      reject(new Error(`timeout waiting for ${label}`));
    }, timeoutMs);
    q.waiters.push(waiter);
  });
  return q;
}

const cleanup = async () => {
  await pool.query(`DELETE FROM jpo_store_listings WHERE seller_email LIKE 'itemgift-%@justpressone.com'`);
  await pool.query(`DELETE FROM jpo_players WHERE email LIKE 'itemgift-%@justpressone.com'`);
};
const connect = (email, first, character) => {
  const socket = io(URL, { transports: ["websocket"], reconnection: false });
  const ready = new Promise((resolve, reject) => {
    socket.on("connect", resolve);
    socket.on("connect_error", reject);
  }).then(() => socket.emit("register", {
    firstName: first, lastName: "GiftTest", email, password: "testpass123",
    character, department: "IT",
  }));
  return { socket, ready };
};

const server = spawn("node", ["server.js"], {
  cwd: "/home/runner/workspace/artifacts/jpo-huddle",
  env: { ...process.env, PORT },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (data) => process.stderr.write(`[srv] ${data}`));
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("server didn't boot")), 20000);
  server.stdout.on("data", (data) => {
    if (String(data).includes("running on port")) {
      clearTimeout(timer);
      resolve();
    }
  });
});

try {
  await cleanup();
  await pool.query(
    `INSERT INTO jpo_players (
       email, first_name, last_name, name, character, approved, coins, cosmetics,
       equipped_cosmetic, equipped_wings, equipped_top, equipped_pet, equipped_pet_acc,
       pet_xp, pet_names, pet_builds, last_daily_bonus
     ) VALUES (
       $1, 'Alpha', 'GiftTest', 'Alpha GiftTest', 'adam', true, 1000,
       ARRAY['beanie','fairywings','raincoat','petacc_bow','pet_dog','book','camera','crown','phoenixwings','pet_unicorn'],
       'beanie', 'fairywings', 'raincoat', 'pet_dog', 'petacc_bow',
       $3::jsonb, $4::jsonb, $5::jsonb, CURRENT_DATE
     ), (
       $2, 'Beta', 'GiftTest', 'Beta GiftTest', 'bob', true, 1000,
       ARRAY['cap','crown','pet_cat','petacc_bell'],
       'cap', '', '', 'pet_cat', 'petacc_bell',
       '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_DATE
     )`,
    [
      E_A, E_B,
      JSON.stringify({ pet_dog: 47 }),
      JSON.stringify({ pet_dog: "Scout" }),
      JSON.stringify({ pet_dog: { power: 3, vitality: 2, speed: 1, critical: 0, focus: 2 } }),
    ],
  );

  const A = connect(E_A, "Alpha", "adam");
  const B = connect(E_B, "Beta", "bob");
  const aApproved = queue(A.socket, "approved");
  const bApproved = queue(B.socket, "approved");
  const inventory = queue(A.socket, "itemGiftInventory");
  const results = queue(A.socket, "itemGiftResult");
  const aStates = queue(A.socket, "itemGiftState");
  const bStates = queue(B.socket, "itemGiftState");
  const received = queue(B.socket, "itemGiftReceived");
  let requestSeq = 0;
  await Promise.all([A.ready, B.ready]);
  await aApproved.next(15000, "A approved");
  await bApproved.next(15000, "B approved");
  const bId = B.socket.id;

  console.log("― inventory");
  A.socket.emit("itemGiftInventory", { targetId: bId, requestId: ++requestSeq });
  const inv = await inventory.next(8000);
  const giftRows = new Map(inv.items.map((row) => [row.id, row]));
  ok(["beanie", "fairywings", "raincoat", "petacc_bow", "pet_dog", "book"].every((id) => giftRows.has(id)), "all non-rare item categories are listed");
  ok(!giftRows.has("phoenixwings") && !giftRows.has("pet_unicorn"), "owner-only rare items are absent");
  ok(/already owns/i.test(giftRows.get("crown")?.unavailable || ""), "recipient duplicate is marked unavailable");

  async function gift(item, label) {
    const requestId = ++requestSeq;
    A.socket.emit("sendItemGift", { targetId: bId, requestId, item });
    const [result, aState, bState, receipt] = await Promise.all([
      results.next(10000, `${label} result`),
      aStates.next(10000, `${label} sender state`),
      bStates.next(10000, `${label} recipient state`),
      received.next(10000, `${label} receipt`),
    ]);
    ok(result.ok === true && result.item === item && result.requestId === requestId, `${label}: sender sees correlated success`);
    ok(receipt.item === item && /Alpha/.test(receipt.message), `${label}: recipient sees exact gift`);
    ok(!aState.cosmetics.includes(item) && bState.cosmetics.includes(item), `${label}: live collections moved once`);
    return { aState, bState };
  }

  console.log("― validation and replay");
  let states = await gift("beanie", "legacy wearable");
  ok(states.aState.equipped === "", "gifted worn legacy item is unequipped");
  ok(states.bState.equipped === "cap", "recipient legacy equipment is preserved");

  A.socket.emit("sendItemGift", { targetId: bId, requestId: ++requestSeq, item: "beanie" });
  const replayFast = await results.next(8000, "fast replay result");
  ok(replayFast.ok === false, "immediate replay is rejected");

  await sleep(2100);
  A.socket.emit("sendItemGift", { targetId: bId, requestId: ++requestSeq, item: "crown" });
  const duplicate = await results.next(8000, "duplicate result");
  ok(duplicate.ok === false && /already owns/i.test(duplicate.message), "recipient duplicate is rejected authoritatively");

  await sleep(2100);
  A.socket.emit("sendItemGift", { targetId: bId, requestId: ++requestSeq, item: "phoenixwings" });
  const rare = await results.next(8000, "rare result");
  ok(rare.ok === false && /rare/i.test(rare.message), "owner-only rare wearable is rejected");

  console.log("― each equipment category");
  await sleep(2100);
  states = await gift("fairywings", "wings");
  ok(states.aState.wings === "" && states.bState.wings === "", "gifted wings clear sender and do not auto-equip recipient");

  await sleep(2100);
  states = await gift("raincoat", "outfit slot");
  ok(states.aState.slots.top === "" && states.bState.slots.top === "", "gifted outfit piece clears only sender slot");

  await sleep(2100);
  states = await gift("petacc_bow", "pet accessory");
  ok(states.aState.petAcc === "" && states.bState.petAcc === "petacc_bell", "gifted pet accessory preserves recipient accessory");

  await sleep(2100);
  states = await gift("pet_dog", "pet");
  ok(states.aState.pet === "" && states.bState.pet === "pet_cat", "gifted active pet goes home while recipient keeps current pet");
  ok(states.bState.petXp.pet_dog === 47 && states.bState.petNames.pet_dog === "Scout", "pet XP and name arrive live");

  console.log("― concurrent replay");
  await sleep(2100);
  A.socket.emit("sendItemGift", { targetId: bId, requestId: ++requestSeq, item: "book" });
  A.socket.emit("sendItemGift", { targetId: bId, requestId: ++requestSeq, item: "book" });
  const pair = await Promise.all([
    results.next(10000, "concurrent result 1"),
    results.next(10000, "concurrent result 2"),
  ]);
  ok(pair.filter((row) => row.ok).length === 1, "two concurrent sends produce exactly one success");
  await Promise.all([
    aStates.next(10000, "concurrent sender state"),
    bStates.next(10000, "concurrent recipient state"),
    received.next(10000, "concurrent receipt"),
  ]);

  console.log("― concurrent listing versus gift");
  await sleep(2100);
  const storeOutcome = new Promise((resolve) => {
    let done = false;
    const finish = (okValue, data) => {
      if (done) return;
      done = true;
      A.socket.off("storeOk", onOk);
      A.socket.off("storeError", onError);
      resolve({ ok: okValue, data });
    };
    const onOk = (data) => finish(true, data);
    const onError = (data) => finish(false, data);
    A.socket.on("storeOk", onOk);
    A.socket.on("storeError", onError);
  });
  A.socket.emit("storeList", { item: "camera", minBid: 10 });
  A.socket.emit("sendItemGift", { targetId: bId, requestId: ++requestSeq, item: "camera" });
  const [listedOrRejected, giftedOrRejected] = await Promise.all([
    Promise.race([storeOutcome, sleep(10000).then(() => { throw new Error("timeout waiting for storeList"); })]),
    results.next(10000, "list-vs-gift result"),
  ]);
  ok(Number(listedOrRejected.ok) + Number(giftedOrRejected.ok) === 1, "concurrent list and gift produce exactly one winner");
  if (giftedOrRejected.ok) {
    await Promise.all([
      aStates.next(10000, "list-race sender state"),
      bStates.next(10000, "list-race recipient state"),
      received.next(10000, "list-race receipt"),
    ]);
  }

  const { rows } = await pool.query(
    `SELECT email, cosmetics, equipped_cosmetic, equipped_wings, equipped_top,
            equipped_pet, equipped_pet_acc, pet_xp, pet_names, pet_builds
       FROM jpo_players WHERE email = ANY($1)`,
    [[E_A, E_B]],
  );
  const dbA = rows.find((row) => row.email === E_A);
  const dbB = rows.find((row) => row.email === E_B);
  const { rows: cameraListings } = await pool.query(
    `SELECT item_id FROM jpo_store_listings WHERE seller_email = $1 AND item_id = 'camera'`,
    [E_A],
  );
  const moved = ["beanie", "fairywings", "raincoat", "petacc_bow", "pet_dog", "book"];
  ok(moved.every((id) => !dbA.cosmetics.includes(id) && dbB.cosmetics.includes(id)), "database owns every successful gift exactly once");
  ok(dbA.cosmetics.includes("crown") && dbB.cosmetics.includes("crown"), "failed duplicate gift changes neither owner");
  ok(dbA.cosmetics.includes("phoenixwings") && dbA.cosmetics.includes("pet_unicorn"), "rare items remain with sender");
  ok(dbA.equipped_cosmetic === "" && dbA.equipped_wings === "" && dbA.equipped_top === "" && dbA.equipped_pet === "" && dbA.equipped_pet_acc === "", "all affected sender equipment is cleared");
  ok(dbB.equipped_cosmetic === "cap" && dbB.equipped_pet === "pet_cat" && dbB.equipped_pet_acc === "petacc_bell", "recipient equipment remains unchanged in database");
  ok(dbB.pet_xp.pet_dog === 47 && dbB.pet_names.pet_dog === "Scout" && dbB.pet_builds.pet_dog.power === 3, "pet XP, name, and committed build moved together");
  ok(dbA.pet_xp.pet_dog == null && dbA.pet_names.pet_dog == null && dbA.pet_builds.pet_dog == null, "sender pet metadata is removed");
  ok(
    (cameraListings.length === 1 && dbA.cosmetics.includes("camera") && !dbB.cosmetics.includes("camera"))
      || (cameraListings.length === 0 && !dbA.cosmetics.includes("camera") && dbB.cosmetics.includes("camera")),
    "listing exclusivity matches durable camera ownership",
  );

  console.log("― reconnect durability");
  B.socket.disconnect();
  await sleep(300);
  const B2 = connect(E_B, "Beta", "bob");
  const b2Approved = queue(B2.socket, "approved");
  await B2.ready;
  const restored = await b2Approved.next(15000, "recipient reconnect approved");
  ok(moved.every((id) => restored.cosmetics.includes(id)), "recipient retains all gifts after reconnect");
  ok(restored.equipped === "cap" && restored.pet === "pet_cat" && restored.petAcc === "petacc_bell", "recipient equipment is still preserved after reconnect");
  ok(restored.petXp.pet_dog === 47 && restored.petNames.pet_dog === "Scout", "gifted pet progress and name survive reconnect");
  B2.socket.disconnect();

  A.socket.disconnect();
} catch (err) {
  console.error("TEST ERROR:", err);
  fails.push(String(err));
} finally {
  await cleanup().catch(() => {});
  server.kill();
  await pool.end();
}

console.log(fails.length ? `RESULT: FAIL (${fails.length})` : "RESULT: PASS");
process.exit(fails.length ? 1 : 0);