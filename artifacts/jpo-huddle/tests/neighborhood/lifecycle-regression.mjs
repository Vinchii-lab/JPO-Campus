// Deterministic browser-lifecycle regression. This deliberately does not load
// Phaser or a browser: the small VM harness models the SceneManager queue and
// Scene lifecycle events that used to expose an uncaught TypeError.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

class Emitter {
  constructor() { this.handlers = new Map(); }
  on(name, fn) {
    const list = this.handlers.get(name) || [];
    list.push(fn);
    this.handlers.set(name, list);
    return this;
  }
  once(name, fn) {
    const wrapped = (...args) => {
      this.off(name, wrapped);
      fn(...args);
    };
    wrapped._original = fn;
    return this.on(name, wrapped);
  }
  off(name, fn) {
    const list = this.handlers.get(name) || [];
    this.handlers.set(name, list.filter((candidate) => candidate !== fn && candidate._original !== fn));
    return this;
  }
  emit(name, ...args) {
    for (const fn of [...(this.handlers.get(name) || [])]) fn(...args);
  }
  count(name) { return (this.handlers.get(name) || []).length; }
}

class Node {
  constructor(id = "") {
    this.id = id;
    this.hidden = false;
    this.innerHTML = "";
    this.style = { setProperty() {} };
    this.dataset = {};
    this.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
  }
  appendChild() {}
  setAttribute() {}
  addEventListener() {}
  removeEventListener() {}
  querySelector(selector) {
    if (selector === "#home-panel") return new Node("home-panel");
    return new Node(selector);
  }
  querySelectorAll() { return []; }
}

class Socket {
  constructor() {
    this.id = "lifecycle-test-socket";
    this.listeners = new Map();
    this.emitted = [];
  }
  on(name, fn) {
    const list = this.listeners.get(name) || [];
    list.push(fn);
    this.listeners.set(name, list);
  }
  emit(name, payload) { this.emitted.push({ name, payload }); }
  dispatch(name, payload) {
    for (const fn of [...(this.listeners.get(name) || [])]) fn(payload);
  }
}

class Scene {
  constructor(key) {
    this.scene = { key, isActive: () => false };
    this.events = new Emitter();
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "../../public/neighborhood.js"), "utf8");
const socket = new Socket();
const elements = new Map();
const document = {
  addEventListener() {},
  body: new Node("body"),
  activeElement: { tagName: "BODY" },
  createElement: () => new Node(),
  getElementById(id) {
    if (id === "neighborhood-ui" && !elements.has(id)) return null;
    if (id === "coin-hud") return null;
    if (!elements.has(id)) elements.set(id, new Node(id));
    return elements.get(id);
  },
};
const context = {
  console,
  document,
  localStorage: { getItem: () => null, setItem() {} },
  getComputedStyle: () => ({ display: "none" }),
  requestAnimationFrame: (fn) => fn(),
  ResizeObserver: class { observe() {} },
  MutationObserver: class { observe() {} disconnect() {} },
  performance: { now: () => 1000 },
  setTimeout,
  clearTimeout,
  window: null,
  Phaser: {
    Scene,
    Scenes: { Events: { SHUTDOWN: "shutdown", CREATE: "create", WAKE: "wake" } },
  },
};
context.window = context;
context.window.addEventListener = () => {};
context.window.matchMedia = () => ({ matches: false });
context.window.JpoFocusedMovement = null;
context.window.initHouseColors = null;
vm.createContext(context);
new vm.Script(source, { filename: "public/neighborhood.js" }).runInContext(context);
assert.equal(typeof context.window.initNeighborhoodUI, "function");

