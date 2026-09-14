// Cheap, dependency-free contracts for Willow Walk's shared portal and
// retained-test-account behavior.  Renderer layering is checked from source
// because Phaser is intentionally not loaded in this unit test.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTOR_FOOT_RADIUS,
  LOCATION_GEOMETRY,
  LOCATION_PORTALS,
  LOCATIONS,
  isHuddleTestIdentity,
  homeAccess,
  locationSpawn,
  parseLocation,
  pointHitsRect,
  portalForTransition,
  streetDefinition,
  streetCityPortalForTransition,
  streetLotForOwner,
  staticSeatStandCandidates,
  validStreetWorldMove,
  validLocationMove,
} from "../../neighborhood.mjs";

const officeLink = LOCATION_PORTALS.neighborhood.find((portal) => portal.destination === "office");
const hqWillowGate = LOCATION_PORTALS.office.find((portal) => portal.destination === "neighborhood");
assert.deepEqual(
  { x: officeLink.x, y: officeLink.y, width: officeLink.width, height: officeLink.height },
  { x: 0, y: 432, width: 96, height: 144 },
  "HQ return portal must sit at the west end of the main horizontal road",
);
assert.deepEqual(LOCATIONS.neighborhood.spawn, { x: 144, y: 504, dir: "right" });
assert.equal(portalForTransition("neighborhood", "office", 48, 504), officeLink);
assert.equal(locationSpawn(parseLocation("neighborhood"), "office").x, 144);
assert.equal(locationSpawn(parseLocation("neighborhood"), "office").y, 504);
assert(pointHitsRect(48, 504, officeLink, ACTOR_FOOT_RADIUS), "HQ trigger must be foot-safe");
assert(validStreetWorldMove(streetDefinition([]), 144, 504), "west-end arrival must be walkable");
assert(validStreetWorldMove(streetDefinition([]), 48, 504), "west-end portal floor must be walkable");
assert.deepEqual(
  { x: hqWillowGate.x, y: hqWillowGate.y, width: hqWillowGate.width, height: hqWillowGate.height },
  { x: 192, y: 2208, width: 96, height: 144 },
  "HQ Willow Walk gate must stay in the highlighted garden clearing",
);
const populatedStreet = streetDefinition([
  { ownerEmail: "resident@example.com", lotIndex: 1, construction: { wallsBuilt: true, complete: true } },
]);
assert(!populatedStreet.blockers.some((block) =>
  block.x < officeLink.x + officeLink.width && block.x + block.width > officeLink.x &&
  block.y < officeLink.y + officeLink.height && block.y + block.height > officeLink.y),
  "west-end HQ portal must not overlap a residence facade",
);

// Every sparse lot slot must return to the street-facing side of its own
// facade. In particular, south-lane return points must not land in the wide
// residence blocker (the old bottom - 122 formula did exactly that).
const sparseHomes = Array.from({ length: 8 }, (_, index) => ({
  ownerEmail: `resident-${index + 1}@example.com`,
  lotIndex: index + 1,
  construction: { wallsBuilt: true, complete: true },
}));
const sparseStreet = streetDefinition(sparseHomes);
for (const lot of sparseStreet.lots) {
  const expectedY = lot.northSide ? lot.bottom + 32 : lot.bottom - 266;
  assert.equal(lot.returnSpawn.y, expectedY, `lot ${lot.lot} return side`);
  assert(validStreetWorldMove(sparseStreet, lot.returnSpawn.x, lot.returnSpawn.y),
    `lot ${lot.lot} return point must be walkable`);
  assert(!sparseStreet.blockers.some((block) => pointHitsRect(
    lot.returnSpawn.x, lot.returnSpawn.y, block,
  )), `lot ${lot.lot} return point must clear its facade`);
}

