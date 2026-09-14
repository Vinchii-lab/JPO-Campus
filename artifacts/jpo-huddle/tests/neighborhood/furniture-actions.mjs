// Focused, database-free contracts for player-placed home furniture actions.
// This deliberately exercises the shared geometry helpers plus source-level
// guards for the Phaser/server wiring; no socket, Phaser, or live database is
// needed to run it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FURNITURE_CATALOG,
  HOME_GRID,
  homeAccess,
  parseLocation,
  validLocationMove,
  validPlacement,
} from "../../neighborhood.mjs";
import {
  furnitureActionAnchor,
  furnitureActionDefinition,
  furnitureActionPathClear,
  furnitureActionStandCandidates,
  furnitureActionWithinRadius,
  furnitureActivityConflictsWithBlock,
  furnitureIsOccupied,
} from "../../furniture-actions.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const clientSource = fs.readFileSync(path.join(here, "../../public/neighborhood.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(here, "../../public/furniture-renderer.js"), "utf8");
const serverSource = fs.readFileSync(path.join(here, "../../server.js"), "utf8");
const bedPng = fs.readFileSync(path.join(here, "../../public/assets/neighborhood/interiors/bedroom_bed.png"));
assert.equal(bedPng.readUInt32BE(16), 16, "bed artwork remains the supplied portrait width");
assert.equal(bedPng.readUInt32BE(20), 48, "bed artwork remains the supplied portrait length");

const actionMap = Object.fromEntries(
  Object.entries(FURNITURE_CATALOG)
    .filter(([, item]) => Array.isArray(item.actions))
    .map(([id, item]) => [id, item.actions]),
);
assert.deepEqual(actionMap, {
  oak_chair: ["sit"],
  blue_sofa: ["sit", "lie"],
  lounge_sofa: ["sit", "lie"],
  bed: ["lie", "sleep"],
  bathtub: ["shower", "bathe"],
  kitchen_sink: ["toggle_water"],
  plush_bed: ["lie", "sleep"],
  bathroom_sink: ["toggle_water"],
  bathroom_sink_tap: ["toggle_water"],
  shower: ["shower"],
  floor_rug: ["sit"],
  tv: ["watch"],
  television: ["watch"],
}, "only usable furniture exposes the expected ordinary-E actions");

assert.equal(furnitureActionDefinition(FURNITURE_CATALOG.oak_chair, "sit").anim, "sit");
assert.equal(furnitureActionDefinition(FURNITURE_CATALOG.bathtub, "shower").effect, "water");
assert.equal(furnitureActionDefinition(FURNITURE_CATALOG.kitchen_sink, "toggle_water").toggle, true);
assert.equal(furnitureActionDefinition(FURNITURE_CATALOG.television, "watch").anchor, "front",
  "TV action uses the front anchor, not the TV tile center");
assert.equal(FURNITURE_CATALOG.television.path, "/assets/room-furniture/animated_old_tv.png",
  "TV uses the verified CRT sheet rather than the packed rocket-leading sheet");
assert.equal(FURNITURE_CATALOG.bed.width, 1);
assert.equal(FURNITURE_CATALOG.bed.height, 3);
assert.equal(FURNITURE_CATALOG.bed.rotations.length, 1);
assert.equal(FURNITURE_CATALOG.bed.interaction.orientation, "lengthwise",
  "portrait bed metadata keeps sleep lengthwise");
assert.equal(FURNITURE_CATALOG.bed.asset, "bedroom_bed");

const sofa = furnitureActionAnchor(FURNITURE_CATALOG.blue_sofa, 4, 4, HOME_GRID.cell, "sit");
assert.deepEqual(sofa, { x: 240, y: 226, dir: "down" },
  "sofa sit anchor is centered on its two-cell pad");
const tv = furnitureActionAnchor(FURNITURE_CATALOG.television, 13, 5, HOME_GRID.cell, "watch");
assert.deepEqual(tv, { x: 648, y: 306, dir: "up" },
  "TV viewer anchor is below the screen and faces up");
assert.ok(tv.y > (5 + FURNITURE_CATALOG.television.height) * HOME_GRID.cell,
  "TV viewer point is outside the TV footprint");
