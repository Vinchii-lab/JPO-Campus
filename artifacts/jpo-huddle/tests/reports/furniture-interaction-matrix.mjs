// Complete, database-free furniture matrix. This intentionally exercises the
// same catalog, placement, collision, action-anchor, and stand helpers used by
// the server rather than only checking that coordinates are finite.
import assert from "node:assert/strict";
import {
  FURNITURE_CATALOG,
  HOME_GRID,
  LOCATIONS,
  LOCATION_GEOMETRY,
  furnitureFootprint,
  layoutBlockers,
  locationBounds,
  locationSpawn,
  parseLocation,
  pointHitsRect,
  staticSeatStandCandidates,
  validContinuousLocationMove,
  validLocationMove,
  validPlacement,
} from "../../neighborhood.mjs";
import {
  FURNITURE_ACTIONS,
  furnitureActionAnchor,
  furnitureActionDefinitions,
  furnitureActionIds,
  furnitureActionPathClear,
  furnitureActionStandCandidates,
} from "../../furniture-actions.mjs";

const home = parseLocation("home:matrix@example.com");
const homeCell = HOME_GRID.cell;
const homeSpawn = locationSpawn(home);

// A coarse flood-fill uses the authoritative 16px actor radius and room walls.
// It proves that a stand is reachable from the actual empty-home spawn without
// pretending a straight line can pass through the room divider.
function reachablePoints(location) {
  const bounds = locationBounds(location);
  const step = 8;
  const key = (x, y) => `${x}:${y}`;
  const start = locationSpawn(location);
  const sx = Math.round(start.x / step) * step;
  const sy = Math.round(start.y / step) * step;
  const queue = [[sx, sy]];
  const seen = new Set([key(sx, sy)]);
  for (let index = 0; index < queue.length; index += 1) {
    const [x, y] = queue[index];
    for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= bounds.width || ny >= bounds.height ||
          seen.has(key(nx, ny)) || !validLocationMove(location, nx, ny)) continue;
      seen.add(key(nx, ny));
      queue.push([nx, ny]);
    }
  }
  return {
    count: queue.length,
    canReach(x, y) {
      return queue.some(([rx, ry]) =>
        Math.hypot(rx - x, ry - y) <= step * 1.5 &&
        validContinuousLocationMove(location, rx, ry, x, y));
    },
  };
}

const homeReachability = reachablePoints(home);
assert.ok(homeReachability.count > 1000, "empty home has a real connected walkable area");

function findActionPlacement(definition, rotation, actionId) {
  const footprint = furnitureFootprint(definition, rotation);
  for (let gridY = 1; gridY <= HOME_GRID.height - footprint.height - 1; gridY += 1) {
    for (let gridX = 1; gridX <= HOME_GRID.width - footprint.width - 1; gridX += 1) {
      if (!validPlacement(definition, gridX, gridY, rotation, [])) continue;
      const placed = { ...definition, rotation };
      const anchor = furnitureActionAnchor(placed, gridX, gridY, homeCell, actionId);
      const targetBlock = layoutBlockers([{
        furnitureId: definition.id, gridX, gridY, rotation,
      }])[0];
      assert.ok(targetBlock, `${definition.id}/${rotation} has a shared footprint body`);
      if (!validLocationMove(home, anchor.x, anchor.y, [])) continue;
      const stands = furnitureActionStandCandidates(
        placed, gridX, gridY, homeCell, actionId,
      ).filter((stand) =>
        validLocationMove(home, stand.x, stand.y, []) &&
        homeReachability.canReach(stand.x, stand.y) &&
        furnitureActionPathClear(
          stand, anchor, (x, y) => validLocationMove(home, x, y, []),
        ));
      if (!stands.length) continue;

      // The target's own footprint is excluded by the authoritative action
      // admission path. Check both sides of that contract: retaining it must
      // reject an anchor whose actor body overlaps the target, while a
      // front-facing target may validly leave the actor outside its body.
      const overlapsTargetBody = pointHitsRect(anchor.x, anchor.y, targetBlock);
      if (overlapsTargetBody) {
        assert.equal(
          validLocationMove(home, anchor.x, anchor.y, [targetBlock]),
          false,
          `${definition.id}/${rotation}/${actionId} target body must be excluded`,
        );
      }
      return { gridX, gridY, anchor, stand: stands[0], targetBlock, overlapsTargetBody };
    }
  }
  return null;
}

// These are the catalog's intentionally supported interactions. Keeping the
// list explicit makes a new chair/sofa/bed/bath/sink row fail loudly instead of
// silently becoming a decorative sprite with an E prompt that cannot succeed.
const expectedActions = Object.freeze({
  oak_chair: ["sit"],
  blue_sofa: ["sit", "lie"],
  lounge_sofa: ["sit", "lie"],
  bed: ["lie", "sleep"],
  plush_bed: ["lie", "sleep"],
  bathtub: ["shower", "bathe"],
  shower: ["shower"],
  kitchen_sink: ["toggle_water"],
  bathroom_sink: ["toggle_water"],
  bathroom_sink_tap: ["toggle_water"],
  floor_rug: ["sit"],
  tv: ["watch"],
  television: ["watch"],
});

