// No live accounts, database, app startup, or network required. Execute the
// shipped trigger and socket handler against the real geometry contracts.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import * as world from "../../neighborhood.mjs";
import { inspectMovementEnvelope } from "../../movement-protocol.mjs";

const client = fs.readFileSync(new URL("../../public/neighborhood.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../../server.js", import.meta.url), "utf8");
const method = (name, next) => client.slice(client.indexOf(`    ${name}(`), client.indexOf(`    ${next}(`));
const scene = vm.runInNewContext(`({${method("_portalInnerBounds", "_addBlock")}})`);
scene.actorFootRadius = world.ACTOR_FOOT_RADIUS;
scene.doors = world.LOCATION_PORTALS.city;
const triggerStart = client.indexOf("const door = this.doors.find");
const triggerEnd = client.indexOf("\n      });", triggerStart) + "\n      });".length;
const trigger = vm.runInNewContext(`(function() { ${client.slice(triggerStart, triggerEnd)} return door; })`);
const gate = world.LOCATION_PORTALS.city.find((p) => p.destination === "neighborhood");
const x = gate.x + gate.width / 2;
const y = gate.y + gate.height / 2;
const homes = Array.from({ length: 100 }, (_, lotIndex) => ({
  lotIndex, ownerEmail: `fixture-${lotIndex}@example.invalid`,
  construction: { complete: true, wallsBuilt: true },
}));
const street = world.streetDefinition(homes);
assert.deepEqual(street.cityPortals[0], { ...gate, label: "Willow Walk", segment: 0, row: 0 });
assert.equal(world.streetCityPortalForTransition(48, 504, homes), null,
  "retired residential-road coordinate must not activate a hidden Plaza exit");

// Continuous approach, including the live client's inset and measured Arcade
// feet transform (3x sprite: center y+27, half extents 18x15).
const blocks = [];
const arcade = vm.runInNewContext(`({${method("_addBlock", "_setLocalPresentation")}})`, {
  COLLISION_SAFETY_MARGIN: 0.5,
});
arcade.actorFootRadius = world.ACTOR_FOOT_RADIUS;
arcade.player = { x: 192, y, body: {
  center: { x: 192, y: y + 27 }, halfWidth: 18, halfHeight: 15,
  updateFromGameObject() {},
} };
arcade.add = { rectangle: (cx, cy, width, height) => ({ cx, cy, width, height }) };
arcade.physics = { add: { existing() {} } };
for (const rect of world.LOCATION_GEOMETRY.city.blockers) arcade._addBlock({ add: (r) => blocks.push(r) }, rect);
for (let px = world.LOCATIONS.city.spawn.x; px >= x; px -= 2) {
  assert(world.validLocationMove(world.parseLocation("city"), px, y), `server approach ${px}`);
  assert(!blocks.some((b) => Math.abs(px - b.cx) < 18 + b.width / 2 &&
    Math.abs(y + 27 - b.cy) < 15 + b.height / 2), `Arcade approach ${px}`);
}
scene.player = { x, y };
assert.equal(trigger.call(scene), gate, "actual client trigger chooses visible Willow gate");
scene.player = { x: 192, y };
assert.equal(trigger.call(scene), undefined, "arrival remains outside trigger");
const cleared = [];
const reused = vm.runInNewContext(`({${method("_resetTransientTravel", "_clearMovementTransport")}})`, {
  clearTimeout: (timer) => cleared.push(timer), movement: { clear() {} },
});
for (let cycle = 0; cycle < 3; cycle++) {
  reused.transitionRequested = true;
  reused.portalRelease = false;
  reused._portalFading = true;
  reused._portalMoveTimer = `move-${cycle}`;
  reused._portalTravelTimer = `travel-${cycle}`;
  reused.player = {}; // retained sprite after Arcade destroyed its body
  reused._resetTransientTravel();
  assert.equal(reused.transitionRequested, false);
  assert.equal(reused.portalRelease, true);
  assert.equal(reused._portalFading, false);
  assert.equal(reused._portalTravelGeneration, cycle + 1);
}
assert.equal(cleared.length, 6, "reused scene cancels both pending portal callbacks");
for (const road of street.roadPortals) {
  const returned = world.streetCityPortalForTransition(x, y, homes, { segment: road.segment });
  assert.deepEqual(returned.spawn, road.returnPoint);
  assert(world.validStreetWorldMove(street, returned.spawn.x, returned.spawn.y));
  assert.equal(world.streetPortalForTransition("city", returned.spawn.x, returned.spawn.y, homes), null,
    "return cannot immediately bounce to Plaza");
}

