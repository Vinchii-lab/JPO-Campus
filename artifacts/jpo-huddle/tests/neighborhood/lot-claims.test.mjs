// No app/server launch. Uses a disposable PostgreSQL schema, never player data:
// node --test tests/neighborhood/lot-claims.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { migrateLotClaims, claimNeighborhoodLot } from "../../lot-claims.mjs";
import { homeDirectory, ensureHome, homeAccess, streetDefinition, streetLotForOwner,
  streetPortalForTransition, streetReturnSpawnForOwner, portalForTransition } from "../../neighborhood.mjs";

test("portal refresh follows claimed owner even without stage change and preserves public gates", () => {
  const source = readFileSync(new URL("../../public/neighborhood.js", import.meta.url), "utf8");
  const body = source.match(/updateResidenceDirectory\(entries\) \{([\s\S]*?)\n    \}/)[1];
  const refresh = vm.runInNewContext(`(function(entries) {${body}})`);
  const oldDoor = { residence: true, destination: "home", ownerEmail: "old@example.com", lot: 40 };
  const gate = { destination: "office" };
  const scene = {
    streetLotsVisual: [{ lot: { lot: 40, door: oldDoor }, stage: "complete", color: "teal",
      yardKey: "", sign: { text: "", setText() {} } }],
    info: { portals: [gate, oldDoor] },
    _residenceSignText: () => "",
    _streetYardKey: () => "",
    _syncStreetLotVisibility() {},
  };
  refresh.call(scene, [{ lotIndex: 40, ownerEmail: "new@example.com", construction: { stage: "complete" } }]);
  assert.equal(scene.doors.length, 2);
  assert.equal(scene.doors[0], gate);
  assert.equal(scene.doors[1].ownerEmail, "new@example.com");
  assert.equal(scene.doors[1].lot, 40);
});

