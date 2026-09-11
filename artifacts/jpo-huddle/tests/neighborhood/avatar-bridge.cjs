// Exercise the actual shared renderer without a warm HQ texture cache.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const office = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const neighborhood = fs.readFileSync(path.join(root, 'public/neighborhood.js'), 'utf8');
function method(name) {
  const start = office.indexOf(`      ${name}(`);
  assert(start >= 0, `Missing office method ${name}`);
  const end = office.indexOf('\n      }', start) + '\n      }'.length;
  return office.slice(start, end);
}
const wrappers = ['_bakeWearOnCanvas', '_createDirAnims'].map(name => {
  const line = neighborhood.split('\n').find(line => line.includes(`${name}(...args)`));
  assert(line, `Missing neighborhood bridge ${name}`);
  return line;
});
let clothingDraws = 0;
const clothing = {};
const context = vm.createContext({
  document: { createElement: () => ({ getContext: () => ({
    drawImage(image) { if (image === clothing) clothingDraws++; },
  }) }) },
  _charZoneColors: {},
  SIT_SUFFIX: { right: 'sit', up: 'sit2', down: 'sit3' },
  _wearAnchors: {},
  WEARABLE_DEFS: { testcoat: { bakeLayer: true } },
  _wearLayerImgs: Object.fromEntries(['run', 'sit', 'sit2', 'sit3']
    .map(suffix => [`adam_${suffix}_testcoat`, clothing])),
  DIR_START: { right: 0, up: 6, left: 12, down: 18 },
  DIR_ROWS: { right: [0, 5], up: [6, 11], left: [12, 17], down: [18, 23] },
});
const sourceMethods = ['_buildPlayerTex', '_bakeWearOnCanvas', '_createDirAnims'].map(method);
const scene = vm.runInContext(`(() => {
  const source = { ${sourceMethods.join(',')} };
  class Neighborhood {
    _office(method, ...args) { return source[method].call(this, ...args); }
    ${wrappers.join('\n')}
  }
  return new Neighborhood();
})()`, context);
const textures = new Map(['run_adam', 'adam_sit', 'adam_sit2', 'adam_sit3']
  .map(key => [key, { source: [{ image: { width: 384, height: 32 } }] }]));
const animations = new Map();
scene.textures = {
  exists: key => textures.has(key),
  get: key => textures.get(key),
  addSpriteSheet: (key, canvas) => textures.set(key, { source: [{ image: canvas }] }),
};
scene.anims = {
  exists: key => animations.has(key),
  create: config => animations.set(config.key, config),
  generateFrameNumbers: () => [],
};
for (const wearIds of [[], ['testcoat']]) {
  const key = scene._office('_buildPlayerTex', 'adam', 0, 0, 0, 0, wearIds);
  assert(textures.has(key));
  for (const direction of ['right', 'up', 'left', 'down']) {
    assert(animations.has(`walk_${key}_${direction}`));
  }
  for (const direction of ['right', 'up', 'down']) {
    assert(animations.has(`sit_${key}_${direction}`));
  }
  assert.equal(scene._office('_buildPlayerTex', 'adam', 0, 0, 0, 0, wearIds), key);
}
assert.equal(clothingDraws, 4, 'Clothing baked into running and all three sitting sheets');
console.log('PASS: uncached avatar, clothing baking, walking/sitting animations, and cache reuse');