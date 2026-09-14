// Focused, headless regression for the shared outside-HQ seated renderer.
// This intentionally exercises the real NeighborhoodScene methods without
// starting Phaser, a browser, a workflow, or a network server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Emitter {
  constructor() { this.listeners = new Map(); }
  on(name, fn) {
    const list = this.listeners.get(name) || [];
    list.push(fn);
    this.listeners.set(name, list);
  }
}

class Node {
  constructor() {
    this.hidden = false;
    this.style = { setProperty() {} };
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  appendChild() {}
  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
  querySelector() { return new Node(); }
}

class Scene {
  constructor(key) {
    this.scene = { key, isActive: () => false };
    this.events = new Emitter();
  }
}

class Socket {
  on() {}
  emit() {}
}

const source = fs.readFileSync(
  path.join(__dirname, '../../public/neighborhood.js'),
  'utf8',
);
const document = {
  body: new Node(),
  activeElement: { tagName: 'BODY' },
  createElement: () => new Node(),
  getElementById: () => null,
};
const context = {
  console,
  document,
  localStorage: { getItem: () => null, setItem() {} },
  getComputedStyle: () => ({ display: 'none' }),
  requestAnimationFrame: (fn) => fn(),
  ResizeObserver: class { observe() {} },
  MutationObserver: class { observe() {} },
  performance: { now: () => 1000 },
  setTimeout,
  clearTimeout,
  window: null,
  Phaser: {
    Scene,
    Scenes: { Events: { SHUTDOWN: 'shutdown', CREATE: 'create', WAKE: 'wake' } },
  },
};
context.window = context;
context.window.addEventListener = () => {};
context.window.matchMedia = () => ({ matches: false });
context.window.JpoFocusedMovement = null;
context.window.initHouseColors = null;
vm.createContext(context);
new vm.Script(source, { filename: 'public/neighborhood.js' }).runInContext(context);
context.window.initNeighborhoodUI(new Socket(), () => ({
  DIR_START: { right: 0, up: 6, left: 12, down: 18 },
}));

const scene = new context.window.NeighborhoodScene();
const animations = new Map();
scene.anims = {
  exists: (key) => animations.has(key),
};
scene.tweens = { killTweensOf() {}, remove() {} };
scene.playerTexKey = 'pl_adam';

class Sprite {
  constructor() {
    this.anims = {
      currentAnim: null,
      isPlaying: false,
      stop: () => { this.anims.isPlaying = false; },
    };
    this.played = [];
    this.texture = null;
    this.frame = null;
    this.flipX = false;
  }
  setAngle(value) { this.angle = value; return this; }
  setScale(value) { this.scale = value; return this; }
  setFlipX(value) { this.flipX = value; return this; }
  setTexture(value) { this.texture = value; return this; }
  setFrame(value) { this.frame = value; return this; }
  setDepth(value) { this.depth = value; return this; }
  setPosition(x, y) { this.x = x; this.y = y; return this; }
  play(key) {
    this.played.push(key);
    this.anims.currentAnim = { key };
    this.anims.isPlaying = true;
    return this;
  }
}

const sprite = new Sprite();
const entry = { sprite, playerTexKey: 'pl_adam', _activityAction: 'sit' };
const sitKey = (direction) => `sit_pl_adam_${direction}`;

for (const [direction, expectedSheet, expectedFlip] of [
  ['right', 'right', false],
  ['up', 'up', false],
  ['left', 'right', true],
  ['down', 'down', false],
]) {
  const key = sitKey(expectedSheet);
  animations.clear();
  animations.set(key, true);
  sprite.played = [];
  sprite.anims.currentAnim = null;
  sprite.anims.isPlaying = false;
  scene._applyActivityPose(entry, { action: 'sit' }, direction);
  assert.deepEqual(sprite.played, [key], `${direction} uses the authored seated sheet`);
  assert.equal(sprite.flipX, expectedFlip, `${direction} applies only the left mirror`);
}

// stop()/setTexture() leave Phaser's currentAnim key stale. A re-sit must
// restart the animation even when that key still matches.
animations.clear();
animations.set(sitKey('down'), true);
sprite.played = [];
sprite.anims.currentAnim = { key: sitKey('down') };
sprite.anims.isPlaying = false;
scene._applyActivityPose(entry, { action: 'sit' }, 'down');
assert.deepEqual(sprite.played, [sitKey('down')], 'stale seated key is replayed when stopped');

// Once active, a park-seat update must not set the run texture again. Phaser's
// animation state owns the seated texture and advances it on the next tick.
sprite.texture = 'pl_sit_down_adam';
sprite.played = [];
sprite.anims.currentAnim = { key: sitKey('down') };
sprite.anims.isPlaying = true;
assert.equal(animations.has(sitKey('down')), true, 'active sit animation remains registered');
scene._applyActivityPose(entry, { action: 'sit' }, 'down');
assert.equal(sprite.texture, 'pl_sit_down_adam', 'active sit updates do not reset the texture');
assert.deepEqual(sprite.played, [], 'active sit updates do not restart the animation');

// If an optional seated texture is unavailable, never leave a stale sit
// texture/frame visible; use the current directional run frame instead.
animations.clear();
sprite.texture = 'pl_sit_old';
sprite.frame = 0;
sprite.flipX = true;
sprite.anims.currentAnim = { key: sitKey('down') };
sprite.anims.isPlaying = true;
scene._applyActivityPose(entry, { action: 'sit' }, 'left');
assert.equal(sprite.texture, 'pl_adam', 'sit fallback restores the run texture');
assert.equal(sprite.frame, 12, 'sit fallback preserves the requested facing');
assert.equal(sprite.flipX, false, 'sit fallback does not mirror a run frame');
assert.equal(sprite.anims.isPlaying, false, 'sit fallback stops stale animation state');

// Standing up also restores the canonical run texture before selecting its
// frame, so a home action and a public-seat state cannot poison the next sit.
scene._applyActivityPose(entry, null, 'up');
assert.equal(sprite.texture, 'pl_adam', 'stand restores the run texture');
assert.equal(sprite.frame, 6, 'stand preserves the last authoritative direction');
assert.equal(sprite.anims.isPlaying, false, 'stand stops the seated animation');

// Public-seat state still owns coordinates and the authored exit point; pose
// selection must not alter either value.
scene.seats = [{
  id: 'park-left',
  x: 240,
  y: 336,
  dir: 'left',
  stand: { x: 240, y: 272, dir: 'down' },
}];
scene.player = sprite;
sprite.setPosition = function(x, y) { this.x = x; this.y = y; return this; };
sprite.body = {
  enable: true,
  reset(x, y) { this.resetX = x; this.resetY = y; },
};
scene._activityAction = 'sit';
animations.set(sitKey('right'), true);
scene._setParkSeatState({
  seated: true, seatId: 'park-left', x: 240, y: 336, dir: 'left',
});
assert.deepEqual(
  { x: scene.staticSeatState.x, y: scene.staticSeatState.y, dir: scene.playerDir },
  { x: 240, y: 336, dir: 'left' },
  'public seat keeps authoritative position and direction',
);
assert.equal(sprite.body.enable, false, 'public seat freezes the local body');
assert.equal(sprite.played.at(-1), sitKey('right'), 'public left seat uses the mirrored right sheet');
scene._setParkSeatState({
  seated: false, x: 240, y: 272, dir: 'down',
});
assert.equal(scene.staticSeatState, null, 'public seat clears seated state');
assert.deepEqual({ x: sprite.x, y: sprite.y }, { x: 240, y: 272 }, 'server exit position is preserved');
assert.equal(sprite.body.enable, true, 'public seat re-enables the local body');

// Remote home/public updates use the same pose path. Their ordinary idle
// branch must restore the canonical texture after a left-facing seated update.
const remoteSprite = new Sprite();
const remote = {
  sprite: remoteSprite,
  texture: 'pl_alex',
  playerTexKey: 'pl_alex',
  _activityAction: 'sit',
};
animations.set('sit_pl_alex_right', true);
scene._applyRemote(remote, { x: 80, y: 96, dir: 'left', anim: 'sit' });
assert.equal(remoteSprite.flipX, true, 'remote left-facing seat mirrors the right sheet');
remoteSprite.texture = 'pl_sit_right_alex';
scene._applyRemote(remote, { x: 84, y: 100, dir: 'left', anim: 'sit' });
assert.equal(remoteSprite.texture, 'pl_sit_right_alex', 'remote sit packets preserve the seated texture');
scene._applyRemote(remote, { x: 112, y: 144, dir: 'left', anim: 'idle' });
assert.equal(remoteSprite.texture, 'pl_alex', 'remote stand restores its canonical texture');
assert.equal(remoteSprite.frame, 12, 'remote stand restores its directional run frame');
assert.equal(remoteSprite.flipX, false, 'remote stand clears the seated mirror');

assert(!source.includes("parkSeated || this._parkSeatPending === 'stand'"),
  'confirmed sit must not display a pending standing label');
console.log('PASS: outside-HQ directional sit sheets, stale animation reset, seat authority, and stand hint');