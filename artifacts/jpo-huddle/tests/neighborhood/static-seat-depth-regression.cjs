const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../../public/neighborhood.js'), 'utf8');
function methods(first, next) {
  const start = source.indexOf(`    ${first}(`);
  const end = source.indexOf(`\n    ${next}(`, start);
  assert(start >= 0 && end > start);
  return source.slice(start, end);
}
const Scene = vm.runInNewContext(`class Scene {
  ${methods('_floorDepth', '_interiorObjectNeedsOccluder')}
  ${methods('_setParkSeatState', '_nearbyParkSeat')}
}; Scene`, {
  finiteDepth: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
  INTERIOR_DEPTH: { SEATED_ACTOR_BIAS: 0.005 },
});
function sprite(x = 120, y = 80) {
  return {
    x, y, body: { enable: true, reset() {} },
    setPosition(x, y) { this.x = x; this.y = y; return this; },
    setDepth(depth) { this.depth = depth; return this; },
    setData() {},
  };
}
function scene() {
  const result = new Scene();
  result.player = sprite();
  result.seats = [{ id: 'cafe-pad', x: 120, y: 80, depthAnchor: 144 }];
  result._applyActivityPose = () => {};
  result._parkSeatStand = () => ({ x: 120, y: 170 });
  return result;
}
function depth(scene, entry, actor) {
  scene._setActorDepth(actor, scene._activityDepthAnchor(entry, actor.y), scene._activityDepthBias(entry));
  return actor.depth;
}

test('local admission and frame sorting use authored floor depth; stand restores pivot Y', () => {
  const s = scene();
  s._setParkSeatState({ seated: true, seatId: 'cafe-pad', x: 120, y: 80 });
  assert.equal(s.player.depth, 144.005);
  for (let frame = 0; frame < 5; frame++) assert.equal(depth(s, s, s.player), 144.005);
  // The local wearable adapter passes a wrapper rather than the scene itself.
  assert.equal(s._activityDepthAnchor({ sprite: s.player, activity: null }, 80), 144);
  s._setParkSeatState({ seated: false, x: 120, y: 170 });
  assert.equal(s.player.depth, 170);
  s.player.y = 190;
  assert.equal(depth(s, s, s.player), 190);
});

test('remote seated frames retain metadata and standing/walking returns to normal depth', () => {
  const s = scene();
  const remote = { sprite: sprite(), nameTag: sprite(), activity: { action: 'sit' } };
  s.remotes = { observer: remote };
  // Execute the production per-frame static-seat branch, not a copied approximation.
  const start = source.indexOf('      for (const remote of Object.values(this.remotes)) {', source.indexOf('const localDepthAnchor'));
  const end = source.indexOf('        if (remote._activityFx)', start);
  assert(start >= 0 && end > start);
  const tick = vm.runInNewContext(`(function () { ${source.slice(start, end)} } })`);
  for (let frame = 0; frame < 5; frame++) {
    remote.sprite.depth = -1;
    tick.call(s);
    assert.equal(remote.sprite.depth, 144.005);
    assert.equal(remote.nameTag.depth, 146.005);
  }
  remote.activity = null;
  assert.equal(depth(s, remote, remote.sprite), 80);
  remote.sprite.y = 180;
  assert.equal(depth(s, remote, remote.sprite), 180);
});

test('seat ID wins, exact coordinates work, near coordinates never borrow depth', () => {
  const s = scene();
  const remote = { sprite: sprite(121, 80), activity: { action: 'sit', seatId: 'cafe-pad' } };
  assert.equal(depth(s, remote, remote.sprite), 144.005);
  delete remote.activity.seatId;
  assert.equal(depth(s, remote, remote.sprite), 80);
  remote.activity.x = 120;
  remote.activity.y = 80;
  assert.equal(depth(s, remote, remote.sprite), 144.005);
  s.seats[0].depthBias = 0.002;
  assert.equal(depth(s, remote, remote.sprite), 144.002);
  s.seats[0].depthBias = NaN;
  assert.equal(depth(s, remote, remote.sprite), 144.005);
});

test('missing/nonfinite metadata preserves local and remote outdoor behavior', () => {
  const s = scene();
  s.staticSeatState = { seatId: 'cafe-pad', x: 120, y: 80 };
  const remote = { sprite: sprite(), activity: { action: 'sit' } };
  for (const anchor of [undefined, NaN, Infinity, '144']) {
    s.seats[0].depthAnchor = anchor;
    s.seats[0].depthBias = 50;
    assert.equal(depth(s, s, s.player), 80);
    assert.equal(depth(s, remote, remote.sprite), 80);
  }
});

test('home oak chair keeps furniture floor anchor, including stale local static state', () => {
  const s = scene();
  s.staticSeatState = { seatId: 'cafe-pad', x: 120, y: 80 };
  const furniture = {
    depth: 200,
    getData(key) { return key === 'floorAnchor' ? 200 : key === 'occluderParts' ? [{}] : null; },
  };
  s.activity = { action: 'sit', instanceId: 'home-oak-chair' };
  s._activityFurnitureSprite = furniture;
  assert.equal(depth(s, s, s.player), 200.005);
  const remote = { sprite: sprite(), activity: s.activity, _activityFurnitureSprite: furniture };
  assert.equal(depth(s, remote, remote.sprite), 200.005);
  remote._activityFurnitureSprite = null;
  assert.equal(depth(s, remote, remote.sprite), 80);
});