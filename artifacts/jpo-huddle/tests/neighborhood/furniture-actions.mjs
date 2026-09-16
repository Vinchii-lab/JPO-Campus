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
  LOCATION_GEOMETRY,
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
import commercialLayouts from "../../public/commercial-layouts.json" with { type: "json" };

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

// Huddle Home is a catalog showroom, not a collection of static park-seat
// aliases. Rebuild its intentionally small, server-authored collision fixture
// here with the same bottom-centred catalog footprint math used by server.js.
// This is bounded QA: one representative demo proves blocked walking from both
// sides; every real action demo proves its displayed stand can open its own
// catalog action while all other displays remain solid.
const showroomLocation = parseLocation("furniture-shop");
const showroomFixtureBlocks = commercialLayouts.rooms["furniture-shop"].fixtureBlockers;
assert.equal(LOCATION_GEOMETRY["furniture-shop"].seats.length, 0,
  "removed placeholder chairs cannot expose unrelated static Sit targets");
assert.ok(Array.isArray(showroomFixtureBlocks) && showroomFixtureBlocks.length > 0,
  "retained Huddle Home decor fixtures have authored physical bodies");
const showroomDemos = [
  ["showroom-blue-sofa", "blue_sofa", 180, 320, "sit"],
  ["showroom-lounge-sofa", "lounge_sofa", 340, 320, "sit"],
  ["showroom-bed", "plush_bed", 760, 320, "lie"],
  ["showroom-counter", "kitchen_counter", 440, 480, null],
  ["showroom-bath", "bathtub", 620, 480, "shower"],
  ["showroom-sink", "bathroom_sink_tap", 760, 480, "toggle_water"],
  ["showroom-tv", "television", 500, 140, "watch"],
  ["showroom-oak-chair-1", "oak_chair", 200, 520, "sit"],
  ["showroom-oak-chair-2", "oak_chair", 360, 520, "sit"],
  ["showroom-oak-chair-3", "oak_chair", 600, 520, "sit"],
  ["showroom-oak-chair-4", "oak_chair", 760, 520, "sit"],
].map(([instanceId, furnitureId, x, y, action]) => {
  const definition = FURNITURE_CATALOG[furnitureId];
  return {
    instanceId, furnitureId, x, y, action, definition,
    block: {
      x: x - Number(definition.width || 1) * HOME_GRID.cell / 2,
      y: y - Number(definition.height || 1) * HOME_GRID.cell,
      width: Number(definition.width || 1) * HOME_GRID.cell,
      height: Number(definition.height || 1) * HOME_GRID.cell,
      instanceId,
    },
  };
});
const showroomBlocks = [...showroomFixtureBlocks, ...showroomDemos.map((demo) => demo.block)];
function showroomActionAnchor(demo, action) {
  const gridX = demo.block.x / HOME_GRID.cell;
  const gridY = demo.block.y / HOME_GRID.cell;
  const base = furnitureActionAnchor(demo.definition, gridX, gridY, HOME_GRID.cell, demo.action);
  const otherBlocks = showroomBlocks.filter((block) => block.instanceId !== demo.instanceId);
  if (validLocationMove(showroomLocation, base.x, base.y, otherBlocks)) return base;
  for (let distance = 2; distance <= 64; distance += 2) {
    for (const [dx, dy] of [[0, -distance], [0, distance], [-distance, 0], [distance, 0]]) {
      const candidate = { ...base, x: base.x + dx, y: base.y + dy };
      if (validLocationMove(showroomLocation, candidate.x, candidate.y, otherBlocks)) return candidate;
    }
  }
  return base;
}
for (const demo of showroomDemos.filter((entry) => entry.action)) {
  const action = furnitureActionDefinition(demo.definition, demo.action);
  const gridX = demo.block.x / HOME_GRID.cell;
  const gridY = demo.block.y / HOME_GRID.cell;
  const anchor = showroomActionAnchor(demo, action);
  const otherBlocks = showroomBlocks.filter((block) => block.instanceId !== demo.instanceId);
  demo.stand = furnitureActionStandCandidates(
    demo.definition, gridX, gridY, HOME_GRID.cell, demo.action,
  ).find((candidate) =>
    validLocationMove(showroomLocation, candidate.x, candidate.y, otherBlocks) &&
    furnitureActionWithinRadius(candidate, anchor, action.radius) &&
    furnitureActionPathClear(candidate, anchor, (x, y) =>
      validLocationMove(showroomLocation, x, y, otherBlocks)));
  assert.ok(demo.stand,
    `${demo.instanceId} derives a collision-valid approach from its current catalog action anchor`);
}
const sofaDemo = showroomDemos[0];
const sofaCenterX = sofaDemo.block.x + sofaDemo.block.width / 2;
assert.equal(validLocationMove(showroomLocation, sofaCenterX, sofaDemo.block.y - 17, showroomBlocks), true,
  "showroom sofa has a walkable north approach");
