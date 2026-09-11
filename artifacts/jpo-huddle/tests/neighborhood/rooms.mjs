// Database-free construction/room geometry regression coverage.
import assert from "node:assert/strict";
import {
  HOME_CONSTRUCTION_COMPONENTS,
  HOME_GRID,
  HOME_INTERIOR_WALL_BLOCKERS,
  HOME_ROOM_GEOMETRY,
  LOCATION_GEOMETRY,
  FURNITURE_CATALOG,
  parseLocation,
  validLocationMove,
  validPlacement,
} from "../../neighborhood.mjs";

const prices = Object.fromEntries(
  Object.entries(HOME_CONSTRUCTION_COMPONENTS).map(([id, component]) => [id, component.price]),
);
assert.deepEqual(prices, { floor: 20000, walls: 25000, roof: 35000 },
  "construction prices are server-owned and total exactly 80,000 coins");
assert.equal(Object.values(prices).reduce((sum, price) => sum + price, 0), 80000);

assert.deepEqual(LOCATION_GEOMETRY.home.roomDividers, HOME_INTERIOR_WALL_BLOCKERS,
  "the map contract exposes the same wall cells used by the home collider");
assert.equal(HOME_ROOM_GEOMETRY.rooms.length, 3, "home has living/kitchen, bedroom, and bath rooms");
assert.ok(HOME_ROOM_GEOMETRY.rooms.some((room) => room.id === "bedroom"),
  "bedroom is an explicitly separated room");

const home = parseLocation("home:rooms@example.com");
for (const wall of HOME_INTERIOR_WALL_BLOCKERS) {
  const x = wall.x + wall.width / 2;
  const y = wall.y + wall.height / 2;
  assert.equal(validLocationMove(home, x, y), false, `wall cell at ${x},${y} is solid`);
}
for (const doorway of HOME_ROOM_GEOMETRY.doorways) {
  const x = (doorway.x + doorway.width / 2) * HOME_GRID.cell;
  const y = (doorway.y + doorway.height / 2) * HOME_GRID.cell;
  assert.equal(validLocationMove(home, x, y), true, `door gap at ${x},${y} is traversable`);
}

// Sample every 4px along each segment, not just endpoints: an endpoint-only
// check can leap over the x=3 wall beside the bedroom/bath doorway.
function routeSamples(points) {
  const samples = [];
  for (let index = 1; index < points.length; index++) {
    const [fromX, fromY] = points[index - 1];
    const [toX, toY] = points[index];
    const steps = Math.max(1, Math.ceil(Math.hypot(toX - fromX, toY - fromY) / 4));
    for (let step = 0; step <= steps; step++) {
      const ratio = step / steps;
      samples.push([fromX + (toX - fromX) * ratio, fromY + (toY - fromY) * ratio]);
    }
  }
  return samples;
}
const roomRoutes = [
  // Front door → living/kitchen → bedroom door → bedroom center.
  [[288, 312], [288, 120], [216, 120], [120, 120]],
  // Front door → living/kitchen → bath door → bath.
  [[288, 312], [216, 312], [120, 312]],
  // Bedroom ↔ bath uses the reserved x=2,y=4 doorway.
  [[120, 120], [120, 312]],
];
for (const [index, route] of roomRoutes.entries()) {
  assert.ok(routeSamples(route).every(([x, y]) => validLocationMove(home, x, y)),
    `authored room route ${index + 1} remains traversable at 4px samples`);
}
assert.equal(validLocationMove(home, 120, 120), true, "actual bedroom center is walkable");
assert.ok(routeSamples([[216, 216], [120, 216]]).some(([x, y]) => !validLocationMove(home, x, y)),
  "4px samples catch a segment that tries to cross the x=3 wall");

const chair = FURNITURE_CATALOG.oak_chair;
assert.equal(validPlacement(chair, 4, 1, 0, []), false,
  "indoor placement rejects a vertical room-divider wall");
assert.equal(validPlacement(chair, 1, 4, 0, []), false,
  "indoor placement rejects a horizontal room-divider wall");
for (const [x, y] of [[4, 2], [4, 6], [2, 4]]) {
  assert.equal(validPlacement(chair, x, y, 0, []), false,
    `indoor placement reserves doorway cell ${x},${y}`);
}
assert.equal(validPlacement(chair, 5, 1, 0, []), true,
  "indoor placement accepts a clear living/kitchen cell");
assert.equal(validPlacement(chair, 1, 1, 0, []), true,
  "indoor placement accepts a clear bedroom cell");

console.log("✓ construction prices, room walls, door gaps, and placement validation");