import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createMovementCorrectionFence, inspectMovementEnvelope } from "../../movement-protocol.mjs";
import {
  parseLocation, streetDefinition, validStreetWorldMove, validContinuousStreetWorldMove,
  validLocationMove, validContinuousLocationMove, staticSeatForPoint, staticSeatStandCandidates,
  portalForTransition, locationSpawn,
} from "../../neighborhood.mjs";

const read = (name) => fs.readFileSync(new URL(`../../${name}`, import.meta.url), "utf8");
const server = read("server.js");
const helperSource = read("public/focused-movement-helper.js");
const neighborhood = read("public/neighborhood.js");
const between = (source, start, end) => {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, `runtime section exists: ${start}`);
  return source.slice(a, b);
};
// Execute the production handler, constants, transport, and BOTH local
// correction consumers. No copied speed-budget or reconciliation algorithm.
const handler = between(server, '  socket.on("playerMove",', '  socket.on("chatMessage",');
const constants = between(server, "const MOVE_MIN_INTERVAL_MS", "// ── Resume tokens");
const boostConstants = ["COFFEE_MULT", "BOOST_GRACE_MS", "ROUND_KILLER_SPEED_MULT"]
  .map((name) => server.match(new RegExp(`^const ${name}\\s*=.*?;`, "m"))[0]).join("\n");
const state = between(server, "  let lastMoveAt = 0;", "  // Send the current announcement");
const revision = between(server, "function movementRevisionOf(", "// All positional broadcasts");
const correctLocal = between(neighborhood, "    correctLocal(serverPlayer) {", "    addRemote(");
const correctionListener = between(neighborhood, "  socket.on('playerMoveCorrection',", "  socket.on('playerLeft',");

function harness({ location = "office", legacy = false, arrivalOnly = false, latency = 0, stall = 0, jitter = () => 0 } = {}) {
  let now = 0, order = 0, wire = 0;
  const queue = [], corrections = [], applied = [], accepted = [], clientPackets = [], reliableEvents = [], arrivals = [];
  const handlers = {};
  const enqueue = (at, fn) => queue.push({ at, order: order++, fn });
  const player = {
    x: 150, y: 504,
    body: {},
  };
  // Capture the jump before setPosition, not after body.reset.
  player.setPosition = (x, y) => {
    if (x !== player.x || y !== player.y) applied.push({ at: now, dx: x - player.x });
    player.x = x; player.y = y;
  };
  player.body.reset = (x, y) => { player.x = x; player.y = y; };
  const me = { x: 150, y: 504, dir: "right", anim: "walk", locationId: location };
  const clientSocket = {
    connected: true,
    on(event, fn) { (handlers[event] ||= []).push(fn); },
    emit(event, payload) { reliableEvents.push({ event, payload }); send(event, payload); },
    volatile: { emit: (event, payload) => send(event, payload) },
  };
  function deliver(event, payload) { for (const fn of handlers[event] || []) fn(payload); }
  function send(event, payload) {
    const sampledAt = now;
    payload = { ...payload };
    if (legacy) delete payload.correctionId;
    if (legacy || arrivalOnly) delete payload.sampleTime;
    clientPackets.push({ at: now, event, payload });
    // A single TCP upstream stall: ordered release, no packet loss/reordering.
    const heldUntil = now >= 2000 && now < 2000 + stall ? 2000 + stall : now;
    wire = Math.max(wire, heldUntil + latency + jitter(now));
    enqueue(wire, () => {
      if (event === "playerMove") arrivals.push({ at: now, sent: sampledAt, x: payload.x, anchor: me.x });
      serverHandlers[event]?.(payload);
    });
  }
  const window = { document: { hidden: false }, performance: { now: () => now }, addEventListener() {} };
  vm.runInNewContext(helperSource, { window });
  const transport = window.JpoFocusedMovement.create(clientSocket);
  const scene = {
    player, location, _lastCorrectionSeq: -1,
    _isCurrentLocation: (p) => !p.location || p.location === scene.location,
  };
  scene.correctLocal = vm.runInNewContext(`({${correctLocal}}).correctLocal`, { window });
  window._phaserGame = { scene: { getScene: () => scene } };
  vm.runInNewContext(correctionListener, {
    window, socket: clientSocket, activeNeighborhood: () => scene.location === "office" ? null : scene,
  });
  const serverHandlers = {};
  const context = vm.createContext({
    socket: {
      id: "walker",
      on: (event, fn) => { serverHandlers[event] = fn; },
      emit(event, payload) {
        if (event === "playerMoveCorrection") corrections.push({ at: now, ...payload });
        enqueue(now + latency, () => deliver(event, payload));
      },
    },
    players: { walker: me },
    Date: { now: () => 10000 + Math.floor(now) },
    inspectMovementEnvelope, createMovementCorrectionFence,
    performanceReports: 0, performanceRejectedMoves: {}, performanceAcceptedMoves: 0,
    LT_METRICS: false, locationOf: (p) => p.locationId,
    phFrozen: () => false, rlglFrozen: () => false, rlglActiveRunner: () => false,
    isOfficePlayer: () => me.locationId === "office",
    // HQ open-floor fixture; neighborhood runs its real authored street checks.
    isUnpaintedPosition: () => false, WORLD_W: 10000, WORLD_H: 10000,
    parseLocation, locationFurnitureBlockers: () => [],
    streetWorld: streetDefinition([]),
    validStreetWorldMove, validContinuousStreetWorldMove, validLocationMove, validContinuousLocationMove,
    staticSeatForPoint, staticSeatStandCandidates,
    stopFurnitureActivity() {}, round: null, propHunt: null,
    rlglOnMove() {},
    movementPayload: (_id, p) => ({ ...p }),
    emitToLocation: (_location, _event, payload) => accepted.push({ at: now, ...payload }),
  });
  vm.runInContext(`${constants}\n${boostConstants}\n${revision}\n${state}\n${handler}`, context);
  return {
    player, me, scene, transport, clientSocket, context, corrections, applied, accepted, clientPackets, reliableEvents, arrivals,
    deliver, enqueue, direct: (payload) => serverHandlers.playerMove(payload),
    register(source, bindings) {
      Object.assign(context, bindings);
      vm.runInContext(source, context);
    },
    setTime(value) { now = value; },
    drain(until) {
      while (queue.length) {
        queue.sort((a, b) => a.at - b.at || a.order - b.order);
        if (queue[0].at > until) break;
        const event = queue.shift();
        now = event.at; event.fn();
      }
      now = until;
    },
  };
}

