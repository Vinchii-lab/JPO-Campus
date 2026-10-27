// Development-only integration test: isolated identity, real transactions,
// parallel duplicate requests, cleanup in finally. Never run against production.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { registerChristmas, migrateChristmas, christmasGate } from "../christmas.mjs";
import { canIssueItem } from "../season.mjs";

const locations = {
  pickup: { x: 2592, y: 2904, label: "parcels" },
  destination: { x: 7440, y: 4392, label: "classroom" },
  tree: { x: 4560, y: 2568, label: "tree" },
};
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const email = `qa-christmas-${randomUUID()}@example.test`;
const player = { email, locationId: "office", ...locations.pickup, coins: 0 };
let now = new Date("2026-12-01T12:00:00Z");
let busy = false;
const broadcast = [];
function client() {
  const handlers = {}, messages = [];
  registerChristmas({
    socket: { on: (name, fn) => { handlers[name] = fn; }, emit: (name, data) => messages.push({ name, data }) },
    pool, io: { emit: name => broadcast.push(name) }, getPlayer: () => player,
    locations, clock: () => now, isBusy: () => busy,
  });
  return { handlers, messages };
}
try {
  await migrateChristmas(pool);
  await pool.query("INSERT INTO jpo_players(email,name,approved,coins) VALUES($1,'Christmas QA',true,0)", [email]);
  assert(christmasGate(player, "daily", locations, new Date("2026-10-20")));
  for (const id of ["santahat", "reindeerantlers", "christmasscarf", "christmassweater", "elfoutfit", "snowflakewings", "pet_reindeer"]) {
    assert(canIssueItem(id, now));
    assert(!canIssueItem(id, new Date("2026-12-27T00:00:00Z")));
  }
  const a = client(), b = client();
  await Promise.all([a.handlers.christmasClaimDaily(), b.handlers.christmasClaimDaily()]);
  let coins = (await pool.query("SELECT coins FROM jpo_players WHERE email=$1", [email])).rows[0].coins;
  assert.equal(coins, 100, "concurrent duplicate gift awards once");
  assert(b.messages.concat(a.messages).some(m => m.name === "christmasError"));
  await a.handlers.christmasDeliver();
  assert.equal((await pool.query("SELECT coins FROM jpo_players WHERE email=$1", [email])).rows[0].coins, 100);
  busy = true;
  await a.handlers.christmasPickup();
  assert.equal((await pool.query("SELECT delivery_stage FROM jpo_christmas_days WHERE email=$1", [email])).rows[0].delivery_stage, "ready");
  busy = false;
  await a.handlers.christmasPickup();
  // A different socket resumes the durable carrying state.
  const c = client();
  await c.handlers.christmasRequest();
  assert.equal(c.messages.at(-1).data.delivery.stage, "carrying");
  await a.handlers.christmasDeliver(); // still at wrong station
  assert.equal(player.coins, 100);
  Object.assign(player, locations.destination);
  await Promise.all([a.handlers.christmasDeliver(), b.handlers.christmasDeliver()]);
  assert.equal((await pool.query("SELECT coins FROM jpo_players WHERE email=$1", [email])).rows[0].coins, 250);
  Object.assign(player, locations.tree);
  await Promise.all([a.handlers.christmasContribute(), b.handlers.christmasContribute()]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM jpo_christmas_days WHERE email=$1 AND contributed", [email])).rows[0].n, 1);
  assert.equal(broadcast.length, 1);
  now = new Date("2026-12-02T00:00:01Z");
  await a.handlers.christmasClaimDaily();
  assert.equal((await pool.query("SELECT coins FROM jpo_players WHERE email=$1", [email])).rows[0].coins, 350);
  player.locationId = "city";
  await a.handlers.christmasPickup();
  assert(a.messages.at(-1).data.message.includes("HQ"));
  now = new Date("2026-12-27T00:00:00Z");
  await a.handlers.christmasClaimDaily();
  assert.equal((await pool.query("SELECT coins FROM jpo_players WHERE email=$1", [email])).rows[0].coins, 350);
  console.log("PASS: real transactional Christmas claims, concurrent duplicates, delivery order/proximity, reconnect, busy/map gates, UTC reset and season expiry");
} finally {
  await pool.query("DELETE FROM jpo_christmas_days WHERE email=$1", [email]);
  await pool.query("DELETE FROM jpo_players WHERE email=$1", [email]);
  await pool.end();
}