assert.equal(furnitureActionWithinRadius({ x: tv.x, y: tv.y }, tv, 1), true);
assert.equal(furnitureActionWithinRadius({ x: tv.x + 2, y: tv.y }, tv, 1), false);
const wall = { x: 480, y: 0, width: 48, height: 360 };
assert.equal(furnitureActionPathClear(
  { x: 464, y: 192 }, { x: 544, y: 192 },
  (x, y) => !(x > wall.x && x < wall.x + wall.width && y > wall.y && y < wall.y + wall.height),
), false, "a straight action path cannot pass through an intervening wall");
assert.equal(furnitureActionPathClear(
  { x: 464, y: 420 }, { x: 544, y: 420 },
  (x, y) => !(x > wall.x && x < wall.x + wall.width && y > wall.y && y < wall.y + wall.height),
), true, "a continuous segment outside the wall remains reachable");

const tvStands = furnitureActionStandCandidates(
  { ...FURNITURE_CATALOG.television, rotation: 0 }, 13, 5, HOME_GRID.cell, "watch",
);
assert.deepEqual(tvStands[0], { x: 648, y: 306, dir: "up" },
  "TV exit prefers the same below-screen side");
assert.ok(tvStands.every((point) =>
  point.x < 13 * HOME_GRID.cell || point.x > (13 + 1) * HOME_GRID.cell ||
  point.y < 5 * HOME_GRID.cell || point.y > (5 + 1) * HOME_GRID.cell),
  "all exit candidates stay outside the TV tile");

const bedSleep = furnitureActionAnchor(FURNITURE_CATALOG.bed, 2, 1, HOME_GRID.cell, "sleep");
assert.deepEqual(bedSleep, { x: 120, y: 126, dir: "down" },
  "portrait bed anchor follows its lengthwise footprint");
const wallSideTv = furnitureActionAnchor(FURNITURE_CATALOG.television, 11, 2, HOME_GRID.cell, "watch");
assert.equal(furnitureActionWithinRadius({ x: 464, y: wallSideTv.y }, wallSideTv, 96), true,
  "the through-wall fixture example is within interaction radius");
assert.equal(furnitureActionPathClear(
  { x: 464, y: wallSideTv.y }, wallSideTv,
  (x, y) => validLocationMove(parseLocation("home:actions@example.com"), x, y, []),
), false, "distance alone cannot cross the authoritative room-divider wall");

const home = parseLocation("home:actions@example.com");
const chair = FURNITURE_CATALOG.oak_chair;
assert.equal(validPlacement(chair, 13, 5, 0, []), true,
  "a clear home cell accepts a sit-capable chair");
const chairAnchor = furnitureActionAnchor(chair, 13, 5, HOME_GRID.cell, "sit");
assert.equal(validLocationMove(home, chairAnchor.x, chairAnchor.y, []), true,
  "server path check accepts an action anchor when its own blocker is excluded");
assert.equal(validLocationMove(home, chairAnchor.x, chairAnchor.y, [{
  x: 13 * HOME_GRID.cell, y: 5 * HOME_GRID.cell,
  width: HOME_GRID.cell, height: HOME_GRID.cell,
}]), false,
  "server path check rejects the same anchor when the target blocker is retained");
assert.ok(furnitureActionStandCandidates(chair, 13, 5).some((point) =>
  validLocationMove(home, point.x, point.y, [])),
  "at least one authoritative exit stand is walkable");

const occupants = {
  alice: { locationId: "home:actions@example.com", activity: { instanceId: "chair-1" } },
  bob: { locationId: "home:actions@example.com", activity: { instanceId: "chair-2" } },
  visitor: { locationId: "home:other@example.com", activity: { instanceId: "chair-1" } },
};
assert.equal(furnitureIsOccupied(occupants, "home:actions@example.com", "chair-1"), true);
assert.equal(furnitureIsOccupied(occupants, "home:actions@example.com", "chair-1", "alice"), false,
  "the current actor may re-submit an idempotent action");
assert.equal(furnitureIsOccupied(occupants, "home:actions@example.com", "chair-2", "bob"), false);
const activeBlock = { instanceId: "new-sofa", x: 624, y: 240, width: 96, height: 48 };
assert.equal(furnitureActivityConflictsWithBlock(activeBlock, {
  user: {
    x: 672, y: 270,
    activity: { instanceId: "chair-1", x: 672, y: 270, stand: { x: 672, y: 354 } },
  },
}), true, "placement reservation rejects an active anchor/stand overlap");
assert.equal(furnitureActivityConflictsWithBlock(activeBlock, {
  user: {
    x: 672, y: 500,
    activity: { instanceId: "chair-1", x: 672, y: 500, stand: { x: 672, y: 548 } },
  },
}), false, "placement reservation permits a clear active-player route");
assert.equal(furnitureActivityConflictsWithBlock(
  { ...activeBlock, instanceId: "chair-1" },
  { user: { x: 900, y: 500, activity: { instanceId: "chair-1" } } },
), true, "moving/removing the exact active furniture is always reserved");

