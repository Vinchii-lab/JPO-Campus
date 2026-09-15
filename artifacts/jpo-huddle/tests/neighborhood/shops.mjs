// Cheap geometry/catalog regression coverage. This stays database-free so it
// can run in a checkout without starting the API server.
import assert from "node:assert/strict";
import {
  ACTOR_FOOT_RADIUS,
  LOCATION_GEOMETRY,
  LOCATION_PORTALS,
  SHOP_DEFINITIONS,
  parseLocation,
  portalForTransition,
  shopCatalog,
  validLocationMove,
} from "../../neighborhood.mjs";

const shopIds = Object.keys(SHOP_DEFINITIONS);
const city = parseLocation("city");
assert.ok(validLocationMove(city, 576, 500), "former blue fountain intersection is open");
assert.equal(shopIds.length, 3, "the plaza has one home shop and two themed shops");

const venueIds = ["cafe", "diner", "bakery", "sushi"];
for (const venueId of venueIds) {
  const entry = LOCATION_PORTALS.city.find((portal) => portal.destination === venueId);
  assert.ok(entry, `${venueId} has a city entrance`);
  const entryPoint = {
    x: entry.x + entry.width / 2,
    y: entry.y + entry.height / 2,
  };
  assert.ok(validLocationMove(city, entryPoint.x, entryPoint.y), `${venueId} entry clears city blockers`);
  assert.ok(
    portalForTransition("city", venueId, entryPoint.x, entryPoint.y, "tester@example.com"),
    `${venueId} entry accepts an actor-foot point`,
  );

  const room = parseLocation(venueId);
  assert.equal(room.id, venueId);
  const exit = LOCATION_PORTALS[venueId][0];
  assert.equal(exit.destination, "city", `${venueId} exit goes to city`);
  const exitPoint = {
    x: exit.x + exit.width / 2,
    y: exit.y + exit.height / 2,
  };
  assert.ok(validLocationMove(room, exitPoint.x, exitPoint.y), `${venueId} exit clears room blockers`);
  assert.ok(portalForTransition(venueId, "city", exitPoint.x, exitPoint.y, "tester@example.com"),
    `${venueId} exit accepts an actor-foot point`);
  assert.equal(LOCATION_GEOMETRY[venueId].doors[0].destination, "city");
}


for (const shopId of shopIds) {
  const entry = LOCATION_PORTALS.city.find((portal) => portal.destination === shopId);
  assert.ok(entry, `${shopId} has a city entrance`);
  const entryPoint = {
    x: entry.x + entry.width / 2,
    y: entry.y + entry.height / 2,
  };
  assert.ok(validLocationMove(city, entryPoint.x, entryPoint.y), `${shopId} entry clears city blockers`);
  assert.ok(
    portalForTransition("city", shopId, entryPoint.x, entryPoint.y, "tester@example.com"),
    `${shopId} entry accepts an actor-foot point`,
  );

  const room = parseLocation(shopId);
  const exit = LOCATION_PORTALS[shopId][0];
  const exitPoint = {
    x: exit.x + exit.width / 2,
    y: exit.y + exit.height / 2,
  };
  assert.ok(validLocationMove(room, exitPoint.x, exitPoint.y), `${shopId} exit clears room blockers`);
  assert.ok(portalForTransition(shopId, "city", exitPoint.x, exitPoint.y, "tester@example.com"),
    `${shopId} exit accepts an actor-foot point`);
  assert.equal(LOCATION_GEOMETRY[shopId].doors[0].destination, "city");
}

assert.deepEqual(
  Object.keys(shopCatalog("garden-shop")),
  ["fern", "oak_chair", "reading_lamp"],
  "garden shop exposes its filtered catalog",
);
assert.deepEqual(
  Object.keys(shopCatalog("decor-shop")),
  ["coffee_table", "blue_sofa", "bookcase", "oak_chair", "reading_lamp"],
  "decor shop exposes its filtered catalog",
);
assert.equal(Object.keys(shopCatalog("furniture-shop")).length, 6);
assert.equal(shopCatalog("garden-shop").fern.price, shopCatalog("furniture-shop").fern.price,
  "themed shops reuse server catalog pricing");

// These are the eight visual seat points used by _drawCity. They remain clear
// of facade blockers and have an authored walkable stand on the same square.
for (const seat of LOCATION_GEOMETRY.city.seats) {
  assert.equal(validLocationMove(city, seat.x, seat.y), true, `bench at ${seat.x},${seat.y} is walkable`);
  assert((seat.stands || []).some((stand) => validLocationMove(city, stand.x, stand.y)),
    `bench at ${seat.x},${seat.y} has a walkable stand`);
}

console.log(`✓ ${shopIds.length} enterable shops, 4 new venues, filtered catalogs, and eight off-facade benches`);