function walking({ hz, duration = 12000, ...options }) {
  const h = harness(options);
  let physicsTime = 0, direction = 1;
  const delta = 1000 / hz;
  for (let frame = 1; frame * delta <= duration; frame++) {
    h.enqueue(frame * delta, () => {
      // Stock Arcade 60Hz physics, rendered/sampled at the actual monitor Hz.
      // Synthetic integration isolates networking; this is not a Phaser E2E.
      physicsTime += delta;
      while (physicsTime + 1e-8 >= 1000 / 60) {
        if (h.player.x > 1300) direction = -1;
        if (h.player.x < 150) direction = 1;
        h.player.x += direction * 195 / 60;
        physicsTime -= 1000 / 60;
      }
      h.transport.tick(delta, h.scene.location, {
        x: h.player.x, y: h.player.y, dir: direction > 0 ? "right" : "left", anim: "walk",
      });
    });
  }
  h.drain(duration);
  return h;
}

// One short upstream disturbance used to leave a permanently oscillating
// prediction origin, even though every frame and every later packet is healthy.
const before = walking({ hz: 60, latency: 150, stall: 150, legacy: true });
assert(before.corrections.length > 20, "pre-fence protocol reproduces repeated rejection");
assert(before.corrections.some((p) => p.at > 8000), "feedback persists long after the sole stall ended");
assert(before.applied.length > 10, "rejections cause repeated visible body snaps, not just telemetry");
const after = walking({ hz: 60, latency: 150, stall: 150 });
const arrivalOnly = walking({ hz: 60, latency: 150, stall: 150, arrivalOnly: true });
assert.equal(arrivalOnly.corrections.length, 1, "arrival-only budget falsely rejects once even with the correction fence");
assert.equal(arrivalOnly.applied.length, 1);
assert.equal(after.corrections.length, 0, "server-backed sample time avoids the initial false rejection");
assert.equal(after.applied.length, 0, "no visible recovery needed");
assert(after.accepted.at(-1).at > 11900, "sustained walking resumes to the end of the trace");
console.log(`60Hz / 300ms RTT / one 150ms stall, 12s: pre-fence ${before.corrections.length}/${before.applied.length}; arrival-only ${arrivalOnly.corrections.length}/${arrivalOnly.applied.length}; sample-time ${after.corrections.length}/${after.applied.length} rejects/snaps`);
const rejectedAt = arrivalOnly.corrections[0].at;
const oldAnchor = arrivalOnly.accepted.filter((p) => p.at < rejectedAt).at(-1);
const rejectedArrival = arrivalOnly.arrivals.find((p) => p.at === rejectedAt);
const anchorArrival = arrivalOnly.arrivals.find((p) => p.at === oldAnchor.at && p.x === oldAnchor.x);
console.log(`Arrival-only first reject: ${Math.round(rejectedAt)}ms, ${rejectedArrival.x - oldAnchor.x}px, ${Math.round(rejectedAt - oldAnchor.at)}ms arrival interval vs ${Math.round(rejectedArrival.sent - anchorArrival.sent)}ms sample interval.`);
const lowLatencyBefore = walking({ hz: 60, latency: 50, stall: 100, legacy: true });
const lowLatencyAfter = walking({ hz: 60, latency: 50, stall: 100 });
assert(lowLatencyBefore.corrections.some((p) => p.at > 11000), "even a 100ms RTT can sustain the feedback");
assert.equal(lowLatencyAfter.corrections.length, 0);
console.log(`60Hz / 100ms RTT / one 100ms stall: before ${lowLatencyBefore.corrections.length} rejects / ${lowLatencyBefore.applied.length} snaps; after ${lowLatencyAfter.corrections.length} / ${lowLatencyAfter.applied.length}`);

