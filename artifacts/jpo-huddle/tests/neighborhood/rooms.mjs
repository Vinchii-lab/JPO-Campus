// Database-free construction/room geometry regression coverage.
import assert from "node:assert/strict";
import {
  HOME_CONSTRUCTION_COMPONENTS,
  HOME_GRID,
  HOME_BUILTIN_FIXTURES,
  HOME_BUILTIN_FIXTURE_BLOCKERS,
  HOME_INTERIOR_WALL_BLOCKERS,
  HOME_ROOM_GEOMETRY,
  LOCATION_GEOMETRY,
  FURNITURE_CATALOG,
  locationSpawn,
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
assert.deepEqual(LOCATION_GEOMETRY.home.builtInFixtures, HOME_BUILTIN_FIXTURES,
  "the client receives the exact canonical non-owned fixture list");
assert.equal(HOME_BUILTIN_FIXTURES.length, 8, "starter floor has the eight supplied fixtures");
for (const [index, fixture] of HOME_BUILTIN_FIXTURES.entries()) {
  const blocker = HOME_BUILTIN_FIXTURE_BLOCKERS[index];
  assert.deepEqual(
    blocker,
    {
      x: fixture.gridX * HOME_GRID.cell, y: fixture.gridY * HOME_GRID.cell,
      width: fixture.width * HOME_GRID.cell, height: fixture.height * HOME_GRID.cell,
      fixtureId: fixture.id, builtInFixture: true,
    },
    `${fixture.id} blocker is derived from its grid footprint`,
  );
  assert(LOCATION_GEOMETRY.home.blockers.some((candidate) =>
    candidate.builtInFixture && candidate.fixtureId === fixture.id &&
    candidate.x === blocker.x && candidate.y === blocker.y &&
    candidate.width === blocker.width && candidate.height === blocker.height),
  `${fixture.id} blocker is included in the home collision geometry`);
}
for (let i = 0; i < HOME_BUILTIN_FIXTURES.length; i++) for (let j = i + 1; j < HOME_BUILTIN_FIXTURES.length; j++) {
  const a = HOME_BUILTIN_FIXTURES[i], b = HOME_BUILTIN_FIXTURES[j];
  assert(!(a.gridX < b.gridX + b.width && a.gridX + a.width > b.gridX &&
    a.gridY < b.gridY + b.height && a.gridY + a.height > b.gridY),
  `${a.id} and ${b.id} do not overlap`);
}
assert.deepEqual(
  { width: HOME_GRID.width * HOME_GRID.cell, height: HOME_GRID.height * HOME_GRID.cell },
  { width: 1152, height: 864 },
  "the walkable home uses the supplied-room minimum 24x18 footprint",
);
assert.equal(HOME_ROOM_GEOMETRY.rooms.length, 3, "home has living/kitchen, bedroom, and bath rooms");
assert.ok(HOME_ROOM_GEOMETRY.rooms.some((room) => room.id === "bedroom"),
  "bedroom is an explicitly separated room");
for (const room of HOME_ROOM_GEOMETRY.rooms) {
  assert.ok(room.width >= 9 && room.height >= 7, `${room.id} is a genuinely sized room`);
}

const home = parseLocation("home:rooms@example.com");
assert.deepEqual(locationSpawn(home), { x: 576, y: 720, dir: "down" },
  "home arrival spawn sits in the expanded central living/kitchen approach");
assert.equal(LOCATION_GEOMETRY.home.doors[0].width, 96, "home exit is at least two 48px cells wide");
assert.equal(LOCATION_GEOMETRY.home.doors[0].x, 528, "home exit is centered in the expanded floor");
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
  [[576, 720], [768, 720], [768, 240], [576, 240], [432, 240], [240, 240]],
  // Front door → living/kitchen → bath door → bath.
  [[576, 720], [768, 720], [768, 600], [576, 600], [432, 600], [240, 600]],
  // Bedroom ↔ bath uses the centered two-cell private-wing hallway.
  [[240, 240], [240, 408], [240, 504], [240, 600]],
];
for (const [index, route] of roomRoutes.entries()) {
  assert.ok(routeSamples(route).every(([x, y]) => validLocationMove(home, x, y)),
    `authored room route ${index + 1} remains traversable at 4px samples`);
}
assert.equal(validLocationMove(home, 240, 240), true, "actual bedroom center is walkable");
assert.equal(validLocationMove(home, 240, 600), true, "actual bath center is walkable");
assert.equal(validLocationMove(home, 768, 384), true, "actual living/kitchen center is walkable");
assert.ok(routeSamples([[432, 120], [576, 120]]).some(([x, y]) => !validLocationMove(home, x, y)),
  "4px samples catch a segment that tries to cross the expanded vertical wall");

const chair = FURNITURE_CATALOG.oak_chair;
assert.equal(validPlacement(chair, 10, 1, 0, []), false,
  "indoor placement rejects a vertical room-divider wall");
assert.equal(validPlacement(chair, 1, 9, 0, []), false,
  "indoor placement rejects a horizontal room-divider wall");
for (const [x, y] of [[10, 4], [10, 12], [4, 9]]) {
  assert.equal(validPlacement(chair, x, y, 0, []), false,
    `indoor placement reserves doorway cell ${x},${y}`);
}
assert.equal(validPlacement(chair, 13, 5, 0, []), true,
  "indoor placement accepts a clear living/kitchen cell");
assert.equal(validPlacement(chair, 1, 1, 0, []), true,
  "indoor placement accepts a clear bedroom cell");
assert.equal(validPlacement(chair, 0, 1, 0, []), false, "indoor placement keeps the solid outer wall clear");
assert.equal(validPlacement(chair, 11, 1, 0, []), false,
  "indoor placement rejects a non-owned kitchen fixture");
assert.equal(validPlacement(chair, 2, 2, 0, []), false,
  "indoor placement rejects the three-cell bedroom bed footprint");
assert.equal(validPlacement(chair, 3, 13, 0, []), true,
  "indoor placement keeps a clear bath cell available around fixtures");

console.log("✓ construction prices, room walls, door gaps, and placement validation");