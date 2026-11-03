import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
function extract(name, end) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf(end, start));
}
const spawn = { x: 1272, y: 2253, dir: "down" };
const rowToState = vm.runInNewContext(
  `(${extract("rowToPlayerState", "\n// ── Shared City")})`,
  { LOCATIONS: { office: { spawn } } },
);

test("saved map and seated position survive a fresh process with no grace state", () => {
  for (const locationId of ["office", "city", "neighborhood"]) {
    const state = rowToState({ last_position: {
      locationId, x: 720, y: 880, dir: "left", anim: "sit",
    } });
    assert.equal(state.locationId, locationId);
    assert.equal(state.x, 720);
    assert.equal(state.y, 880);
    assert.equal(state.dir, "left");
    assert.equal(state.anim, "sit");
  }
});

test("legacy, malformed and private-home coordinates never become HQ coordinates", () => {
  for (const last_position of [null, { locationId: "office", x: "bad", y: 10 },
    { locationId: "home:someone", x: 50, y: 50 }]) {
    const state = rowToState({ x: 99, y: 99, last_position });
    assert.equal(state.locationId, "office");
    assert.equal(state.x, spawn.x);
    assert.equal(state.y, spawn.y);
    assert.equal(state.anim, "idle");
  }
});

test("checkpoint writes tagged pose and guards against older writes overtaking it", async () => {
  let call;
  const save = vm.runInNewContext(
    `(${extract("saveLastPosition", "\nfunction emitToLocation")})`,
    { locationOf: p => p.locationId, durableAnimFor: p => p.anim,
      pool: { query: (...args) => { call = args; return Promise.resolve(); } } },
  );
  await save({ email: "test@example.invalid", locationId: "office",
    x: 720, y: 880, dir: "up", anim: "sit" });
  const saved = JSON.parse(call[1][1]);
  assert.equal(saved.locationId, "office");
  assert.equal(saved.x, 720);
  assert.equal(saved.anim, "sit");
  assert.match(call[0], /savedAt.*<= \$3/);
});

test("authenticated live replacement retains HQ position before deleting old socket", () => {
  const players = { old: { email: "test@example.invalid", locationId: "office",
    x: 720, y: 880, dir: "up", anim: "sit" } };
  const noop = () => {};
  const drop = vm.runInNewContext(
    `(${extract("dropLiveByEmail", "\n// Cancel a pending grace")})`, {
      players, pending: {}, liveSocketsForEmail: () => ["old"],
      forfeitMatchForLeave: noop, petBattleForfeitForLeave: noop,
      roundDeferLeave: () => true, roundHandleLeave: noop, rlglHandleLeave: noop,
      locationOf: p => p.locationId, saveLastPosition: () => Promise.resolve(),
      emitToLocation: noop, io: { sockets: { sockets: new Map() } }, console,
    });
  const snapshot = drop("test@example.invalid", "new", true);
  assert.equal(snapshot.x, 720);
  assert.equal(snapshot.anim, "sit");
  assert.equal(snapshot.locationId, "office");
  assert.equal(players.old, undefined);
});