test("available signs have no owner name; realtime updates are keyed by permanent lot", () => {
  const source = readFileSync(new URL("../../public/neighborhood.js", import.meta.url), "utf8");
  const body = source.match(/_residenceSignText\(lot\) \{([\s\S]*?)\n    \}/)[1];
  const sign = vm.runInNewContext(`(lot) => {${body}}`);
  assert.match(sign({ lot: 25, ownerEmail: null, name: "Old automatic owner" }), /AVAILABLE\nClaim this lot/);
  assert.doesNotMatch(sign({ lot: 25, ownerEmail: null, name: "Old automatic owner" }), /Old automatic owner/);
  assert.match(source, /homesByLot\.get\(Number\(visual\.lot\.lot\)\)/);
  assert.match(source, /socket\.on\('homeLotClaimResult'/);
});

test("socket claim validates auth, server proximity, activity and input before database mutation", async () => {
  const source = readFileSync(new URL("../../server.js", import.meta.url), "utf8");
  const start = source.indexOf('  socket.on("homeLotClaim",');
  const end = source.indexOf('  socket.on("homeConstructionPurchase",', start);
  let handler, mutationCount = 0, busy = false, location = "neighborhood";
  const replies = [];
  const p = { email: "resident", x: 100, y: 100 };
  const players = { session: p };
  vm.runInNewContext(source.slice(start, end), {
    socket: { id: "session", on: (_event, fn) => { handler = fn; }, emit: (event, data) => replies.push({ event, data }) },
    players, isHuddleTestIdentity: () => false, takeToken: () => true, buyBucket: {},
    inAnyMatch: () => busy, inActiveRound: () => false,
    locationOf: () => location, refreshStreetHomes: async () => {},
    streetWorld: { lots: [{ lot: 12, returnSpawn: { x: 100, y: 100 } }] },
    claimNeighborhoodLot: async () => { mutationCount++; return { ok: true }; },
    pool: {}, invalidateStreetHomes: () => {}, locationRoom: value => value,
    homeSnapshot: async () => ({}), io: { to: () => ({ emit: () => {} }) }, console,
  });
  const result = async (payload) => {
    replies.length = 0;
    await handler(payload);
    return replies.find(reply => reply.event === "homeLotClaimResult").data;
  };
  delete players.session;
  assert.equal((await result({ lotIndex: 12 })).code, "unauthorized");
  players.session = p;
  assert.equal((await result({ lotIndex: "12" })).code, "invalid");
  assert.equal((await result({ lotIndex: -1 })).code, "invalid");
  busy = true;
  assert.equal((await result({ lotIndex: 12 })).code, "busy");
  busy = false;
  location = "office";
  assert.equal((await result({ lotIndex: 12 })).code, "distance");
  location = "neighborhood";
  p.x = 1000;
  assert.equal((await result({ lotIndex: 12, x: 100, y: 100 })).code, "distance",
    "client-provided coordinates cannot bypass proximity");
  p.x = NaN;
  assert.equal((await result({ lotIndex: 12 })).code, "distance");
  p.x = 100;
  assert.equal((await result({ lotIndex: 9999 })).code, "distance");
  assert.equal(mutationCount, 0);
  assert.equal((await result({ lotIndex: 12 })).ok, true);
  assert.equal(mutationCount, 1);
});

test("persistent atomic claims, idempotent migration and non-destructive release", {
  skip: !process.env.DATABASE_URL && "DATABASE_URL is required for isolated PostgreSQL integration",
}, async () => {
  const schema = `lot_claim_test_${Date.now()}_${process.pid}`;
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  let pool;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}`, max: 8 });
    await pool.query(`
      CREATE TABLE jpo_players (email text PRIMARY KEY, approved boolean DEFAULT true, nickname text, first_name text, name text);
      CREATE TABLE jpo_homes (
        owner_email text PRIMARY KEY REFERENCES jpo_players(email),
        lot_index integer GENERATED BY DEFAULT AS IDENTITY UNIQUE,
        access_mode text DEFAULT 'public', layout_revision integer DEFAULT 0,
        exterior_color text DEFAULT 'teal', floor_built boolean DEFAULT false,
        walls_built boolean DEFAULT false, roof_built boolean DEFAULT false,
        construction_updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE jpo_home_furniture (
        id text PRIMARY KEY, owner_email text REFERENCES jpo_homes(owner_email),
        furniture_id text, acquired_at timestamptz DEFAULT now()
      );
      CREATE TABLE jpo_home_layout_items (
        furniture_instance_id text PRIMARY KEY REFERENCES jpo_home_furniture(id),
        home_owner_email text REFERENCES jpo_homes(owner_email),
        grid_x integer, grid_y integer, rotation integer, placement_zone text
      );
      INSERT INTO jpo_players (email) VALUES ('empty'),('partial'),('built'),('placed'),('alice@example.com'),('bob@example.com'),('charlie'),('dana');
      INSERT INTO jpo_homes (owner_email,lot_index,floor_built,walls_built,roof_built) VALUES
        ('empty', 40, false,false,false), ('partial', 71,true,false,false),
        ('built', 900,true,true,true), ('placed', 901,false,false,false);
      INSERT INTO jpo_home_furniture (id,owner_email,furniture_id) VALUES
        ('stored','empty','saved-item'), ('placed-item','placed','saved-item');
      INSERT INTO jpo_home_layout_items VALUES ('placed-item','placed',3,5,0,'yard');
    `);
    const retained = (await pool.query("SELECT * FROM jpo_homes ORDER BY owner_email")).rows;
    const inventory = (await pool.query("SELECT * FROM jpo_home_furniture ORDER BY id")).rows;
    const placements = (await pool.query("SELECT * FROM jpo_home_layout_items")).rows;
    await migrateLotClaims(pool);
    const migrated = (await pool.query("SELECT * FROM jpo_neighborhood_lots ORDER BY display_index")).rows;
    assert.equal(migrated.length, 160);
    assert.equal(migrated[0].owner_email, null, "automatic empty assignment released");
    assert.equal(migrated[1].owner_email, "partial");
    assert.equal(migrated[2].owner_email, "built");
    assert.equal(migrated[3].owner_email, "placed", "physical yard progress retained");
    assert.deepEqual((await pool.query("SELECT * FROM jpo_homes ORDER BY owner_email")).rows, retained);
    assert.deepEqual((await pool.query("SELECT * FROM jpo_home_furniture ORDER BY id")).rows, inventory);
    assert.deepEqual((await pool.query("SELECT * FROM jpo_home_layout_items")).rows, placements);
    const before = await homeDirectory(pool);
    await ensureHome(pool, "charlie");
    await homeDirectory(pool);
    assert.equal((await pool.query("SELECT 1 FROM jpo_neighborhood_lots WHERE owner_email='charlie'")).rowCount, 0);
    assert.equal((await pool.query("SELECT 1 FROM jpo_homes WHERE owner_email='dana'")).rowCount, 0,
      "directory reads never materialize every account");
    const results = await Promise.all([
      claimNeighborhoodLot(pool, "alice@example.com", 40), claimNeighborhoodLot(pool, "bob@example.com", 40),
    ]);
    assert.equal(results.filter(r => r.ok).length, 1, "exactly one simultaneous claimant wins");
    assert.equal(results.find(r => !r.ok).code, "claimed");
    const winner = results[0].ok ? "alice@example.com" : "bob@example.com";
    assert.equal((await claimNeighborhoodLot(pool, winner, 40)).alreadyClaimed, true);
    // A claimed address must never be resolved through the possessions
    // ledger's unrelated, auto-generated legacy lot_index.
    const ledger = await ensureHome(pool, winner);
    assert.notEqual(Number(ledger.lot_index), 40);
    await pool.query("UPDATE jpo_homes SET floor_built=true,walls_built=true,roof_built=true WHERE owner_email=$1", [winner]);
    const ownedStreet = (await homeDirectory(pool)).homes;
    const ownedLot = streetLotForOwner(ownedStreet, winner);
    assert.equal(ownedLot.lot, 40);
    assert.equal((await homeAccess(pool, winner, winner)).ok, true);
    const entry = streetPortalForTransition(`home:${winner}`, ownedLot.door.x + 36,
      ownedLot.door.y + 50, ownedStreet);
    assert.equal(entry.ownerEmail, winner);
    const exit = portalForTransition(`home:${winner}`, "neighborhood", 576, 816, winner);
    assert.ok(exit, "home exit remains a physical portal");
    assert.deepEqual(streetReturnSpawnForOwner(ownedStreet, winner), ownedLot.returnSpawn);
    const twoLots = await Promise.all([
      claimNeighborhoodLot(pool, "charlie", migrated[4].lot_index),
      claimNeighborhoodLot(pool, "charlie", migrated[5].lot_index),
    ]);
    assert.equal(twoLots.filter(r => r.ok).length, 1, "one owner cannot claim two lots concurrently");
    assert.equal(twoLots.find(r => !r.ok).code, "already_owned");
    const after = await homeDirectory(pool);
    const geometry = (directory) => streetDefinition(directory.homes).lots.map(lot =>
      [lot.lot, lot.x, lot.bottom, lot.returnSpawn.x, lot.returnSpawn.y]);
    assert.deepEqual(geometry(before), geometry(after), "claims never move any lot");
    const claimed = (await pool.query("SELECT * FROM jpo_neighborhood_lots ORDER BY display_index")).rows;
    await migrateLotClaims(pool);
    assert.deepEqual((await pool.query("SELECT * FROM jpo_neighborhood_lots ORDER BY display_index")).rows, claimed,
      "restart migration never releases an explicitly claimed empty lot");
    // New pool represents a process reconnect: claims are not held in memory.
    const reopened = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
    try {
      assert.equal((await homeDirectory(reopened)).homes.find(lot => lot.lotIndex === 40).ownerEmail, winner);
    } finally { await reopened.end(); }
    await pool.query("UPDATE jpo_neighborhood_lots SET owner_email=NULL WHERE owner_email='charlie'");
    await pool.query("DELETE FROM jpo_neighborhood_lots WHERE owner_email IS NULL");
    assert.equal((await claimNeighborhoodLot(pool, "dana", 40)).code, "sold_out");
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});