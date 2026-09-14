const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../public/neighborhood.js'), 'utf8');
const start = source.indexOf('    _streetSurfaceTexture(');
const end = source.indexOf('\n    _syncStreetScenery(', start);
assert(start >= 0 && end > start);
const scene = vm.runInNewContext(`new (class { ${source.slice(start, end)} })()`);
let canvasCount = 0, refreshCount = 0, drawCalls = 0;
const ctx = {};
for (const name of ['fillRect', 'strokeRect', 'beginPath', 'moveTo', 'lineTo', 'stroke'])
  ctx[name] = () => drawCalls++;
const textures = new Set();
scene.textures = {
  exists: key => textures.has(key),
  createCanvas(key, width, height) {
    assert.equal(width, 480);
    assert.equal(height, 320, 'road texture must never grow with total street height');
    textures.add(key); canvasCount++;
    return { getContext: () => ctx, refresh: () => refreshCount++ };
  },
};
scene.mapWidth = 1440;
scene.mapHeight = 9600000;
const key = scene._streetSurfaceTexture();
assert(drawCalls > 0 && drawCalls < 500);
const initialDrawCalls = drawCalls;
for (let segment = 0; segment < 10000; segment++)
  assert.equal(scene._streetSurfaceTexture(), key);
assert.equal(canvasCount, 1);
assert.equal(refreshCount, 1);
assert.equal(drawCalls, initialDrawCalls, 'scrolling never repaints the road texture');
assert.equal(ctx.globalAlpha, 1);
console.log('PASS: one immutable 480x320 road texture shared across 10,000 street segments');