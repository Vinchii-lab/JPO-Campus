// Browser-free regression coverage for the shared interior depth contract.
// This exercises the real renderer helpers with Phaser-sized stubs rather than
// starting a browser, a workflow, or a network server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const publicRoot = path.join(root, 'public');

function display(key, x = 0, y = 0) {
  const data = new Map();
  const listeners = new Map();
  return {
    texture: { key },
    x, y, depth: 0, originX: 0.5, originY: 1, scaleX: 1, scaleY: 1,
    frame: { index: 0 },
    setOrigin(originX, originY) {
      this.originX = originX; this.originY = originY; return this;
    },
    setScale(scaleX, scaleY = scaleX) {
      this.scaleX = scaleX; this.scaleY = scaleY; return this;
    },
    setAngle(value) { this.angle = value; return this; },
    setFlipX(value) { this.flipX = value; return this; },
    setFlipY(value) { this.flipY = value; return this; },
    setDepth(value) { this.depth = value; return this; },
    setPosition(nextX, nextY) { this.x = nextX; this.y = nextY; return this; },
    setCrop(x0, y0, width, height) {
      this.crop = { x: x0, y: y0, width, height }; return this;
    },
    setData(name, value) { data.set(name, value); return this; },
    getData(name) { return data.get(name); },
    once(name, callback) { listeners.set(name, callback); return this; },
    destroy() {
      if (this.destroyed) return this;
      this.destroyed = true;
      listeners.get('destroy')?.();
      return this;
    },
    stop() { this.stopped = true; return this; },
    setFrame(value) { this.frame = { index: value }; return this; },
    play(key) { this.played = key; return this; },
  };
}

// The dedicated renderer must preserve the supplied floor anchor and split a
// seat's front row without changing the base sprite's persisted footprint.
const rendererContext = {
  console,
  window: {
    Phaser: { Textures: { FilterMode: { NEAREST: 0 } } },
  },
};
rendererContext.globalThis = rendererContext.window;
vm.createContext(rendererContext);
vm.runInContext(
  fs.readFileSync(path.join(publicRoot, 'furniture-renderer.js'), 'utf8'),
  rendererContext,
  { filename: 'furniture-renderer.js' },
);
const renderer = rendererContext.window.HomeFurnitureRenderer;
const texture = {
  setFilter() {},
  getSourceImage() { return { width: 16, height: 32 }; },
};
const rendererScene = {
  textures: {
    get() { return texture; },
  },
  add: {
    image(x, y, key) { return display(key, x, y); },
    sprite(x, y, key) { return display(key, x, y); },
  },
  anims: { exists() { return false; } },
};
const chair = renderer.draw(rendererScene, {
  id: 'oak_chair',
  actions: ['sit'],
  frames: { frameWidth: 16, frameHeight: 32, frameCount: 1, initialFrame: 0 },
}, 240, 288, { depth: 288 });
assert.equal(chair.getData('floorAnchor'), 288, 'chair retains its contact anchor');
assert.equal(chair.depth, 288, 'chair base sorts at the contact anchor');
const chairFront = chair.getData('occluderParts')?.[0];
assert.ok(chairFront, 'seat creates a lower/front occluder layer');
assert.equal(chairFront.crop.y, 19, 'occluder starts in the lower source rows');
assert.equal(chairFront.crop.height, 13, 'occluder preserves the lower source rows');
assert.equal(chairFront.depth, 288.01, 'occluder gets only a tiny front bias');

// A sitter is rendered between the chair's back/base and its lower/front row.
// This is the important actor-vs-chair check: putting the whole seated actor
// behind the chair would permanently hide the pose.
const seatedDepth = 288.005;
assert(chair.depth < seatedDepth && seatedDepth < chairFront.depth,
  'a seated actor depth fits between the chair base and front occluder');
chair.destroy();
assert.equal(chairFront.destroyed, true, 'destroying furniture cleans up its occluder');

// Exercise the real JpoInteriors implementation directly. Its static surface,
// wall strip, authored furniture, and door all carry explicit layer metadata.
const interiorSource = fs.readFileSync(
  path.join(publicRoot, 'neighborhood-interiors.js'), 'utf8',
);
const interiorContext = { console, window: {}, Phaser: { Textures: { FilterMode: { NEAREST: 0 } } } };
vm.createContext(interiorContext);
vm.runInContext(interiorSource, interiorContext, { filename: 'neighborhood-interiors.js' });
const created = [];
const makeTexture = () => ({
  setFilter() {},
  getSourceImage() { return { width: 16, height: 16 }; },
});
const roomObjects = [{
  asset: 'chair_asset', x: 48, y: 80, depth: 80, scale: 3,
}];
const roomData = {
  rooms: {
    cafe: {
      width: 96, height: 96,
      wall: { asset: 'commercial-wall-native' },
      objects: roomObjects,
    },
  },
};
const surface = {
  context: {
    imageSmoothingEnabled: false,
    drawImage() {},
  },
  refresh() {},
  setFilter() {},
};
const interiorScene = {
  cache: { json: { get() { return roomData; } } },
  info: { geometry: { blockers: [] }, portals: [{ x: 24, y: 0, width: 48, height: 72 }] },
  children: { list: created },
  textures: {
    exists(key) { return !String(key).startsWith('commercial-surface:'); },
    createCanvas() { return surface; },
    get() { return makeTexture(); },
  },
  add: {
    image(x, y, key) {
      const object = display(key, x, y);
      created.push(object);
      return object;
    },
    text() { throw new Error('unexpected room label in depth fixture'); },
  },
};
interiorContext.window.JpoInteriors.draw(interiorScene, 'cafe');
const surfaceObject = created.find((object) =>
  object.texture.key.startsWith('commercial-surface:'));
