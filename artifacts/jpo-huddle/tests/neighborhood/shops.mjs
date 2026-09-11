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

// These are the four visual seat points used by _drawCity. They must remain
// outside the two road rectangles even with the server's actor foot radius.
const benches = [{ x: 372, y: 416 }, { x: 780, y: 416 }, { x: 88, y: 712 }, { x: 1064, y: 712 }];
const roads = [
  { x: 0, y: 432, width: 1152, height: 144 },
  { x: 456, y: 0, width: 240, height: 912 },
];
for (const seat of benches) {
  for (const road of roads) {
    const overlaps = seat.x + ACTOR_FOOT_RADIUS > road.x &&
      seat.x - ACTOR_FOOT_RADIUS < road.x + road.width &&
      seat.y + ACTOR_FOOT_RADIUS > road.y &&
      seat.y - ACTOR_FOOT_RADIUS < road.y + road.height;
    assert.equal(overlaps, false, `bench at ${seat.x},${seat.y} is off the road`);
  }
}

console.log(`✓ ${shopIds.length} enterable shops, filtered catalogs, and off-road benches`);