const obviousInteractiveIds = Object.entries(FURNITURE_CATALOG)
  .filter(([id, definition]) =>
    /chair|sofa|(?:^|_)bed(?:_|$)|bathtub|(?:^|_)sink(?:_|$)|(?:^|_)shower(?:_|$)|ottoman|television|(?:^|_)tv(?:_|$)/i
      .test(`${id} ${definition.name || ""}`))
  .map(([id]) => id);
for (const id of obviousInteractiveIds) {
  assert.ok(expectedActions[id], `${id} is obvious interactive furniture and needs an action contract`);
}

const interactiveRows = [];
const decorativeRows = [];
for (const [id, definition] of Object.entries(FURNITURE_CATALOG)) {
  const rawIds = furnitureActionIds(definition);
  const actions = furnitureActionDefinitions(definition);
  assert.deepEqual(
    rawIds,
    actions.map((action) => action.id),
    `${id} action IDs resolve to shared supported definitions`,
  );
  if (expectedActions[id]) {
    assert.deepEqual(rawIds, expectedActions[id], `${id} exposes its complete supported action set`);
  }
  for (const action of actions) {
    assert.ok(FURNITURE_ACTIONS[action.id], `${id}/${action.id} uses an allow-listed action`);
  }

  const rotationRows = [];
  for (const rotation of definition.rotations || [0]) {
    if (!actions.length) {
      // Even decorative rows must be valid placeable catalog entries at every
      // allowed orientation; they simply have no activity admission path.
      const footprint = furnitureFootprint(definition, rotation);
      assert.ok(furnitureFootprint(definition, rotation).width > 0 &&
        furnitureFootprint(definition, rotation).height > 0);
      assert.equal(
        validPlacement(definition, 1, 1, rotation, []),
        true,
        `${id}/${rotation} decorative footprint is placeable in the empty home`,
      );
      continue;
    }
    for (const action of actions) {
      const result = findActionPlacement(definition, rotation, action.id);
      assert.ok(result, `${id}/${rotation}/${action.id} has a walkable approach and exit`);
      rotationRows.push(
        `${rotation}° ${action.id} @ ${result.gridX},${result.gridY} ` +
        `anchor ${result.anchor.x},${result.anchor.y}; ` +
        `exit ${result.stand.x},${result.stand.y}`,
      );
    }
  }
  const row = {
    item: id,
    footprint: `${definition.width}x${definition.height}`,
    rotations: (definition.rotations || [0]).join("/"),
    actions: rotationRows.length ? rotationRows.join(" | ") : "none",
  };
  if (actions.length) interactiveRows.push(row);
  else decorativeRows.push(row);
}

// Authored commercial chairs/benches/sofas remain park-seat interactions,
// separate from catalog furniture actions. Validate the real room spawn,
// collision body, and at least one reachable approach/exit for each seat.
const commercialRows = [];
const roomReachability = new Map();
for (const [locationId, geometry] of Object.entries(LOCATION_GEOMETRY || {})) {
  const location = parseLocation(locationId);
  if (!location || !LOCATIONS[locationId] && location.kind !== "home") continue;
  const seatIds = (geometry?.seats || []).map((seat) => seat.id);
  assert.equal(new Set(seatIds).size, seatIds.length,
    `${locationId} authored seat IDs are unique for remote seat lifecycle state`);
  for (const seat of geometry?.seats || []) {
    assert.ok(validLocationMove(location, seat.x, seat.y),
      `${locationId}/${seat.id} seat body is walkable`);
    const candidates = staticSeatStandCandidates(location, seat);
    assert.ok(candidates.length, `${locationId}/${seat.id} has a collision-valid approach`);
    if (!roomReachability.has(locationId)) {
      roomReachability.set(locationId, reachablePoints(location));
    }
    const reachability = roomReachability.get(locationId);
    assert.ok(candidates.some((stand) => reachability.canReach(stand.x, stand.y)),
      `${locationId}/${seat.id} approach is reachable from the authored room spawn`);
    commercialRows.push({
      item: `${locationId}/${seat.id}`,
      actions: `park-seat sit; ${candidates.length} valid approach/exit point${candidates.length === 1 ? "" : "s"}`,
    });
  }
}

console.log("Furniture interaction matrix — verified production geometry");
console.log("\nCatalog interactive items (all allowed rotations/actions):");
for (const row of interactiveRows) console.log(
  `- ${row.item} [${row.footprint}, rotations ${row.rotations}]: ${row.actions}`,
);
console.log("\nCatalog deliberately decorative/storage items (no supported E action):");
console.log('- ' + decorativeRows.map((row) => `${row.item} [${row.footprint}, rotations ${row.rotations}]`).join("\n- "));
console.log("\nAuthored commercial seats (park-seat sit path):");
for (const row of commercialRows) console.log(`- ${row.item}: ${row.actions}`);
console.log(
  `\nPASS: ${interactiveRows.length} interactive catalog rows, ` +
  `${decorativeRows.length} deliberate decorative rows, and ` +
  `${commercialRows.length} authored commercial seats verified.`,
);
console.log(
  "Gaps/limits: the current catalog allows only rotation 0 for every row, " +
  "so no quarter-turn art contract is presently exercised; live Phaser texture " +
  "pixels, Arcade resolution, and socket admission still require the main agent's " +
  "actual-game harness.",
);