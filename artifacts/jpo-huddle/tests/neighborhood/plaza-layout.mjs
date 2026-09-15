import assert from "node:assert/strict";
import {
  ACTOR_FOOT_RADIUS,
  CITY_PLAZA_LAYOUT,
  LOCATION_GEOMETRY,
  LOCATION_PORTALS,
  LOCATIONS,
  parseLocation,
  staticSeatStandCandidates,
  validContinuousLocationMove,
  validLocationMove,
} from "../../neighborhood.mjs";

const city = parseLocation("city");
const bounds = LOCATIONS.city.bounds;
assert.deepEqual(bounds, { width: 3600, height: 1920 }, "Huddle Plaza keeps its landscape bounds");
assert.deepEqual(CITY_PLAZA_LAYOUT.cityBounds, bounds, "renderer and validator share plaza bounds");
assert(validLocationMove(city, LOCATIONS.city.spawn.x, LOCATIONS.city.spawn.y),
  "direct plaza arrival is walkable");
assert.equal(CITY_PLAZA_LAYOUT.venues.length, 8, "all eight venues have authored footprints");
assert.deepEqual(
  CITY_PLAZA_LAYOUT.venues.map((venue) => venue.id),
  ["furniture-shop", "garden-shop", "decor-shop", "cafe", "diner", "bakery", "sushi", "museum"],
  "venue IDs remain stable",
);

function assertRectInBounds(rect, label) {
  assert(Number.isFinite(rect.x) && Number.isFinite(rect.y), `${label} has numeric origin`);
  assert(Number.isFinite(rect.width) && Number.isFinite(rect.height), `${label} has numeric size`);
  assert(rect.x >= 0 && rect.y >= 0, `${label} starts inside city`);
  assert(rect.x + rect.width <= bounds.width && rect.y + rect.height <= bounds.height,
    `${label} stays inside city bounds`);
}

assertRectInBounds(CITY_PLAZA_LAYOUT.gatheringSquare, "gathering square");
assert(CITY_PLAZA_LAYOUT.gatheringSquare.width >= 3000, "gathering square spans the plaza");
assert(CITY_PLAZA_LAYOUT.gatheringSquare.height >= 600, "gathering square is deep");
for (const venue of CITY_PLAZA_LAYOUT.venues) {
  assertRectInBounds(venue.footprint, `${venue.id} footprint`);
  assertRectInBounds(venue.door, `${venue.id} threshold`);
}

for (const [index, blocker] of LOCATION_GEOMETRY.city.blockers.entries()) {
  assertRectInBounds(blocker, `city blocker ${index}`);
}
for (const [index, portal] of LOCATION_PORTALS.city.entries()) {
  assertRectInBounds(portal, `city portal ${index}`);
  const x = portal.x + portal.width / 2;
  const y = portal.y + portal.height / 2;
  assert(validLocationMove(city, x, y), `${portal.destination} threshold is actor-walkable`);
  if (portal.destination !== "neighborhood") {
    assert(portal.spawn && validLocationMove(city, portal.spawn.x, portal.spawn.y),
      `${portal.destination} city return spawn is actor-walkable`);
  }
}

// A small flood fill catches a facade that has a valid endpoint but no route
// from the direct west-gate arrival. It exercises every venue threshold.
const step = 8;
const cols = Math.ceil(bounds.width / step);
const start = [LOCATIONS.city.spawn.x, LOCATIONS.city.spawn.y];
const queue = [start];
const seen = new Set([start[1] / step * cols + start[0] / step]);
for (let head = 0; head < queue.length; head += 1) {
  const [x, y] = queue[head];
  for (const [nextX, nextY] of [[x - step, y], [x + step, y], [x, y - step], [x, y + step]]) {
    if (nextX < 0 || nextY < 0 || nextX >= bounds.width || nextY >= bounds.height ||
        !validLocationMove(city, nextX, nextY)) continue;
    const key = nextY / step * cols + nextX / step;
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push([nextX, nextY]);
  }
}
const reaches = (x, y) => seen.has(Math.round(y / step) * cols + Math.round(x / step));
for (const portal of LOCATION_PORTALS.city) {
  const x = portal.x + portal.width / 2;
  const y = portal.y + portal.height / 2;
  assert(reaches(x, y), `reachable route to ${portal.destination}`);
}

for (const seat of LOCATION_GEOMETRY.city.seats) {
  assert(validLocationMove(city, seat.x, seat.y), `${seat.id} seat anchor is walkable`);
  for (const stand of staticSeatStandCandidates(city, seat)) {
    assert(reaches(stand.x, stand.y), `${seat.id} stand is reachable`);
    assert(validContinuousLocationMove(city, stand.x, stand.y, seat.x, seat.y),
      `${seat.id} stand-to-seat path is collision-free`);
  }
}

assert.equal(
  Math.min(...CITY_PLAZA_LAYOUT.venues.map((venue) => venue.footprint.x)),
  368,
  "venues retain a landscaped west margin",
);
assert.equal(
  Math.max(...CITY_PLAZA_LAYOUT.venues.map((venue) => venue.footprint.x + venue.footprint.width)),
  3240,
  "venues retain a landscaped east margin",
);
assert(
  CITY_PLAZA_LAYOUT.venues.filter((venue) => venue.footprint.y < CITY_PLAZA_LAYOUT.gatheringSquare.y).length === 4 &&
  CITY_PLAZA_LAYOUT.venues.filter((venue) => venue.footprint.y >= CITY_PLAZA_LAYOUT.gatheringSquare.y).length === 4,
  "four venues occupy each plaza row",
);
assert(ACTOR_FOOT_RADIUS > 0);
console.log("PASS: Huddle Plaza bounds, eight venue thresholds, seats, and routes");