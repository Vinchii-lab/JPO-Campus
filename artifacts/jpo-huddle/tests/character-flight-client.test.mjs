import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { WING_FLIGHT_SPEEDS } from "../flight-rules.mjs";
const source = fs.readFileSync(new URL("../public/character-flight.js", import.meta.url), "utf8");

function setup() {
  const handlers = {}, keys = {}, sent = [], win = {};
  let blocked = false;
  const context = {
    window: win, performance: { now: () => 1000 }, setInterval: () => 0,
    document: { activeElement: null, getElementById: () => null,
      addEventListener: (key, fn) => { keys[key] = fn; } },
  };
  vm.runInNewContext(source, context);
  const api = win.JpoCharacterFlight;
  api.init({ id: "self", connected: true,
    on: (name, fn) => { handlers[name] = fn; }, emit: (...args) => sent.push(args) },
  { getWings: () => "goldenwings", ready: () => true, blocked: () => blocked, gameLock: () => blocked });
  return { api, handlers, keys, sent, context, block: () => { blocked = true; } };
}

test("client tiers match server, Space toggles but typing and games do not consume it", () => {
  const s = setup();
  assert.deepEqual(JSON.parse(JSON.stringify(s.api.MULT)), WING_FLIGHT_SPEEDS);
  const event = { code: "Space", preventDefault() { this.prevented = true; } };
  s.context.document.activeElement = { tagName: "INPUT" };
  s.keys.keydown(event);
  assert.equal(s.sent.length, 0);
  s.context.document.activeElement = null;
  s.block();
  s.keys.keydown(event);
  assert.equal(s.sent.length, 0);
  assert.equal(event.prevented, undefined);
  const open = setup();
  open.keys.keydown(event);
  assert.equal(open.sent[0][0], "flightToggle");
  assert.equal(open.sent[0][1].flying, true);
  assert.equal(event.prevented, true);
  open.handlers.flightState({ id: "self", flying: true, multiplier: 2 });
  assert.equal(open.api.selfMultiplier(), 2);
  open.keys.keydown(event);
  assert.equal(open.sent.at(-1)[1].flying, false);
});

test("steering ramps up, stays capped and brakes; disconnect forgets flight", () => {
  const s = setup();
  s.handlers.flightState({ id: "self", flying: true, multiplier: 2 });
  let v = { x: 0, y: 0 };
  for (let i = 0; i < 100; i++) v = s.api.steer(v, { x: 390, y: 0 }, 16);
  assert.ok(v.x > 380 && v.x <= 390);
  for (let i = 0; i < 100; i++) v = s.api.steer(v, { x: 0, y: 0 }, 16);
  assert.equal(v.x, 0);
  s.handlers.disconnect();
  assert.equal(s.api.isSelfFlying(), false);
  assert.equal(s.api.selfMultiplier(), 1);
});

test("render lift restores sprite coordinates exactly and never moves ground shadow", () => {
  const s = setup(), events = {};
  s.handlers.flightState({ id: "self", flying: true, multiplier: 2 });
  function obj(x = 100, y = 100) {
    return { x, y, active: true, visible: true, depth: 4,
      setPosition(x, y) { this.x=x; this.y=y; return this; },
      setScale() { return this; }, setAlpha(value) { this.alpha=value; return this; },
      setVisible() { return this; }, setDepth() { return this; },
      destroy() { this.destroyed=true; } };
  }
  let shadow;
  const scene = {
    sys: { isActive: () => true }, game: { loop: { delta: 16 } },
    textures: { exists: () => true }, tweens: { getTweensOf: () => [] },
    add: { ellipse: () => (shadow=obj()) },
    children: { moveBelow() {} },
    events: { on: (name, fn) => { events[name]=fn; },
      once: (name, fn) => { events[name]=fn; }, off() {} },
  };
  const sprite = Object.assign(obj(), { texture: { key: "native" }, frame: { name: 18 },
    anims: { isPlaying: false }, setTexture() {}, setFlipX() {} });
  const name = obj(100, 60);
  s.api.attachScene(scene, () => [{ id:"self", sprite, dir:"down", texKey:"native", parts:[name] }],
    { bodyDy:27, dirStart:{down:18} });
  for (let i=0; i<60; i++) {
    events.prerender();
    assert.ok(sprite.y < 100);
    assert.equal(shadow.y, 131);
    assert.ok(shadow.alpha >= 0.55 && shadow.alpha <= 0.65);
    assert.ok(Math.abs(name.y-sprite.y+40) < 1e-10);
    events.render();
    assert.equal(sprite.y, 100);
    assert.equal(name.y, 60);
  }
  events.shutdown();
  assert.equal(shadow.destroyed, true);
});