let traces = 0;
for (const location of ["office", "neighborhood"]) {
  for (const hz of [60, 120, 144, 240]) {
    for (const latency of [0, 50, 150, 250]) {
      for (const stall of [0, 150, 300, 500]) {
        const h = walking({ location, hz, latency, stall });
        assert.equal(h.corrections.length, 0, `${location}/${hz}Hz/${latency}ms/${stall}ms has no false correction`);
        if (!stall) assert.equal(h.corrections.length, 0, "stock sustained walking is not rejected");
        assert(h.accepted.at(-1).at > 11900, "walking remains live");
        assert(!h.corrections.some((p) => p.reason !== "speed"), "the test trajectory stays on open floor");
        traces++;
      }
    }
  }
}
console.log(`PASS: ${traces} sustained HQ/neighborhood traces, 60/120/144/240Hz, 0–500ms RTT, 0–500ms one-time TCP stalls`);

// Repeated TCP bundling + ordinary variable one-way delay, not only one stall.
let jitterBaseline = 0, jitterFixed = 0, jitterTraces = 0;
for (const location of ["office", "neighborhood"]) {
  for (const hz of [60, 120, 144, 240]) {
    for (let seed = 1; seed <= 8; seed++) {
      const jitter = (time) => {
        const slot = Math.floor(time / 50);
        const noise = ((Math.imul(slot + seed, 1103515245) >>> 16) % 61);
        const phase = time % 2300;
        return noise + (phase >= 1600 && phase < 1850 ? 1850 - phase : 0);
      };
      const options = { location, hz, latency: 50, jitter };
      const baseline = walking({ ...options, arrivalOnly: true });
      const fixed = walking(options);
      jitterBaseline += baseline.applied.length;
      jitterFixed += fixed.applied.length;
      assert.equal(fixed.corrections.length, 0, `${location}/${hz}/${seed}: realistic ordered jitter has no false correction`);
      assert(fixed.accepted.at(-1).at > 11800);
      jitterTraces++;
    }
  }
}
console.log(`PASS: ${jitterTraces} repeated-jitter traces: arrival-only ${jitterBaseline} snaps; sample-time ${jitterFixed}`);