assert.equal(validLocationMove(showroomLocation, sofaCenterX, sofaDemo.block.y - 15, showroomBlocks), false,
  "walking into the showroom sofa is blocked from its north side");
assert.equal(validLocationMove(showroomLocation, sofaCenterX, sofaDemo.block.y + sofaDemo.block.height + 17, showroomBlocks), true,
  "showroom sofa has a walkable south approach");
assert.equal(validLocationMove(showroomLocation, sofaCenterX, sofaDemo.block.y + sofaDemo.block.height + 15, showroomBlocks), false,
  "walking into the showroom sofa is blocked from its south side");
for (const demo of showroomDemos.filter((entry) => entry.action)) {
  const action = furnitureActionDefinition(demo.definition, demo.action);
  const gridX = demo.block.x / HOME_GRID.cell;
  const gridY = demo.block.y / HOME_GRID.cell;
  const anchor = showroomActionAnchor(demo, action);
  const otherBlocks = showroomBlocks.filter((block) => block.instanceId !== demo.instanceId);
  assert.equal(validLocationMove(showroomLocation, demo.stand.x, demo.stand.y, otherBlocks), true,
    `${demo.instanceId} has a collision-valid displayed stand`);
  assert.equal(furnitureActionWithinRadius(demo.stand, anchor, action.radius), true,
    `${demo.instanceId} stand opens its real ${demo.action} catalog action`);
}

const sofa = furnitureActionAnchor(FURNITURE_CATALOG.blue_sofa, 4, 4, HOME_GRID.cell, "sit");
assert.deepEqual(sofa, { x: 240, y: 192, dir: "down" },
  "sofa sit anchor is centered on its two-cell seat pad");
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
assert.deepEqual(chairAnchor, { x: 648, y: 227, dir: "down" },
  "chair sit anchor aligns 3× avatar hips to the 2× armchair pad");
assert.equal(furnitureActionDefinition(chair, "sit").radius, 96,
  "chair admission includes the showroom's authored approach stand");
assert.deepEqual(chair.occluder?.default, { fromPx: 21, depthBias: 0.01 },
  "chair front layer starts at the actual cushion rail, not only its feet");
assert.equal(validLocationMove(home, chairAnchor.x, chairAnchor.y, []), true,
  "server path check accepts an action anchor when its own blocker is excluded");
assert.equal(validLocationMove(home, chairAnchor.x, chairAnchor.y, [{
  x: 13 * HOME_GRID.cell, y: 5 * HOME_GRID.cell,
  width: HOME_GRID.cell, height: HOME_GRID.cell,
}]), false,
  "anatomical chair anchor is reserved by its own saved one-cell blocker");
assert.ok(furnitureActionStandCandidates(chair, 13, 5).some((point) =>
  validLocationMove(home, point.x, point.y, [])),
  "at least one authoritative exit stand is walkable");

const bathAnchor = furnitureActionAnchor(FURNITURE_CATALOG.bathtub, 17, 4, HOME_GRID.cell, "bathe");
assert.deepEqual(bathAnchor, { x: 864, y: 152, dir: "down" },
  "bath anchor uses the authored basin/head presentation offset");

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
assert.match(serverSource,
  /showroom-oak-chair-1[\s\S]{0,120}furnitureId: "oak_chair"[\s\S]{0,900}showroom-oak-chair-4/,
  "Huddle Home exposes all four former gold-chair floor anchors as real catalog demos");