// This is the exact pre-fix office branch: start() is queued, then the
// not-yet-created OfficeScene is dereferenced immediately. It proves the
// browser exception rather than merely asserting that the code looks risky.
const coldOffice = { cameras: {}, player: null };
const beforeFixManager = {
  isActive: () => false,
  start() {},
  getScene: () => coldOffice,
};
assert.throws(
  () => {
    if (!beforeFixManager.isActive("OfficeScene")) beforeFixManager.start("OfficeScene");
    beforeFixManager.getScene("OfficeScene").cameras.main.fadeIn();
  },
  /Cannot read properties of undefined \(reading 'fadeIn'\)/,
  "pre-fix queued cold start reproduces the not-ready-camera exception",
);

// The other pre-fix crash was update() reaching the input stack after a
// reused scene had already cleared it during shutdown.
const beforeFixNeighborhoodUpdate = (scene) => {
  scene.cameras.main;
  if (!scene.player) return;
  scene.keys.left.isDown;
  scene.wasd.left.isDown;
};
assert.throws(
  () => beforeFixNeighborhoodUpdate({ cameras: null, player: {}, keys: null, wasd: null }),
  /Cannot read properties of null \(reading 'main'\)/,
  "pre-fix reused-scene update reproduces the not-ready-camera exception",
);
assert.throws(
  () => beforeFixNeighborhoodUpdate({ cameras: { main: {} }, player: {}, keys: null, wasd: null }),
  /Cannot read properties of null \(reading 'left'\)/,
  "pre-fix reused-scene update reproduces the not-ready-keys exception",
);

const activeFlags = { OfficeScene: false, NeighborhoodScene: true };
const sleepingFlags = { OfficeScene: false, NeighborhoodScene: false };
const office = {
  scene: { key: "OfficeScene", isActive: () => activeFlags.OfficeScene },
  events: new Emitter(),
  cameras: {},
  player: null,
  cursors: null,
  wasd: null,
  _syncOfficePlayers(players) { this.roster = players; },
  _applyOfficeArrival(state) {
    this.player.setPosition(state.x, state.y);
    this.player.body.reset(state.x, state.y);
  },
};
const neighborhood = {
  scene: {
    key: "NeighborhoodScene",
    isActive: () => activeFlags.NeighborhoodScene,
    restart(data) { this.restartQueue = (this.restartQueue || []).concat(data); },
  },
  events: new Emitter(),
  cameras: { main: { fadeIn() { this.fades = (this.fades || 0) + 1; } } },
  player: { setPosition(x, y) { this.x = x; this.y = y; }, body: { reset(x, y) { this.x = x; this.y = y; } } },
  keys: {}, wasd: {}, keyE: {}, keyShift: {}, interactHint: { setVisible() {} },
  syncPlayers(players) { this.roster = players; },
  sceneDataQueue: [],
};
const game = {
  scene: {
    getScenes: () => activeFlags.NeighborhoodScene ? [neighborhood] : activeFlags.OfficeScene ? [office] : [],
    getScene: (key) => key === "OfficeScene" ? office : neighborhood,
    isActive: (key) => !!activeFlags[key],
    isSleeping: (key) => !!sleepingFlags[key],
    stop(key) { activeFlags[key] = false; },
    sleep(key) { activeFlags[key] = false; sleepingFlags[key] = true; },
    wake(key) { activeFlags[key] = false; sleepingFlags[key] = true; office.sceneQueue = "wake"; },
    start(key, data) {
      activeFlags[key] = false;
      sleepingFlags[key] = false;
      if (key === "NeighborhoodScene") neighborhood.sceneDataQueue.push(data);
      office.sceneQueue = key === "OfficeScene" ? "create" : office.sceneQueue;
    },
  },
};
context.window._phaserGame = game;
context.window.initNeighborhoodUI(socket, () => ({}));

// Cold office start: fixed code queues the lifecycle operation and has no
// camera/player access before CREATE.
socket.dispatch("locationTransitionResult", {
  ok: true, transitionSequence: 1, location: "office",
  self: { x: 31, y: 47 }, players: { first: { x: 1, y: 2 } },
});
assert.equal(office.cameras.main, undefined);
assert.equal(office.roster, undefined);
assert.equal(office.events.count("create"), 1, "cold start has one bounded CREATE waiter");
assert.equal(office.sceneQueue, "create");