const completeHome = (accessMode) => ({
  owner_email: "resident@example.com", access_mode: accessMode,
  floor_built: true, walls_built: true, roof_built: true,
});
const fakePool = (homeRow, invited = false) => ({
  query: async (sql) => {
    if (sql.includes("jpo_home_invitations")) return { rows: invited ? [{}] : [] };
    return { rows: [homeRow] };
  },
});
assert.equal((await homeAccess(fakePool(completeHome("public")), "resident@example.com", "guest@example.com")).ok, true,
  "public home access permits a room visitor");
assert.equal((await homeAccess(fakePool(completeHome("private")), "resident@example.com", "guest@example.com")).ok, false,
  "private home access denies a room visitor");
assert.equal((await homeAccess(fakePool(completeHome("invite_only"), true), "resident@example.com", "guest@example.com")).ok, true,
  "invite-only access requires an active invitation row");

assert.match(serverSource, /socket\.on\("furnitureInteract"/);
assert.match(serverSource, /const access = await homeAccess\(pool, parsed\.ownerEmail, p\.email\)/,
  "server action validates access on every interaction");
assert.match(serverSource, /furnitureIsOccupied\(players, locationId, instanceId/,
  "server occupancy is room- and instance-scoped");
assert.match(serverSource, /validLocationMove\(parsed,\s*anchor\.x,\s*anchor\.y,\s*otherBlocks\)/,
  "server validates the action anchor against every other blocker");
assert.match(serverSource, /furniturePathClear\(parsed, p, anchor, otherBlocks\)/,
  "server validates a continuous path from the player to the action anchor");
assert.match(serverSource, /activeFurniturePlacementConflict\(parsed\.id, instanceId, proposedBlock\)/,
  "server rechecks active anchors and saved stands while holding the home lock");
assert.match(serverSource, /safeFurnitureStand\(player, activity, locationId\)/,
  "server revalidates an exit stand and has a safe fallback before clearing activity");
assert.match(serverSource, /stopFurnitureActivity\(socket\.id, "disconnect"\)/,
  "disconnect cleanup moves to a safe stand before grace/DB persistence");
assert.match(serverSource, /await withHomeOperation\(p\.email, async \(\) => \{/,
  "layout mutation and action paths share the per-home operation lock");
assert.match(serverSource, /if \(p\.activity\) stopFurnitureActivity\(socket\.id, "transition"\)/,
  "map transitions cleanly release an active furniture action");
assert.match(serverSource, /p\.activity\.toggle[\s\S]{0,180}String\(p\.activity\.instanceId\)/,
  "tap actions are server-owned toggles rather than client-only animations");
assert.match(serverSource, /socket\.on\("homePeopleRequest"/,
  "the owner-only people picker uses the existing socket transport");
assert.match(serverSource, /accountIdentifier: row\.account_identifier/,
  "people picker projects only a display name and account identifier");
assert.match(serverSource, /furnitureShowroomRequest/,
  "furniture shop exposes server-provided real catalog demo placements");
assert.match(serverSource, /furnitureDemoInteract/,
  "showroom pieces have a server-authoritative interaction path");
assert.match(serverSource, /showroom-bath[\s\S]{0,180}bathtub/,
  "the showroom demonstrates the real bath entry rather than only listing it for sale");

assert.match(clientSource, /sprite\.setData\('actions', Array\.isArray\(def\.actions\)/,
  "placed sprites retain catalog action metadata for ordinary E prompts");
assert.match(clientSource, /HomeFurnitureRenderer\?\.preload/,
  "the scene delegates furniture loading to the dedicated renderer");
assert.match(rendererSource, /frameInfo\(definition\)[\s\S]{0,500}frameWidth/,
  "renderer crops every supplied sheet from catalog frame metadata");
assert.match(clientSource, /activity\?\.orientation === 'lengthwise'/,
  "portrait bed sleep does not use the sofa's sideways 90-degree pose");
assert.match(clientSource, /sprite\.getData\('anchor'\) === 'front'/,
  "client proximity follows the TV front anchor");

console.log("PASS: furniture actions, anchors, occupancy, paths, access, and render metadata");