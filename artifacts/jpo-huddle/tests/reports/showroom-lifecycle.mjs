// Runtime lifecycle contract for the production NeighborhoodScene methods.
// This deliberately loads public/neighborhood.js in a VM and calls the real
// class methods. It does not grep source text or substitute a copied prompt
// implementation. Phaser display objects are represented by small lifecycle
// doubles so this stays auth/browser/workflow free.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FURNITURE_CATALOG } from "../../neighborhood.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const sceneSource = fs.readFileSync(join(root, "../../public/neighborhood.js"), "utf8");

class FakeElement {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.hidden = false;
    this.style = { setProperty() {} };
    this.attributes = {};
    this.classList = {
      toggle() {},
      add() {},
      remove() {},
    };
  }

  set innerHTML(value) {
    this._innerHTML = value;
    // initNeighborhoodUI creates these exact fixed controls before any scene
    // method is reached. Registering them makes the UI bootstrap realistic.
    for (const id of ["neighborhood-title", "neighborhood-panel-toggle",
      "home-panel", "placement-controls"]) {
      if (!this._ids) this._ids = new Map();
      if (!this._ids.has(id)) this._ids.set(id, new FakeElement("div"));
    }
  }

  get innerHTML() { return this._innerHTML || ""; }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  querySelector(selector) {
    return this._ids?.get(String(selector).replace(/^#/, "")) || null;
  }

  addEventListener() {}
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  replaceChildren() { this.children = []; }
}

const documentBody = new FakeElement("body");
const document = {
  body: documentBody,
  hidden: false,
  activeElement: null,
  getElementById(id) {
    if (id === "neighborhood-ui") return documentBody.children.find((child) => child.id === id) || null;
    if (id === "placement-controls") return documentBody.children
      .flatMap((child) => [...(child._ids?.values() || [])])
      .find((child) => child.id === id) || null;
    return null;
  },
  createElement(tag) {
    const element = new FakeElement(tag);
    Object.defineProperty(element, "id", {
      get() { return this._id || ""; },
      set(value) { this._id = value; },
    });
    return element;
  },
  addEventListener() {},
};
const listeners = new Map();
const emitted = [];
const socket = {
  id: "showroom-lifecycle-test",
  on(name, handler) {
    const handlers = listeners.get(name) || [];
    handlers.push(handler);
    listeners.set(name, handlers);
    return this;
  },
  emit(name, payload) {
    emitted.push({ name, payload });
    return this;
  },
  push(name, payload) {
    for (const handler of listeners.get(name) || []) handler(payload);
  },
};

class FakeScene {
  constructor(key) {
    this.scene = { key, isActive: () => true };
  }
}

const window = {
  document,
  initHouseColors: null,
  JpoUIBuilder: null,
  _neighborhoodScene: null,
  addEventListener() {},
};
const context = {
  window,
  document,
  localStorage: { getItem: () => null, setItem() {} },
  requestAnimationFrame: (callback) => { callback(); return 1; },
  cancelAnimationFrame() {},
  Phaser: {
    Scene: FakeScene,
    Scenes: { Events: { CREATE: "create", WAKE: "wake", SHUTDOWN: "shutdown" } },
    Input: { Keyboard: { JustDown: () => false } },
  },
  console,
  Math,
  performance: { now: () => 0 },
  setTimeout,
  clearTimeout,
};
vm.runInNewContext(sceneSource, context, { filename: "public/neighborhood.js" });
window.initNeighborhoodUI(socket, () => ({
  DIR_START: { right: 0, up: 6, left: 12, down: 18 },
  _playerEmail: "showroom-lifecycle@example.invalid",
}));
// The production directory callback is the same catalog binding used by a
// real transition/home snapshot; no test-only catalog is injected into the
// scene methods.
socket.push("homeDirectory", { catalog: FURNITURE_CATALOG, homes: [] });

const NeighborhoodScene = window.NeighborhoodScene;
assert.equal(typeof NeighborhoodScene, "function", "production scene class is available");

function sprite() {
  const data = new Map();
  const object = {
    active: true,
    destroyed: false,
    x: 0,
    y: 0,
    depth: 0,
    frame: { index: 0 },
    texture: { key: "run_adam" },
    anims: {
      currentAnim: null,
      isPlaying: false,
      stop() {},
    },
    setData(key, value) { data.set(key, value); return this; },
    getData(key) { return data.get(key); },
    setPosition(x, y) { this.x = x; this.y = y; return this; },
    setDepth(depth) { this.depth = depth; return this; },
    setAngle() { return this; },
    setScale() { return this; },
    setFlipX() { return this; },
    setTexture(key) { this.texture = { key }; return this; },
    setFrame(index) { this.frame = { index }; return this; },
    destroy() { this.active = false; this.destroyed = true; },
  };
  return object;
}

const activityEffects = [];
window.HomeFurnitureRenderer = {
  updateActivity(_scene, object, definition, activity) {
    activityEffects.push({ object, furnitureId: definition.id, action: activity.action });
  },
  clearEffect() {},
};

const scene = Object.create(NeighborhoodScene.prototype);
scene.location = "furniture-shop";
scene.player = sprite();
scene.player.setPosition(363, 355);
scene.playerTexKey = "run_adam";
scene.furniture = [];
scene.showroomFurniture = [];
scene.showroomInteractions = new Map();
scene.showroomDemos = [];
scene.remotes = {};
scene.tweens = { killTweensOf() {}, remove() {} };
scene.anims = { exists: () => false };
scene._activityFx = null;
scene._activityEffectTween = null;
scene._clearActivityEffect = NeighborhoodScene.prototype._clearActivityEffect.bind(scene);
scene._setActorDepth = () => {};
scene._hideLegacyFurnitureShopObjects = () => {};
scene._drawFurniture = (definition, x, y, options = {}) => {
  const object = sprite();
  object.setPosition(x, y);
  object.setData("furnitureId", definition.id);
  object.setData("instanceId", String(options.instanceId));
  object.setData("floorAnchor", y);
  return object;
};

const demo = {
  instanceId: "showroom-lounge-sofa",
  furnitureId: "lounge_sofa",
  x: 340,
  y: 320,
  stand: { x: 340, y: 340, dir: "up" },
  footprint: { width: 2, height: 1 },
  actions: [
    { id: "sit", label: "Sit", radius: 96, facing: "down" },
    { id: "lie", label: "Lie down", radius: 96, facing: "down" },
  ],
};

// Reproduce the reported null: a visible-looking stale sprite has no
// DataManager payload, and the old implementation had no stable scene record.
const stale = sprite();
stale.setPosition(340, 320);
scene.showroomFurniture = [stale];
assert.equal(scene._nearbyShowroomAction(), null,
  "a stale sprite without metadata is initially not actionable");

// The authoritative demo payload binds a stable scene record and the actual
// player point from the report is inside the authored lounge stand radius.
scene.showroomDemos = [demo];
scene.setFurnitureShowroomDemos = NeighborhoodScene.prototype.setFurnitureShowroomDemos.bind(scene);
scene.setFurnitureShowroomDemos([demo]);
const firstSprite = scene.showroomFurniture[0];
const firstAction = scene._nearbyShowroomAction();
assert.ok(firstAction, "bound lounge metadata produces a nearby action");
assert.equal(firstAction.demo.instanceId, demo.instanceId);
assert.equal(firstAction.actions[0].id, "sit");
assert.equal(firstAction.sprite, firstSprite);
assert.ok(firstAction.distance < 28,
  "the reported player (363,355) is within the authored lounge stand radius");

// A server showroom refresh destroys the old display object. The scene-owned
// record must be replaced, and a remote activity must bind to the replacement
// rather than the destroyed target.
const remote = {
  sprite: sprite(),
  activity: {
    instanceId: demo.instanceId, furnitureId: demo.furnitureId, action: "sit",
    x: 340, y: 306, dir: "down",
  },
  lastDir: "down",
  texture: "run_adam",
  _activityAction: "sit",
};
scene.remotes = { remote };
scene.activity = {
  instanceId: demo.instanceId, furnitureId: demo.furnitureId, action: "sit",
  x: 340, y: 306, dir: "down",
};
scene.setFurnitureShowroomDemos([demo]);
const secondSprite = scene.showroomFurniture[0];
const reboundAction = scene._nearbyShowroomAction();
assert.notEqual(secondSprite, firstSprite, "showroom redraw creates a replacement display object");
assert.equal(firstSprite.destroyed, true, "showroom redraw destroys the old display object");
assert.equal(reboundAction.sprite, secondSprite, "nearby action uses the replacement display object");
assert.equal(scene.showroomInteractions.get(demo.instanceId).sprite, secondSprite,
  "stable map points at the current display object");
assert.equal(remote._activityFurnitureSprite, secondSprite,
  "remote activity rebinds to the current showroom display object");
assert.equal(scene._activityFurnitureSprite, secondSprite,
  "local activity rebinds to the current showroom display object");
assert.ok(activityEffects.some((entry) => entry.object === secondSprite && entry.action === "sit"),
  "rebind drives the furniture activity effect for local/remote activity");

// Regression for the exact production failure: the prompt still comes from
// the stable showroom record after redraw, but the replacement sprite has no
// DataManager instanceId. Pressing E must nevertheless submit that UUID.
delete secondSprite.getData;
scene.nearbyCashier = null;
scene.cashierNpcs = [];
scene.keyShift = { isDown: false };
scene.activity = null;
scene._activityPending = false;
scene._requestFurnitureAction();
const interactionRequest = emitted.at(-1);
assert.equal(interactionRequest?.name, "furnitureDemoInteract",
  "E sends the showroom interaction event after sprite metadata loss");
assert.equal(interactionRequest?.payload?.phase, "start");
assert.equal(interactionRequest?.payload?.instanceId, demo.instanceId);
assert.equal(interactionRequest?.payload?.action, "sit",
  "E submits the stable showroom UUID and selected action");

console.log("PASS: production showroom null, redraw/destruction, and local/remote rebinding lifecycle");