// CREATE/approved completion makes the target runtime safe. Only now are
// spawn, roster reconciliation, and fade applied.
office.cameras.main = { fadeIn() { this.fades = (this.fades || 0) + 1; } };
office.player = { setPosition(x, y) { this.x = x; this.y = y; }, body: { reset(x, y) { this.x = x; this.y = y; } } };
office.cursors = {};
office.wasd = {};
activeFlags.OfficeScene = true;
office.events.emit("create");
assert.deepEqual({ x: office.player.x, y: office.player.y }, { x: 31, y: 47 });
assert.deepEqual(office.roster, { first: { x: 1, y: 2 } });
assert.equal(office.cameras.main.fades, 1);

// Warm HQ wake has a different Phaser lifecycle event and must not apply
// during the queued wake call.
activeFlags.OfficeScene = false;
activeFlags.NeighborhoodScene = true;
sleepingFlags.OfficeScene = true;
office.sceneQueue = null;
office.cameras.main.fades = 0;
socket.dispatch("locationTransitionResult", {
  ok: true, transitionSequence: 2, location: "office",
  self: { x: 55, y: 66 }, players: { warm: { x: 3, y: 4 } },
});
assert.equal(office.sceneQueue, "wake");
assert.equal(office.cameras.main.fades, 0);
assert.equal(office.events.count("wake"), 1);
activeFlags.OfficeScene = true;
sleepingFlags.OfficeScene = false;
office.events.emit("wake");
assert.deepEqual({ x: office.player.x, y: office.player.y }, { x: 55, y: 66 });
assert.equal(office.cameras.main.fades, 1);

// Reconnect before the neighborhood textures/create lifecycle completes:
// current result data is retained by the queued scene operation, but no
// camera/input/player work is attempted until CREATE.
activeFlags.OfficeScene = false;
sleepingFlags.OfficeScene = true;
activeFlags.NeighborhoodScene = false;
neighborhood._neighborhoodReady = false;
neighborhood.player = null;
neighborhood.cameras.main = undefined;
neighborhood.roster = undefined;
socket.dispatch("locationTransitionResult", {
  ok: true, transitionSequence: 25, location: "city",
  self: { x: 70, y: 80 }, players: { reconnect: true },
});
assert.equal(neighborhood.cameras.main, undefined);
assert.equal(neighborhood.events.count("create"), 1);
neighborhood._neighborhoodReady = true;
neighborhood.cameras.main = { fadeIn() { this.fades = (this.fades || 0) + 1; } };
neighborhood.player = { setPosition(x, y) { this.x = x; this.y = y; }, body: { reset(x, y) { this.x = x; this.y = y; } } };
neighborhood.keys = {}; neighborhood.wasd = {}; neighborhood.keyE = {}; neighborhood.keyShift = {};
neighborhood.interactHint = { setVisible() {} };
activeFlags.NeighborhoodScene = true;
neighborhood.events.emit("create");
assert.deepEqual({ x: neighborhood.player.x, y: neighborhood.player.y }, { x: 70, y: 80 });
assert.deepEqual(neighborhood.roster, { reconnect: true });