// Protocol boundaries, including older browsers and downgrade/forged acks.
const fence = createMovementCorrectionFence();
assert(fence.inspect({}, "office"));
assert.equal(fence.issue("office"), null, "old clients do not enter an unacknowledgeable fence");
assert(fence.inspect({ correctionId: 0 }, "office"));
assert.equal(fence.issue("office"), 1);
assert(!fence.inspect({ correctionId: 0 }, "office"));
assert(!fence.inspect({}, "office"), "negotiated clients cannot downgrade during recovery");
for (const correctionId of [-1, 0.5, "1", 2, NaN]) assert(!fence.inspect({ correctionId }, "office"));
assert(fence.inspect({ correctionId: 1 }, "office"));
assert(!fence.inspect({ correctionId: 0 }, "office"), "an old-origin sample stays inert after acknowledgement");
assert(fence.inspect({ correctionId: 0 }, "neighborhood"), "authoritative map change releases old-map fence");
assert.equal(fence.issue("neighborhood"), 2, "correction IDs never alias across maps");
assert(!fence.inspect({ correctionId: 1 }, "neighborhood"));
assert(fence.inspect({ correctionId: 2 }, "neighborhood"));
assert(fence.inspect({ correctionId: 2 }, "office"), "return travel remains usable");
assert(createMovementCorrectionFence().inspect({ correctionId: 0 }, "office"), "new socket starts fresh");

// Real handler: acknowledge does NOT increase a budget, waive geometry, or
// bypass inbound ordering. Wrong-map traffic cannot reset the current fence.
const guarded = harness();
const move = (seq, correctionId, x, location = "office", anim = "walk") =>
  ({ seq, correctionId, sampleTime: seq * 50, location, x, y: 504, dir: "right", anim });
guarded.setTime(50); guarded.direct(move(1, 0, 150));
guarded.setTime(100); guarded.direct(move(2, 0, 1000));
assert.equal(guarded.corrections.at(-1).reason, "speed");
guarded.setTime(150); guarded.direct(move(3, 0, 160, "neighborhood"));
guarded.direct(move(4, 0, 160));
assert.equal(guarded.me.x, 150, "in-flight positions cannot advance the correction anchor");
guarded.direct(move(5, 999, 160));
assert.equal(guarded.me.x, 150, "inventing an acknowledgement cannot release the fence");
guarded.setTime(200); guarded.direct(move(6, 1, 1000));
assert.equal(guarded.corrections.length, 2, "acknowledged teleport still fails unchanged speed budget");
assert(guarded.corrections[1].seq > guarded.corrections[0].seq,
  "another correction at an unchanged anchor has a fresh server revision");
guarded.setTime(250); guarded.direct(move(7, 2, 160));
assert.equal(guarded.me.x, 160);
guarded.setTime(300); guarded.direct(move(6, 2, 170));
assert.equal(guarded.me.x, 160, "inbound client sequence ordering remains enforced");
guarded.context.isUnpaintedPosition = () => true;
guarded.direct(move(8, 2, 170));
assert.equal(guarded.corrections.at(-1).reason, "collision", "acknowledgement never bypasses collision");
guarded.me.locationId = "neighborhood"; // authoritative transition/ejection
guarded.setTime(400); guarded.direct(move(9, 0, 170, "neighborhood"));
assert.equal(guarded.me.x, 170, "real handler releases an old map's pending fence");

// The transport consumes an old map's token but the actual correction consumer
// must not apply its position to the current map. Reliable events remain
// reliable; only walking samples use the volatile channel.
const boundaries = harness();
boundaries.deliver("playerMoveCorrection", { x: 900, y: 504, location: "neighborhood", seq: 5, correctionId: 1 });
assert.equal(boundaries.player.x, 150);
boundaries.transport.sendReliable("office", { x: 150, y: 504, anim: "sit" });
boundaries.transport.sendReliableEvent("locationTransition", "office", { destination: "neighborhood" });
boundaries.transport.sendReliableEvent("furnitureInteract", "office", { phase: "exit" });
assert.equal(boundaries.reliableEvents.length, 3, "seat/portal/furniture intents are not made volatile or buffered locally");
assert(boundaries.reliableEvents.every(({ payload }) => payload.correctionId === 1));
boundaries.clientSocket.connected = false;
boundaries.deliver("disconnect");
assert.equal(boundaries.transport.sendPeriodic("office", { x: 150, y: 504 }), false);
boundaries.clientSocket.connected = true;
boundaries.transport.sendPeriodic("office", { x: 150, y: 504 });
assert.equal(boundaries.clientPackets.at(-1).payload.correctionId, 0, "reused client helper resets ack on reconnect");
assert.equal(boundaries.transport.tick(49, "office", { x: 150, y: 504 }), false, "reconnect clears cadence");