// Dense accounts use a compact landscape grid, while sparse durable addresses
// still retain their original lot identity and owner. The display slot is the
// only value allowed to choose a visible position.
const denseHomes = Array.from({ length: 132 }, (_, index) => ({
  ownerEmail: `dense-${index + 1}@example.com`,
  lotIndex: index + 1,
  construction: { wallsBuilt: true, complete: true },
}));
const denseStreet = streetDefinition(denseHomes);
assert.equal(denseStreet.occupiedBlockCount, 17);
assert.equal(denseStreet.columns, 4);
assert.equal(denseStreet.rows, 5);
assert.equal(denseStreet.blocks.length, 20, "tail blocks complete the rectangular grid");
assert.deepEqual(
  denseStreet.blocks[19],
  { index: 19, row: 4, column: 3, x: 4320, y: 3840, width: 1440, height: 960 },
);
assert.deepEqual(denseStreet.bounds, { width: 5760, height: 4896 });
assert.equal(denseStreet.lots[131].displayIndex, 132);
assert.equal(denseStreet.lots[131].row, 4);
assert.equal(denseStreet.lots[131].column, 0);
for (const block of denseStreet.blocks) {
  const intersection = { x: block.x + 576, y: block.y + 504 };
  assert(validStreetWorldMove(denseStreet, intersection.x, intersection.y),
    `block ${block.index} road intersection remains walkable`);
}
for (let row = 0; row < denseStreet.rows; row++) {
  const y = row * 960 + 504;
  for (let x = 48; x < denseStreet.bounds.width; x += 48)
    assert(validStreetWorldMove(denseStreet, x, y), `row ${row} horizontal road remains connected`);
}
for (let column = 0; column < denseStreet.columns; column++) {
  const x = column * 1440 + 576;
  for (let y = 48; y < denseStreet.rows * 960; y += 48)
    assert(validStreetWorldMove(denseStreet, x, y), `column ${column} vertical road remains connected`);
}
for (const lot of denseStreet.lots) {
  assert(validStreetWorldMove(denseStreet, lot.returnSpawn.x, lot.returnSpawn.y),
    `dense lot ${lot.lot} return spawn remains walkable`);
  assert(!denseStreet.blockers.some((block) =>
    pointHitsRect(lot.returnSpawn.x, lot.returnSpawn.y, block)),
  `dense lot ${lot.lot} return spawn clears its house`);
}
assert.equal(denseStreet.roadPortals.length, 5, "one east gate per row");
assert(denseStreet.roadPortals.every((portal) =>
  portal.x === denseStreet.bounds.width - 96 &&
  portal.x + portal.width === denseStreet.bounds.width &&
  portal.y === portal.row * 960 + 432),
"city gates use only the east outer edge");
for (const portal of denseStreet.roadPortals) {
  const returned = streetCityPortalForTransition(
    48, 504, denseHomes, { segment: portal.row, roadY: portal.y, returnPoint: portal.returnPoint },
  );
  assert.equal(returned.segment, portal.row);
  assert(validStreetWorldMove(denseStreet, returned.spawn.x, returned.spawn.y),
    `city return row ${portal.row} is current and walkable`);
}
const staleCityReturn = streetCityPortalForTransition(
  48, 504, denseHomes, { segment: 99, roadY: 99_999, returnPoint: { x: -1, y: -1 } },
);
assert.equal(staleCityReturn.segment, 0, "stale city metadata resolves to a current gate row");
assert(validStreetWorldMove(denseStreet, staleCityReturn.spawn.x, staleCityReturn.spawn.y));

const sparseIds = [
  { ownerEmail: "sparse-first@example.com", lotIndex: 3, name: "First" },
  { ownerEmail: "sparse-middle@example.com", lotIndex: 900, name: "Middle" },
  { ownerEmail: "sparse-last@example.com", lotIndex: 90_000, name: "Last" },
];
const sparseGrid = streetDefinition(sparseIds);
assert.deepEqual(sparseGrid.lots.map((lot) => [lot.lot, lot.displayIndex, lot.ownerEmail]), [
  [3, 1, "sparse-first@example.com"],
  [900, 2, "sparse-middle@example.com"],
  [90_000, 3, "sparse-last@example.com"],
]);
assert(sparseGrid.lots.every((lot) => lot.row === 0 && lot.column === 0),
  "sparse permanent ids do not create positional holes");
assert.deepEqual(sparseGrid.bounds, { width: 1440, height: 1056 });

// Public benches publish more than one authored exit. Validate each candidate
// against the same actor-radius geometry and sample the complete seat->stand
// path so an apparently clear endpoint cannot cross a city obstacle.
const city = parseLocation("city");
for (const seat of LOCATION_GEOMETRY.city.seats || []) {
  assert(seat.id && seat.stands?.length >= 2, `bench ${seat.id || "unnamed"} needs authored exits`);
  const stands = staticSeatStandCandidates(city, seat);
  assert.equal(stands.length, seat.stands.length, `bench ${seat.id} exits must remain valid`);
  for (const stand of stands) {
    assert(validLocationMove(city, stand.x, stand.y), `bench ${seat.id} stand is walkable`);
    for (let step = 0; step <= 8; step++) {
      const t = step / 8;
      const x = seat.x + (stand.x - seat.x) * t;
      const y = seat.y + (stand.y - seat.y) * t;
      assert(validLocationMove(city, x, y), `bench ${seat.id} path is collision-free`);
    }
  }
}

assert(isHuddleTestIdentity("huddle-a-qwc0xff@justpressone.com"));
assert(isHuddleTestIdentity("HUDDLE-B-7f3a9c1@justpressone.com"));
assert(!isHuddleTestIdentity("huddle-team@justpressone.com"));
assert(!isHuddleTestIdentity("huddle-a-qwc0xff@example.com"));
assert(!isHuddleTestIdentity("HuddleA Tester <huddle-a-qwc0xff@justpressone.com>"));