const wallObject = created.find((object) => object.texture.key === 'commercial-wall-native');
const chairObject = created.find((object) => object.texture.key === 'chair_asset');
const portalObject = created.find((object) => object.texture.key === 'pe_shop_door');
assert.equal(surfaceObject.depth, -10000, 'commercial surface stays below y-sorted content');
assert.equal(wallObject.depth, -9000, 'commercial wall stays in the back band');
assert.equal(chairObject.depth, 80, 'authored chair uses its floor anchor');
assert.equal(chairObject.getData('floorAnchor'), 80, 'authored chair publishes its floor anchor');
assert.equal(portalObject.depth, 72, 'commercial doorway uses its bottom edge anchor');

// Execute neighborhood's real normalization/anchor methods in isolation. This
// catches accidental regressions in the cross-module adapter without loading
// Phaser or invoking scene creation.
const neighborhoodSource = fs.readFileSync(path.join(publicRoot, 'neighborhood.js'), 'utf8');
function method(name, next) {
  const start = neighborhoodSource.indexOf(`    ${name}(`);
  const end = neighborhoodSource.indexOf(`\n    ${next}(`, start);
  assert(start >= 0 && end > start, `missing NeighborhoodScene method ${name}`);
  return neighborhoodSource.slice(start, end);
}
const layerMethods = [
  method('_floorDepth', '_setFloorDepth'),
  method('_setFloorDepth', '_setActorDepth'),
  method('_setActorDepth', '_activityDepthAnchor'),
  method('_activityDepthAnchor', '_activityDepthBias'),
  method('_activityDepthBias', '_interiorObjectNeedsOccluder'),
  method('_interiorObjectNeedsOccluder', '_normaliseInteriorLayers'),
  method('_normaliseInteriorLayers', '_streetYardKey'),
];
const layerContext = {
  finiteDepth: (value, fallback = 0) =>
    Number.isFinite(Number(value)) ? Number(value) : fallback,
  INTERIOR_DEPTH: {
    BACKGROUND: -10000, WALL_BACK: -9000, SEATED_ACTOR_BIAS: 0.005, FRONT_BIAS: 0.01,
  },
  window: {
    HomeFurnitureRenderer: {
      splitOccluder(_scene, object) {
        object.setData('split', true);
      },
    },
  },
};
const LayerScene = vm.runInNewContext(
  `(() => { class LayerScene { ${layerMethods.join('\n')} } return LayerScene; })()`,
  layerContext,
);
const layerScene = new LayerScene();
const normalizedSurface = display('commercial-surface:cafe:current');
const normalizedWall = display('commercial-wall-native');
const normalizedChair = display('chair_asset', 48, 80);
layerScene.children = { list: [normalizedSurface, normalizedWall, normalizedChair] };
layerScene.cache = {
  json: {
    get() {
      return {
        rooms: {
          cafe: {
            objects: [{ asset: 'chair_asset', x: 48, y: 80, depth: 80 }],
          },
        },
      };
    },
  },
};
layerScene._normaliseInteriorLayers([], 'cafe');
assert.equal(normalizedSurface.depth, -10000, 'normalization keeps the floor backdrop low');
assert.equal(normalizedWall.depth, -9000, 'normalization keeps the wall backdrop low');
assert.equal(normalizedChair.depth, 80, 'normalization uses authored furniture depth');
assert.equal(normalizedChair.getData('floorAnchor'), 80, 'normalization publishes floor anchor metadata');
assert.equal(normalizedChair.getData('split'), true, 'normalization requests authored seat occlusion');

const actor = display('run_adam', 240, 274);
layerScene._setActorDepth(actor, actor.y);
assert.equal(actor.depth, 274, 'actor depth follows its foot anchor, not sprite centre');
assert.equal(actor.getData('floorAnchor'), 274, 'actor publishes its foot anchor');
const activityEntry = {
  sprite: actor,
  _activityFurnitureSprite: chair,
};
assert.equal(layerScene._activityDepthAnchor(activityEntry, actor.y), 288,
  'active furniture supplies the seated actor contact anchor');
const activeActorDepth = layerScene._floorDepth(
  layerScene._activityDepthAnchor(activityEntry, actor.y),
  layerScene._activityDepthBias(activityEntry),
);
assert(chair.depth < activeActorDepth && activeActorDepth < chairFront.depth,
  'activity bias prevents a split chair from hiding the sitter');
const television = display('television', 240, 288);
television.setData('floorAnchor', 288);
const nonOccludingEntry = { sprite: actor, _activityFurnitureSprite: television };
assert.equal(layerScene._activityDepthAnchor(nonOccludingEntry, actor.y), actor.y,
  'non-occluding actions retain the actor foot anchor');
assert.equal(layerScene._activityDepthBias(nonOccludingEntry), 0,
  'non-occluding actions do not borrow a furniture depth bias');

assert.match(neighborhoodSource, /this\._clearActivityEffect\(remote\);[\s\S]{0,100}remote\._activityAction = null;/,
  'remote stand packets release stale furniture occlusion state');
assert.match(neighborhoodSource, /_positionPresentation\(entry, x, y, dir\) \{[\s\S]{0,260}activityDepthAnchor/,
  'wearables follow the active furniture depth anchor');

console.log('PASS: interior depth bands, floor anchors, seated occluder ordering, and cleanup');