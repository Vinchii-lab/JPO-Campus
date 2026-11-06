import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { WING_FLIGHT_SPEEDS, ownedWingFlightSpeed, flightDeniedReason } from "../flight-rules.mjs";

test("fixed price tiers include every wing, owned seasonal wings and zero-price Phoenix", () => {
  const expected = { fairywings: 1.15, beewings: 1.25, batwings: 1.35,
    butterflywings: 1.45, snowflakewings: 1.55, angelwings: 1.65,
    devilwings: 1.65, jetpackwings: 1.85, goldenwings: 2, phoenixwings: 2.1 };
  assert.deepEqual(WING_FLIGHT_SPEEDS, expected);
  for (const [wings, speed] of Object.entries(expected)) {
    const p = { wings, cosmetics: [wings], anim: "idle" };
    assert.equal(ownedWingFlightSpeed(p), speed);
    assert.equal(flightDeniedReason(p), null);
    assert.equal(ownedWingFlightSpeed({ ...p, cosmetics: [] }), 1);
  }
  assert.equal(ownedWingFlightSpeed({ wings: "__proto__", cosmetics: ["__proto__"] }), 1);
  assert.equal(ownedWingFlightSpeed({ wings: "goldenwings", cosmetics: {} }), 1);
});

test("games, seats, homes and exercise never grant flight", () => {
  const p = { wings: "goldenwings", cosmetics: ["goldenwings"], anim: "idle" };
  for (const flags of [{ competitive: true }, { privateRoom: true }, { exercising: true }]) {
    assert.ok(flightDeniedReason(p, flags));
  }
  assert.ok(flightDeniedReason({ ...p, anim: "sit" }));
  assert.ok(flightDeniedReason({ ...p, activity: { kind: "work" } }));
  assert.ok(flightDeniedReason(null));
  assert.equal(ownedWingFlightSpeed({ ...p, price: 999999, multiplier: 99 }), 2);
});

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
test("toggle handler ignores client speed, rejects unowned wings, and always acknowledges", () => {
  const start = server.indexOf("  let lastFlightToggleAt = 0;");
  const end = server.indexOf('  socket.on("playerMove"', start);
  let handler, result;
  const players = { test: { wings: "phoenixwings", cosmetics: [], anim: "idle" } };
  const context = {
    players, Date: { now: () => 1000 }, ownedWingFlightSpeed,
    socket: { id: "test", on: (name, fn) => { handler = fn; }, emit() {} },
    locationOf: () => "office",
    flightRestriction: (_, p) => flightDeniedReason(p),
    setPlayerFlight: (...args) => { result = args; },
  };
  vm.runInNewContext(server.slice(start, end), context);
  handler({ flying: true, multiplier: 1000 });
  assert.equal(result[1], false);
  assert.ok(result[2]);
  context.Date.now = () => 2000;
  players.test.cosmetics = ["phoenixwings"];
  handler({ flying: true, multiplier: 1000 });
  assert.equal(result[1], true);
  context.Date.now = () => 3000;
  handler({ flying: false });
  assert.equal(result[1], false);
});

test("snapshots filter private landing-budget state and sanitize flight eligibility", () => {
  const start = server.indexOf("function movementPayload(");
  const end = server.indexOf("\nfunction flightCompetition(", start);
  const payload = vm.runInNewContext(`(${server.slice(start, end)})`, {
    locationOf: () => "office", movementRevisionOf: () => 5,
    flightRestriction: (_, p) => flightDeniedReason(p, { competitive: !!p.competitive }),
  });
  const p = { x: 20, y: 30, wings: "goldenwings", cosmetics: ["goldenwings"],
    flying: true, flightGraceUntil: 9999, flightLastMult: 2 };
  const visible = payload("a", p);
  assert.equal(visible.flying, true);
  assert.equal(visible.x, 20);
  assert.equal(visible.flightLastMult, undefined);
  assert.equal(visible.flightGraceUntil, undefined);
  assert.equal(payload("a", { ...p, competitive: true }).flying, false);
});

test("flight stays ephemeral and movement expands only from server-owned wing tiers", () => {
  assert.match(server, /movementRevision: 0,\s*flying: false/);
  assert.match(server, /const flightMult = me.flying \? ownedWingFlightSpeed\(me\)/);
  assert.match(server, /if \(!flightCompetition\(socket.id\)\)/);
  assert.match(server, /mult = Math.max\(mult, flightMult\)/);
});