const retained = [
  { ownerEmail: "huddle-a-qwc0xff@justpressone.com", lotIndex: 1, name: "HuddleA Tester" },
  { ownerEmail: "vince@example.com", lotIndex: 2, name: "Vince" },
  { ownerEmail: "huddle-b-7f3a9c1@justpressone.com", lotIndex: 3, name: "HuddleB Tester" },
];
const street = streetDefinition(retained);
assert.deepEqual(street.lots.map((lot) => lot.ownerEmail), ["vince@example.com"]);
assert.equal(streetLotForOwner(retained, "huddle-a-qwc0xff@justpressone.com"), null);
assert.equal(street.doors.length, 0, "retained test homes must not expose a door");

const here = path.dirname(fileURLToPath(import.meta.url));
const publicHomePool = { query: async () => ({ rows: [{
  owner_email: 'resident@example.com', access_mode: 'public', roof_built: true,
}] }) };
assert.equal((await homeAccess(publicHomePool, 'resident@example.com', 'huddle-a@justpressone.com')).ok, true,
  'test accounts may visit public homes without owning one');
assert.equal((await homeAccess(publicHomePool, 'huddle-a@justpressone.com', 'resident@example.com')).ok, false,
  'test-owned homes remain unavailable');
const clientSource = fs.readFileSync(path.join(here, "../../public/neighborhood.js"), "utf8");
const hqMap = JSON.parse(fs.readFileSync(path.join(here, "../../public/assets/JPO_HQ.tmj"), "utf8"));
const hqFloor = hqMap.layers.find((layer) => layer.name === "Floor")?.data || [];
const hqWall = hqMap.layers.find((layer) => layer.name === "Wall")?.data || [];
const hqFurniture = hqMap.layers.find((layer) => layer.name === "Furniture")?.data || [];
for (let row = 46; row <= 48; row++) for (let col = 4; col <= 7; col++) {
  const index = row * hqMap.width + col;
  assert(hqFloor[index] > 0 || hqWall[index] > 0 || hqFurniture[index] > 0,
    `HQ garden approach tile (${col},${row}) must remain painted`);
}
for (let x = 402; x >= 240; x -= 12) {
  const col = Math.floor(x / 48), row = Math.floor((2280 + 27) / 48);
  const index = row * hqMap.width + col;
  assert(hqFloor[index] > 0 || hqWall[index] > 0 || hqFurniture[index] > 0,
    `HQ spawn-to-gate path must remain painted at (${x},2280)`);
}
const officeSource = fs.readFileSync(path.join(here, "../../public/index.html"), "utf8");
assert.match(officeSource, /GARDEN_APPROACH_CELLS[\s\S]*for \(const \[c, r\] of GARDEN_APPROACH_CELLS\)/,
  "client must clear only the authored HQ garden approach cells");
assert.match(officeSource, /for \(let r = 46; r <= 48; r\+\+\) for \(let c = 4; c <= 7; c\+\+\)/,
  "client HQ garden approach must cover the continuous y≈2280 corridor");
assert.match(clientSource, /const LOT_GROUND_DEPTH = 2/);
assert.match(clientSource, /\.setDepth\(LOT_GROUND_DEPTH\)/, "foundation and yard planes share a low depth");
assert.match(clientSource, /\.setDepth\(top \+ 48 \* \(row \+ 1\)\)/, "wall tiles must y-sort by their bottom edge");
assert.match(clientSource, /if \(portal\.residence\) \{\s*this\.portalCues\?\.push\(cue\);(?:(?!scene\.add\.text|this\.add\.text)[\s\S])*?continue;/,
  "residence doors keep a cue but do not add a duplicate owner label");
assert.doesNotMatch(clientSource, /setDepth\(Math\.max\(2, originY - 1\)\)/,
  "yard ground must not be y-sorted over actors");
assert.match(clientSource, /const COLLISION_SAFETY_MARGIN = 0\.5/,
  "Arcade exact-contact protection must remain a tiny client-only margin");
assert.match(clientSource, /actorFootRadius - halfWidth\) \+ 2 \* COLLISION_SAFETY_MARGIN/,
  "client blocker expansion must derive from measured Arcade body extents");
const measuredBodyHalfWidth = 18; // setSize(12, 10) at the authored 3x scale
const measuredZoneExpansion = (ACTOR_FOOT_RADIUS - measuredBodyHalfWidth) + 0.5;
assert.equal(measuredZoneExpansion + measuredBodyHalfWidth, 16.5,
  "the measured 36px scaled body and 16px server foot radius preserve a half-pixel client margin");

console.log("PASS: west-end HQ portal, hidden Huddle A/B homes, and outdoor layering contracts");