const packets = [];
const handlers = {};
const rooms = new Set(["city"]);
const p = { email: "huddle-a-portal@justpressone.com", locationId: "city", x, y };
const socket = {
  id: "portal-fixture", on: (event, fn) => { handlers[event] = fn; },
  emit: (event, data) => packets.push({ event, data }),
  leave: (room) => rooms.delete(room), join: (room) => rooms.add(room),
};
const context = {
  ...world, inspectMovementEnvelope, socket, console,
  players: { [socket.id]: p }, streetHomes: homes, streetWorld: street,
  locationOf: (player) => player?.locationId, locationRoom: (id) => id,
  inAnyMatch: () => false, inRound: () => false, rlglActiveRunner: () => false,
  refreshStreetHomes: async () => {}, emitToLocation() {}, bumpMovementRevision() {},
  // External persistence/presentation are inert; portal selection, remembered
  // state, spawn, roster and room changes execute the actual server handler.
  pool: {}, ensureHome: async () => null, homeExteriorColor: () => "blue",
  locationInfo: (id) => ({ portals: world.LOCATION_PORTALS[id] }),
  movementPayload: (id, player) => ({ id, ...player }), locationPlayers: () => ({}),
  filterPlayersForLocation: () => ({}), phMaskedPlayers: () => ({}),
  isShopLocation: () => false, lastMoveAt: 0, wasSitting: false, lastMoveSequence: 0,
};
const start = server.indexOf("  let locationTransitionSequence = 0;");
const end = server.indexOf('\n  socket.on("furnitureInteract"', start);
assert(start > 0 && end > start);
vm.runInNewContext(server.slice(start, end), context);
let seq = 0;
async function travel(destination) {
  packets.length = 0;
  handlers.locationTransition({ destination, locationId: p.locationId, seq: ++seq });
  await new Promise((resolve) => setImmediate(resolve));
  const result = packets.find((packet) => packet.event === "locationTransitionResult")?.data;
  assert(result, "socket produces a transition response");
  return result;
}
for (const segment of [null, street.roadPortals.length - 1, 999]) {
  p.locationId = "city"; p.x = x; p.y = y;
  p.residentialExitBlock = segment == null ? null : { segment, roadY: -1, returnPoint: { x: -1, y: -1 } };
  rooms.clear(); rooms.add("city");
  const result = await travel("neighborhood");
  assert.equal(result.ok, true, "visible gate accepted by actual socket handler");
  const selected = street.roadPortals.find((r) => r.segment === segment) || street.roadPortals[0];
  assert.equal(result.spawn.x, selected.returnPoint.x);
  assert.equal(result.spawn.y, selected.returnPoint.y);
  assert.deepEqual([...rooms], ["neighborhood"]);
  // Walk to the remembered road's gate and repeat the round trip.
  p.x = selected.x + selected.width / 2; p.y = selected.y + selected.height / 2;
  assert.equal((await travel("city")).ok, true);
  assert.equal(p.residentialExitBlock.segment, selected.segment);
  assert.equal(world.streetCityPortalForTransition(p.x, p.y, homes), null, "Plaza spawn is outside gate");
  p.x = x; p.y = y;
  assert.equal((await travel("neighborhood")).ok, true, "second return succeeds");
}
p.locationId = "city"; p.x = 48; p.y = 504;
assert.equal((await travel("neighborhood")).code, "portal", "invisible old gate rejected by handler");
packets.length = 0;
handlers.locationTransition({ destination: "city", locationId: "neighborhood", seq: ++seq });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(packets.length, 0, "stale-map travel is ignored without moving the current scene");
console.log("PASS: visible Plaza trigger, continuous Arcade/server approach, socket round trips, remembered/stale rows, no arrival bounce");