assert.match(serverSource, /showroom-bath[\s\S]{0,180}bathtub/,
  "the showroom demonstrates the real bath entry rather than only listing it for sale");
assert.match(serverSource, /const showroomLocation = parseLocation\(locationId\)[\s\S]{0,900}validLocationMove\(showroomLocation, demoAnchor\.x, demoAnchor\.y,[\s\S]{0,240}furniturePathClear\(showroomLocation, p, demoAnchor/,
  "showroom admission validates the catalog anchor and continuous path");
assert.match(serverSource, /function furnitureShowroomDemoBlock\(demo\)[\s\S]{0,700}function furnitureShowroomBlockers\(\)[\s\S]{0,350}showroom: true/,
  "each real showroom catalog demo contributes one shared physical blocker");
assert.match(serverSource, /const blockers = locationFurnitureBlockers\(location\)/,
  "ordinary server movement uses real showroom demo blockers, not only home furniture");
assert.match(serverSource, /const otherShowroomBlockers = showroomBlockers\.filter[\s\S]{0,350}validLocationMove\(showroomLocation, demoAnchor\.x, demoAnchor\.y, otherShowroomBlockers\)[\s\S]{0,180}furniturePathClear\(showroomLocation, p, demoAnchor, otherShowroomBlockers\)/,
  "a showroom action excludes only its own body while rejecting paths through other displays");
assert.match(serverSource, /if \(moveToStand\) \{[\s\S]{0,180}safeFurnitureStand\(player, activity, locationId\)/,
  "every authoritative activity exit, including showroom exits, resolves a safe stand");
assert.match(serverSource, /furnitureDemoInteractionResult", \{\s*ok: true, phase: "stop", instanceId: activity\.instanceId, action: activity\.action,[\s\S]{0,120}x: p\.x, y: p\.y, dir: p\.dir/,
  "showroom exit acknowledges the server's final stand coordinates");

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
assert.match(clientSource, /if \(this\.activity\) \{[\s\S]{0,500}this\._applyActivityPose\(this, this\.activity, this\.playerDir/,
  "the local update loop reapplies the authoritative activity pose");
assert.match(clientSource, /for \(const remote of Object\.values\(this\.remotes\)\) \{[\s\S]{0,180}remote\.activity[\s\S]{0,180}this\._applyActivityPose\(remote, remote\.activity/,
  "the remote update loop preserves activity poses across live ticks");
assert.match(clientSource, /if \(Number\.isFinite\(payload\.x\) && Number\.isFinite\(payload\.y\)\) \{[\s\S]{0,220}this\.player\.body\.reset\(this\.player\.x, this\.player\.y\)/,
  "local stop packets apply the server-authoritative stand after optimistic exit");
assert.match(clientSource, /_requestFurnitureAction\(\) \{[\s\S]{0,300}const cashier = this\.nearbyCashier \|\| this\._nearbyCashier\(\)[\s\S]{0,180}this\._interactCashier\(\)/,
  "cashier priority remains enforced even for direct furniture-action calls");
assert.match(clientSource, /const interaction = this\._furnitureActionAnchor\(sprite, selectedAction\)[\s\S]{0,900}anchor: interaction/,
  "showroom E prompts use the selected catalog action anchor rather than a mismatched stand point");
assert.doesNotMatch(clientSource, /setTint\?\.\(0xff5555\)/,
  "an invalid placement preview never recolours the authored furniture art red");
assert.match(clientSource, /this\.ghost\.clearTint\?\.\(\)[\s\S]{0,450}_drawGhostFootprint\(/,
  "both valid and invalid previews restore original product art before drawing a validity outline");
assert.match(clientSource, /isValid: valid,[\s\S]{0,3000}Cannot place here: blocked or outside the room\./,
  "invalid placement remains explicitly explained and its confirmation stays disabled");

console.log("PASS: furniture actions, anchors, occupancy, paths, access, and render metadata");