// Two neighborhood restarts can be queued before either CREATE runs. The
// first create is stale and remains unready; only the latest create may apply.
activeFlags.OfficeScene = false;
sleepingFlags.OfficeScene = true;
activeFlags.NeighborhoodScene = true;
neighborhood.roster = undefined;
socket.dispatch("locationTransitionResult", {
  ok: true, transitionSequence: 26, location: "city",
  self: { x: 10, y: 20 }, players: { stale: true },
});
socket.dispatch("locationTransitionResult", {
  ok: true, transitionSequence: 27, location: "neighborhood",
  self: { x: 90, y: 100 }, players: { current: true },
});
assert.equal(neighborhood.events.count("create"), 1, "superseded restart listener was removed");
neighborhood._neighborhoodReady = false;
neighborhood.player = null;
neighborhood.cameras.main = undefined;
neighborhood.events.emit("create");
assert.equal(neighborhood.roster, undefined, "stale CREATE cannot apply a roster");
neighborhood._neighborhoodReady = true;
neighborhood.cameras.main = { fadeIn() { this.fades = (this.fades || 0) + 1; } };
neighborhood.player = { setPosition(x, y) { this.x = x; this.y = y; }, body: { reset(x, y) { this.x = x; this.y = y; } } };
neighborhood.keys = {}; neighborhood.wasd = {}; neighborhood.keyE = {}; neighborhood.keyShift = {};
neighborhood.interactHint = { setVisible() {} };
activeFlags.NeighborhoodScene = true;
neighborhood.events.emit("create");
assert.deepEqual({ x: neighborhood.player.x, y: neighborhood.player.y }, { x: 90, y: 100 });
assert.deepEqual(neighborhood.roster, { current: true });

// Reused-scene update is now a no-op until every required runtime object exists.
const scenePrototype = context.window.NeighborhoodScene.prototype;
assert.doesNotThrow(() => scenePrototype.update.call({
  _neighborhoodReady: true, cameras: {}, player: {},
  keys: null, wasd: null, keyE: null, keyShift: null, interactHint: null,
}), "reused scene update waits for camera and input initialization");
assert.doesNotThrow(() => scenePrototype.update.call({
  _neighborhoodReady: true, cameras: { main: {} }, player: {},
  keys: null, wasd: null, keyE: null, keyShift: null, interactHint: null,
}), "reused scene update waits for keyboard initialization");

// Phaser destroys the Arcade body before the scene's own SHUTDOWN callback,
// but retains the sprite object. Optional chaining on the sprite alone cannot
// protect its setVelocity wrapper, which dereferences this.body internally.
const destroyedBodySprite = {
  body: undefined,
  setVelocity(x, y) { this.body.setVelocity(x, y); },
};
assert.throws(() => destroyedBodySprite?.setVelocity(0, 0), TypeError,
  "reproduce the actual city-to-shop teardown exception");
for (const method of ["_resetTransientTravel", "_clearMovementTransport"]) {
  assert.doesNotThrow(() => scenePrototype[method].call({ player: destroyedBodySprite }),
    `${method} tolerates an already-destroyed Arcade body`);
  let stopped = false;
  scenePrototype[method].call({ player: {
    body: { setVelocity(x, y) { stopped = x === 0 && y === 0; } },
    setVelocity() { throw new Error("must not call the unsafe sprite wrapper"); },
  } });
  assert(stopped, `${method} still stops a live body`);
}

// Denial must cancel the delayed reliable movement and travel callbacks too,
// not merely unfreeze walking (otherwise a stale callback can re-enter).
const deniedScene = {
  transitionRequested: true, portalRelease: true,
  _portalTravelGeneration: 4,
  _resetTransientTravel: scenePrototype._resetTransientTravel,
  interactHint: { setVisible(value) { this.visible = value; } },
};
context.window._neighborhoodScene = deniedScene;
socket.dispatch("locationTransitionResult", { ok: false, code: "portal" });
assert.equal(deniedScene.transitionRequested, false);
assert.equal(deniedScene.portalRelease, false);
assert.equal(deniedScene._portalTravelGeneration, 5);
assert.equal(deniedScene._portalMoveTimer, null);
assert.equal(deniedScene._portalTravelTimer, null);
assert.equal(deniedScene._portalResponseTimer, null);
assert.equal(deniedScene.interactHint.visible, false);

console.log("PASS: queued scene readiness, denied travel cleanup and destroyed-Arcade-body teardown regressions");