// Reliable seat snaps still receive their original (cooldown-gated) allowance
// AFTER correction receipt; stale reliable coordinates cannot undo an anchor.
const seat = harness();
seat.setTime(50); seat.direct(move(1, 0, 150));
seat.setTime(100); seat.direct(move(2, 0, 1000));
seat.setTime(150); seat.direct(move(3, 0, 250, "office", "sit"));
assert.equal(seat.me.x, 150, "pre-correction reliable coordinates are fenced too");
seat.direct(move(4, 1, 250, "office", "sit"));
assert.equal(seat.me.x, 250, "acknowledged seat snap retains its normal allowance");
// Dedicated portal/furniture handlers keep their existing authoritative
// validation, rather than inheriting the walking fence.
const portalHandler = between(server, '  socket.on("locationTransition",', '  socket.on("furnitureInteract",');
const portal = harness({ location: "neighborhood", latency: 150 });
portal.me.x = portal.player.x = 48; // real HQ return trigger on the street
let travelled = 0;
portal.register(portalHandler, {
  transitionTo: async (destination) => {
    // The transport test uses the real portal predicate, not DB/scene services.
    assert(portalForTransition(portal.me.locationId, destination, portal.me.x, portal.me.y));
    portal.me.locationId = destination;
    Object.assign(portal.me, locationSpawn(parseLocation(destination)));
    travelled++;
    return true;
  },
});
portal.transport.sendPeriodic("neighborhood", { x: 48, y: 504 });
portal.setTime(50); portal.transport.sendPeriodic("neighborhood", { x: 1000, y: 504 });
portal.setTime(100);
portal.transport.sendReliableEvent("locationTransition", "neighborhood", { destination: "office" });
portal.drain(250);
assert.equal(portal.corrections.length, 1);
assert.equal(travelled, 1, "reliable portal request is processed while correction is still in flight");
assert.equal(portal.me.locationId, "office");

const furnitureHandler = between(server, '  socket.on("furnitureInteract",', '  socket.on("');
const furniture = harness({ location: "home:resident@example.com", latency: 150 });
furniture.me.email = "resident@example.com";
let stood = 0;
furniture.register(furnitureHandler, {
  isHuddleTestIdentity: () => false, takeToken: () => true, interactBucket: {},
  stopFurnitureActivity: () => { delete furniture.me.activity; stood++; },
});
furniture.transport.sendPeriodic(furniture.scene.location, { x: 150, y: 504 });
furniture.setTime(50); furniture.transport.sendPeriodic(furniture.scene.location, { x: 700, y: 504 });
furniture.drain(200);
assert.equal(furniture.corrections.length, 1);
furniture.me.activity = { instanceId: "chair-1", action: "sit" };
furniture.transport.sendReliableEvent("furnitureInteract", furniture.scene.location, { phase: "exit" });
furniture.drain(350);
assert.equal(stood, 1, "reliable furniture exit is processed while walking recovery is fenced");
console.log("PASS: unchanged anti-cheat, old-client compatibility, map/reconnect boundaries, reliable action contracts");

// Untrusted client time is an allocation hint, never authority to create time.
// Exercise the actual handler with intentionally slow/fast/reversed clocks.
let exploitTraces = 0;
for (const scale of [0, 0.1, 1, 10, 1e9, -1, NaN, undefined]) {
  for (const speed of [600, 1000, 5000]) {
    const h = harness();
    h.setTime(50); h.direct(move(1, 0, 150));
    for (let seq = 2; seq <= 200; seq++) {
      h.setTime(seq * 50);
      const packet = move(seq, h.corrections.at(-1)?.correctionId || 0, h.me.x + speed * 0.05);
      if (scale === undefined) delete packet.sampleTime;
      else packet.sampleTime = seq * 50 * scale;
      h.direct(packet);
    }
    assert(h.corrections.some((p) => p.reason === "speed"), `speed ${speed}, clock ${scale}: cheating rejected`);
    const distance = h.me.x - 150;
    // Existing policy: 312px/s + at most 12px per accepted sample.
    assert(distance <= 312 * 9.95 + 12 * (h.accepted.length - 1), "no extra aggregate movement budget");
    exploitTraces++;
  }
}

