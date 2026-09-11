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
assert.match(minimap, /function _mmApplyCanvasLayout\(pixelWidth, pixelHeight\)/);
assert.match(minimap, /dataset\.displaySize/);
assert.match(minimap, /MM_LAYOUT_VERSION/);
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
  context.rects = [];
  context.texts = [];
  context.arc = (x, y, radius) => { context.arcs.push({ x, y, radius }); };
  context.fillRect = (x, y, width, height) => { context.rects.push({ x, y, width, height }); };
  context.fillText = (text, x, y) => { context.texts.push({ text, x, y }); };
  return context;
}

function makeCanvas() {
  const context = makeContext();
  return {
    width: 0,
    height: 0,
    style: {},
    dataset: {},
    getContext() { return context; },
    context,
  };
}

const createdCanvases = [];
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
const titleElement = { textContent: "JPO HQ" };
const subtitleElement = { textContent: "" };
let keydown = null;
const document = {
  body: { classList: { contains(value) { return value === "playing"; } } },
  activeElement: null,
  getElementById(id) {
    return id === "minimap" ? minimapElement
      : id === "minimapCanvas" ? minimapCanvas
      : id === "minimapTitle" ? titleElement
      : id === "minimapSubtitle" ? subtitleElement
      : null;
  },
  createElement(tag) {
    if (tag !== "canvas") return {};
    const canvas = makeCanvas();
    createdCanvases.push(canvas);
    return canvas;
  },
  addEventListener(type, listener) { if (type === "keydown") keydown = listener; },
};
const outdoor = {
  scene: { key: "NeighborhoodScene" },
  isActive() { return true; },
  location: "neighborhood",
  mapWidth: 1440,
  // This deliberately represents a sparse canonical lot coordinate from the
  // live street snapshot, not a compact eight-lot demo map.
  mapHeight: 647_136,
  player: { x: 120, y: 646_900 },
  info: {
    label: "Willow Walk",
    bounds: { width: 1440, height: 647_136 },
    geometry: { blockers: [] },
    streetLots: [{ lot: 6744, x: 720, bottom: 646_600, construction: { stage: "complete" }, yard: [] }],
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
vm.runInContext(`${minimap}\nglobalThis.__minimapProbe = {
  active: _mmActiveScene, viewport: _mmNeighborhoodViewport, draw: _mmDraw,
  background: () => _mmBg, mapSize: _mmMapSize, fit: _mmFitScale,
  canvasSize: () => ({ width: _mmCanvasWidth, height: _mmCanvasHeight }),
  layout: _mmApplyCanvasLayout,
};`, sandbox);

assert.equal(sandbox.__minimapProbe.active(), outdoor, "active neighborhood scene wins over sleeping HQ");
// The fit helper itself must be safe if a caller hands it the complete sparse
// world; the draw path should never regress to a 4px-wide full-street canvas.
sandbox.__minimapProbe.fit(outdoor, outdoor.mapWidth, outdoor.mapHeight);
const fullStreetFit = sandbox.__minimapProbe.canvasSize();
assert.ok(fullStreetFit.width >= 1000 && fullStreetFit.height >= 1600 &&
  fullStreetFit.height <= 2048, "full sparse street is cropped before bounded fitting");
keydown({ code: "KeyM", preventDefault() {}, ctrlKey: false, metaKey: false, altKey: false });
assert.ok(minimapElement.classList.contains("open"), "M opens the ready neighborhood map");
assert.ok(minimapCanvas.width > 0 && minimapCanvas.height > 0, "extreme map receives a usable canvas");
assert.ok(minimapCanvas.width >= 1000, "extreme street keeps its full readable width");
assert.ok(minimapCanvas.height >= 1600 && minimapCanvas.height <= 2400, "extreme street uses a bounded local chunk");
assert.equal(sandbox.__minimapProbe.background().width, minimapCanvas.width,
  "visible canvas width matches the rendered background width");
assert.equal(sandbox.__minimapProbe.background().height, minimapCanvas.height,
  "visible canvas height matches the rendered background height");
assert.ok(minimapCanvas.width <= 2048 && minimapCanvas.height <= 2048, "canvas dimensions are bounded");
assert.ok(minimapCanvas.width * minimapCanvas.height <= 4 * 1024 * 1024, "canvas pixel budget is bounded");
assert.equal(minimapCanvas.dataset.minimapRenderer, "nearby-chunk-v2", "live canvas identifies the bounded renderer");
assert.equal(minimapCanvas.dataset.pixelSize, `${minimapCanvas.width}x${minimapCanvas.height}`,
  "CSS layout records the actual backing-store dimensions");
assert.ok(Number.parseFloat(minimapCanvas.style.width) > 100 &&
  Number.parseFloat(minimapCanvas.style.height) > 100, "map has a visible CSS display size");
assert.ok(Number.parseFloat(minimapCanvas.style.width) <= sandbox.innerWidth * 0.92 + 1 &&
  Number.parseFloat(minimapCanvas.style.height) <= sandbox.innerHeight * 0.8 + 1,
  "CSS display size obeys viewport limits");
assert.ok(Math.abs(
  Number.parseFloat(minimapCanvas.style.width) / Number.parseFloat(minimapCanvas.style.height) -
  minimapCanvas.width / minimapCanvas.height,
) < 0.01, "CSS and backing-store aspect ratios stay locked");
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

// A narrow phone viewport still gets a two-axis layout, rather than inheriting
// the full street height as a one-pixel-wide replaced canvas.
sandbox.innerWidth = 320;
sandbox.innerHeight = 480;
sandbox.__minimapProbe.draw();
const tinyCssWidth = Number.parseFloat(minimapCanvas.style.width);
const tinyCssHeight = Number.parseFloat(minimapCanvas.style.height);
assert.ok(tinyCssWidth >= 100 && tinyCssHeight >= 100, "tiny viewport keeps a usable map");
assert.ok(tinyCssWidth <= sandbox.innerWidth * 0.92 + 1 &&
  tinyCssHeight <= sandbox.innerHeight * 0.8 + 1, "tiny viewport stays inside CSS bounds");
assert.ok(Math.abs(tinyCssWidth / tinyCssHeight - minimapCanvas.width / minimapCanvas.height) < 0.01,
  "tiny viewport preserves map aspect ratio");

function sceneFor(location, width, height) {
  return {
    scene: { key: "NeighborhoodScene" },
    isActive() { return true; },
    location, mapWidth: width, mapHeight: height,
    player: { x: width / 2, y: height / 2 },
    info: {
      label: location === "city" ? "Huddle Plaza" : location === "home:qa" ? "QA's Home" : "Shop",
      bounds: { width, height }, geometry: { blockers: [{ x: 4, y: 4, width: 24, height: 24 }] },
      streetLots: [], portals: [{ destination: "city", x: 40, y: 40, width: 48, height: 48, label: "Portal" }],
    },
    doors: [{ destination: "city", x: 40, y: 40, width: 48, height: 48, label: "Portal" }],
    remotes: {}, children: { list: [] }, textures: { get() { return null; } },
  };
}

// Every live NeighborhoodScene location uses the same draw/layout contract.
for (const [location, width, height] of [
  ["city", 1152, 912], ["home:qa", 1152, 864],
  ["furniture-shop", 960, 720], ["garden-shop", 960, 720], ["decor-shop", 960, 720],
]) {
  const scene = sceneFor(location, width, height);
  sandbox._neighborhoodScene = scene;
  sandbox._jpoAuthoritativeLocation = location;
  sandbox.innerWidth = 1200;
  sandbox.innerHeight = 800;
  assert.equal(sandbox.__minimapProbe.active(), scene, `${location} scene is selected`);
  sandbox.__minimapProbe.draw();
  assert.ok(minimapCanvas.width > 100 && minimapCanvas.height > 100,
    `${location} receives a real map canvas`);
  assert.ok(minimapCanvas.width * minimapCanvas.height <= 4 * 1024 * 1024,
    `${location} stays within the canvas budget`);
  assert.equal(titleElement.textContent, scene.info.label, `${location} title follows current location`);
  assert.ok(createdCanvases.at(-1).context.texts.some((text) => text.text === "PORTAL"),
    `${location} portal label is drawn`);
}

// HQ remains available through the active OfficeScene path, with the old
// sleeping-object fallback still rejected during an outdoor transition.
const office = {
  isActive() { return true; },
  _tileMap: { width: 200, height: 136, tileWidth: 16, getLayer() { return null; } },
  player: { x: 20, y: 20 }, otherPlayers: {},
};
sandbox._neighborhoodScene = sceneFor("city", 1152, 912);
sandbox._gameScene = office;
sandbox._jpoAuthoritativeLocation = "office";
sandbox.__minimapProbe.draw();
assert.equal(titleElement.textContent, "JPO HQ", "HQ title follows the authoritative location");
assert.ok(minimapCanvas.width > 100 && minimapCanvas.height > 100, "HQ receives a real map canvas");

delete sandbox._jpoAuthoritativeLocation;
assert.equal(sandbox.__minimapProbe.active(), sandbox._neighborhoodScene,
  "active scene remains usable before first location snapshot");
sandbox._neighborhoodScene.isActive = () => false;
sandbox._gameScene.isActive = () => false;
assert.equal(sandbox.__minimapProbe.active(), null, "inactive expected scene defers rather than falling back to HQ");

console.log("minimap runtime contract: PASS");