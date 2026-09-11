// Cheap regression checks for the M-key map contract. This test does not need
// a browser, socket, database, or workflow: it executes the minimap block in a
// tiny VM harness and guards location selection plus bounded street rendering.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const root = new URL("../../", import.meta.url);
const index = fs.readFileSync(new URL("public/index.html", root), "utf8");
const css = fs.readFileSync(new URL("public/neighborhood.css", root), "utf8");
const start = index.indexOf("// ── Minimap (M key)");
const end = index.indexOf("// ── Private DMs", start);
assert.ok(start >= 0 && end > start, "minimap implementation is present");
const minimap = index.slice(start, end);

assert.match(minimap, /function _mmActiveScene\(\)/);
assert.match(minimap, /window\._neighborhoodScene/);
assert.match(minimap, /function _mmBuildNeighborhoodBg\(scene, viewport\)/);
assert.match(minimap, /function _mmNeighborhoodViewport\(scene\)/);
assert.match(minimap, /MM_MAX_CANVAS_PIXELS/);
assert.match(minimap, /scene\.scene\?\.isActive/);
assert.match(minimap, /_jpoAuthoritativeLocation/);
assert.match(minimap, /scene\.doors/);
assert.match(minimap, /scene\.info\?\.geometry/);
assert.match(minimap, /sc\.remotes/);
assert.doesNotMatch(minimap, /socket\.emit\(\s*['"]locationTransition/);
assert.doesNotMatch(css, /#neighborhood-zoom/);

function makeContext() {
  const context = {
    beginPath() {}, arc() {}, fill() {}, stroke() {}, fillRect() {}, strokeRect() {},
    drawImage() {}, save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    measureText(text) { return { width: String(text).length * 6 }; },
    fillText() {},
    imageSmoothingEnabled: false,
  };
  context.arcs = [];
  context.arc = (x, y, radius) => { context.arcs.push({ x, y, radius }); };
  return context;
}

function makeCanvas() {
  const context = makeContext();
  return {
    width: 0,
    height: 0,
    getContext() { return context; },
  };
}

const minimapElement = {
  classList: {
    values: new Set(),
    add(value) { this.values.add(value); },
    remove(value) { this.values.delete(value); },
    contains(value) { return this.values.has(value); },
  },
  addEventListener() {},
};
const minimapCanvas = makeCanvas();
const minimapContext = minimapCanvas.getContext();
let keydown = null;
const document = {
  body: { classList: { contains(value) { return value === "playing"; } } },
  activeElement: null,
  getElementById(id) {
    return id === "minimap" ? minimapElement
      : id === "minimapCanvas" ? minimapCanvas
      : id === "minimapTitle" ? { textContent: "JPO HQ" }
      : null;
  },
  createElement(tag) { return tag === "canvas" ? makeCanvas() : {}; },
  addEventListener(type, listener) { if (type === "keydown") keydown = listener; },
};
const outdoor = {
  scene: { key: "NeighborhoodScene" },
  isActive() { return true; },
  location: "neighborhood",
  mapWidth: 1440,
  // This deliberately represents a canonical lot-10000 street coordinate.
  mapHeight: 10_000_000,
  player: { x: 120, y: 9_999_800 },
  info: {
    label: "Willow Walk",
    bounds: { width: 1440, height: 10_000_000 },
    geometry: { blockers: [] },
    streetLots: [{ lot: 10000, x: 720, bottom: 9_999_600, construction: { stage: "complete" }, yard: [] }],
  },
  doors: [],
  remotes: {},
  children: { list: [] },
  textures: { get() { return null; } },
};
const sleepingOffice = {
  isActive() { return false; },
  _tileMap: { width: 200, height: 136, tileWidth: 16, getLayer() { return null; } },
  player: { x: 1, y: 1 },
};
const sandbox = {
  window: null,
  document,
  Image: class {},
  innerWidth: 1200,
  innerHeight: 800,
  setInterval() { return 1; },
  clearInterval() {},
  socket: { id: "self", on() {} },
  _roundPhase: false,
  _chatOpen: false,
  _neighborhoodScene: outdoor,
  _gameScene: sleepingOffice,
  _jpoAuthoritativeLocation: "neighborhood",
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(`${minimap}\nglobalThis.__minimapProbe = { active: _mmActiveScene, viewport: _mmNeighborhoodViewport, draw: _mmDraw, background: () => _mmBg };`, sandbox);

assert.equal(sandbox.__minimapProbe.active(), outdoor, "active neighborhood scene wins over sleeping HQ");
keydown({ code: "KeyM", preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });
assert.ok(minimapElement.classList.contains("open"), "M opens the ready neighborhood map");
assert.ok(minimapCanvas.width > 0 && minimapCanvas.height > 0, "extreme map receives a usable canvas");
assert.ok(minimapCanvas.width >= 1000, "extreme street keeps its full readable width");
assert.ok(minimapCanvas.height >= 1600 && minimapCanvas.height <= 2400, "extreme street uses a bounded local chunk");
assert.ok(minimapCanvas.width <= 2048 && minimapCanvas.height <= 2048, "canvas dimensions are bounded");
assert.ok(minimapCanvas.width * minimapCanvas.height <= 4 * 1024 * 1024, "canvas pixel budget is bounded");
const viewport = sandbox.__minimapProbe.viewport(outdoor);
assert.ok(viewport.originY <= outdoor.player.y && outdoor.player.y <= viewport.originY + viewport.height,
  "local player remains inside the cropped street region");
assert.ok(minimapContext.arcs.some((arc) => arc.x >= 0 && arc.x <= minimapCanvas.width &&
  arc.y >= 0 && arc.y <= minimapCanvas.height), "player marker is transformed into the cropped region");
const firstBackground = sandbox.__minimapProbe.background();
const firstOrigin = viewport.originY;
outdoor.player.y = Math.max(10, firstOrigin - 1921);
sandbox.__minimapProbe.draw();
assert.notEqual(sandbox.__minimapProbe.background(), firstBackground,
  "crossing a street chunk invalidates the cached background");

delete sandbox._jpoAuthoritativeLocation;
assert.equal(sandbox.__minimapProbe.active(), outdoor, "active scene remains usable before first location snapshot");
outdoor.isActive = () => false;
assert.equal(sandbox.__minimapProbe.active(), null, "inactive expected scene defers rather than falling back to HQ");

console.log("minimap runtime contract: PASS");