// The arrival credit is earned only by an under-used server interval; ordinary
// slower walking/standing must NOT build a reservoir of spare speed tolerance.
const slow = harness();
for (let seq = 1; seq <= 100; seq++) {
  slow.setTime(seq * 50);
  slow.direct(move(seq, 0, 150 + seq * 2));
}
assert.equal(vm.runInContext("movementSample.credit", slow.context), 0, "healthy slow samples bank no distance/time");
slow.setTime(5050); slow.direct(move(101, 0, slow.me.x + 100));
assert.equal(slow.corrections.at(-1).reason, "speed", "a short teleport after slow walking is still rejected");

const capped = harness();
capped.setTime(50); capped.direct(move(1, 0, 150));
capped.setTime(10050); capped.direct(move(2, 0, 150));
assert.equal(vm.runInContext("movementSample.credit", capped.context), 1450, "long stall credit shares the existing 1500ms cap");
capped.setTime(10100);
capped.direct({ ...move(3, 0, 631), sampleTime: 1e12 });
assert.equal(capped.corrections.at(-1).reason, "speed", "forged clock cannot exceed original 480px maximum even after ten seconds idle");
assert.equal(vm.runInContext("movementSample", capped.context), null, "rejection discards saved time");

// Deliberately under-report elapsed, spend all accumulated time in a burst,
// rewind/omit the clock, then repeat. None may mint a server millisecond or
// multiply fixed slack by the number of throttled packets.
const clockAttack = harness();
clockAttack.context.WORLD_W = 100000;
clockAttack.setTime(50); clockAttack.direct(move(1, 0, 150));
let claimedTime = 50, attackDistance = 0, attackAccepted = 0;
for (let seq = 2; seq <= 600; seq++) {
  const burst = seq % 30 === 0;
  const amount = burst ? 400 : 10;
  claimedTime += burst ? 100000 : 1;
  const packet = { ...move(seq, clockAttack.corrections.at(-1)?.correctionId || 0, clockAttack.me.x + amount), sampleTime: claimedTime };
  if (seq % 71 === 0) packet.sampleTime = -10;
  if (seq % 97 === 0) delete packet.sampleTime;
  clockAttack.setTime(seq * 50);
  const previousX = clockAttack.me.x;
  clockAttack.direct(packet);
  if (clockAttack.me.x !== previousX) {
    attackDistance += Math.abs(clockAttack.me.x - previousX);
    attackAccepted++;
  }
  assert(attackDistance <= 312 * (seq - 1) * 0.05 + 12 * attackAccepted + 1e-8,
    "slow/fast/rewound/missing clocks cannot increase cumulative server speed allowance");
  const ledger = vm.runInContext("movementSample", clockAttack.context);
  // This flood is below the 33ms arrival gate and must never alter the ledger.
  clockAttack.direct({ ...packet, seq: seq + 10000, x: clockAttack.me.x + 1, sampleTime: 1e12 });
  assert.equal(vm.runInContext("movementSample", clockAttack.context), ledger, "throttled packets spend/mint no time");
}

// Collision/path validation precedes time allocation; credit never licenses a
// wall crossing or an invalid endpoint, even with valid timestamps and enough time.
for (const [x, reason] of [[300, "collision"], [350, "path"]]) {
  const h = harness({ location: "neighborhood" });
  h.setTime(50); h.direct(move(1, 0, 250, "neighborhood"));
  h.context.locationFurnitureBlockers = () => [{ x: 290, y: 470, width: 20, height: 70 }];
  h.setTime(1050); h.direct(move(2, 0, x, "neighborhood"));
  assert.equal(h.corrections.at(-1).reason, reason);
  assert.equal(h.me.x, 250);
}

// An authoritative same-map teleport must invalidate the old sample anchor,
// just as a map change does (dedicated actions retain their original handlers).
const relocated = harness();
relocated.setTime(50); relocated.direct(move(1, 0, 150));
relocated.setTime(550); relocated.direct(move(2, 0, 160));
assert(vm.runInContext("movementSample.credit", relocated.context) > 0);
relocated.me.x = 700;
relocated.setTime(600); relocated.direct({ ...move(3, 0, 800), sampleTime: 600 });
assert.equal(relocated.corrections.at(-1).reason, "speed", "authoritative anchor change cannot reuse old time credit");
console.log(`PASS: ${exploitTraces} slow/fast/invalid-clock exploit traces + 599 bank/spend/flood attempts, bounded idle credit, forced teleports, collision/path and authoritative anchor guards`);