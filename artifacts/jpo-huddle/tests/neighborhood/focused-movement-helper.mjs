import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { inspectMovementEnvelope } from "../../movement-protocol.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "../../public/focused-movement-helper.js"), "utf8");
const serverSource = fs.readFileSync(path.join(here, "../../server.js"), "utf8");
const neighborhoodSource = fs.readFileSync(path.join(here, "../../public/neighborhood.js"), "utf8");
const listeners = {};
const fakeWindow = {
  document: { hidden: false },
  addEventListener(name, fn) { listeners[name] = fn; },
};
const context = vm.createContext({ window: fakeWindow, Number, Math });
vm.runInContext(source, context, { filename: "focused-movement-helper.js" });
const helper = fakeWindow.JpoFocusedMovement;

const packets = [];
const volatilePackets = [];
const socket = {
  connected: true,
  volatile: { emit(event, payload) { volatilePackets.push({ event, payload }); } },
  emit(event, payload) { packets.push({ event, payload }); },
  on(event, fn) { this._events ||= {}; this._events[event] = fn; },
};
let paused = 0;
const movement = helper.create(socket, { onPause: () => { paused++; } });

assert.equal(movement.tick(49, "office", { x: 1, y: 2 }), false, "sub-cadence sample stays pending");
assert.equal(volatilePackets.length, 0);
assert.equal(movement.tick(1, "office", { x: 1, y: 2 }), true);
assert.equal(volatilePackets[0].payload.location, "office");
assert.equal(volatilePackets[0].payload.seq, 1);

// Backpressure/disconnect drops the accumulator instead of queuing a burst.
socket.connected = false;
assert.equal(movement.tick(200, "office", { x: 9, y: 9 }), false);
socket.connected = true;
assert.equal(movement.tick(49, "office", { x: 3, y: 4 }), false);
assert.equal(volatilePackets.length, 1);
assert.equal(movement.tick(1, "office", { x: 3, y: 4 }), true);
assert.equal(volatilePackets.length, 2);

// Seat/portal packets remain reliable and sequence after periodic samples.
assert.equal(movement.sendReliable("office", { x: 10, y: 10, anim: "sit" }), true);
assert.equal(packets.at(-1).payload.seq, 3);
assert.equal(packets.at(-1).payload.location, "office");
assert.equal(movement.sendReliable("neighborhood", { x: 20, y: 20, anim: "idle" }), true);
assert.equal(packets.at(-1).payload.seq, 4);

listeners.blur();
assert.equal(paused, 1, "visibility/pause clears active transport");
socket._events.disconnect();
assert.equal(paused, 2, "disconnect clears active transport");

assert.deepEqual(
  inspectMovementEnvelope({ location: "office", seq: 4 }, "neighborhood", 0).reason,
  "wrong-location",
);
assert.equal(inspectMovementEnvelope({ location: "office", seq: 3 }, "office", 3).reason, "outdated-sequence");
assert.equal(inspectMovementEnvelope({ x: 4, y: 5 }, "office", 3).ignore, false, "legacy envelope remains accepted");
// A rejected maliciously-large client sequence must not become the server's
// outbound revision or poison the next honest packet. The server only commits
// inbound sequence state after accepted movement validation.
const malicious = inspectMovementEnvelope({ location: "office", seq: Number.MAX_SAFE_INTEGER, x: 1, y: 1 }, "office", 0);
assert.equal(malicious.ignore, false);
assert.equal(inspectMovementEnvelope({ location: "office", seq: 2, x: 2, y: 2 }, "office", 0).ignore, false,
  "honest sequence remains usable after a rejected huge-sequence packet");
assert.equal(helper.shouldApplyCorrection({ location: "office", seq: 8, x: 1, y: 1 }, "office", 9), false,
  "delayed correction is ignored");
assert.equal(helper.shouldApplyCorrection({ location: "neighborhood", seq: 10, x: 1, y: 1 }, "office", 0), false,
  "wrong-map correction is ignored");
assert.equal(helper.shouldApplyRemote({ location: "office", seq: 5 }, "office", 6), false,
  "reordered remote movement is ignored");
assert.match(serverSource, /movementRevisionOf\(me\), clientSeq: packetSequence/,
  "corrections expose server revision and client sequence acknowledgement separately");
assert.doesNotMatch(serverSource, /bumpMovementRevision\(me,\s*packetSequence/,
  "client sequence must never become server outbound revision");
assert.match(serverSource, /socket\.emit\("locationTransitionResult", \{\s*ok: true, reason: "resume"/s,
  "resume emits authoritative scene sync");
assert.match(serverSource, /location:\s+state\.locationId,\s+locationId:\s+state\.locationId/,
  "resume approval carries the authoritative restored location");
assert.match(neighborhoodSource, /office\._syncOfficePlayers\?\.\(result\.players \|\| \{\}\)/,
  "HQ wake reconciles the resume roster snapshot");
assert.match(neighborhoodSource, /currentPlayers.*activeNeighborhood\(\)\?\.syncPlayers/s,
  "neighborhood snapshots remain scene-gated during resume");

console.log("PASS: focused movement cadence, backpressure, ordering, wrong-map, and correction contracts");