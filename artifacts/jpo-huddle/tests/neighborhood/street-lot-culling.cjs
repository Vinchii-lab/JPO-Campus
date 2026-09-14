const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../../public/neighborhood.js'), 'utf8');
const start = source.indexOf('    _syncStreetLotVisibility(');
const end = source.indexOf('\n    _residenceSignText(', start);
assert(start >= 0 && end > start);
const scene = vm.runInNewContext(`new (class { ${source.slice(start, end)} })()`);
let mutations = 0;
const object = () => ({ visible: true, setVisible(value) { mutations++; this.visible = value; } });
scene.location = 'neighborhood';
scene.cameras = { main: { worldView: { top: 0, bottom: 720 }, zoom: 1 } };
scene.streetLotsVisual = Array.from({ length: 132 }, (_, i) => ({
  lot: { bottom: Math.floor(i / 8) * 960 + (i % 8 < 4 ? 324 : 840) },
  path: object(), sign: object(), structure: [object()], yard: [object()],
}));
scene._streetPortalVisuals = Array.from({ length: 17 }, (_, i) => ({
  top: i * 960 + 420, bottom: i * 960 + 590, objects: [object(), object()],
}));
const visibleLots = () => scene.streetLotsVisual.filter(visual => visual.visible);
scene._syncStreetLotVisibility();
assert(visibleLots().length <= 16, '132-lot world must not render every lot');
assert(scene.streetLotsVisual[0].visible);
assert(!scene.streetLotsVisual[131].visible);
assert(!scene._streetPortalVisuals[16].objects[0].visible);
for (const visual of scene.streetLotsVisual) {
  for (const item of [visual.path, visual.sign, ...visual.structure, ...visual.yard])
    assert.equal(item.visible, visual.visible);
}
const initialMutations = mutations;
scene._syncStreetLotVisibility();
assert.equal(mutations, initialMutations, 'unchanged camera must not rescan/mutate objects');
scene.cameras.main.worldView = { top: 14640, bottom: 15360 };
scene._syncStreetLotVisibility();
assert(!scene.streetLotsVisual[0].visible);
assert(visibleLots().length <= 24);
assert(visibleLots().length > 0, 'distant lots must reappear');
scene.cameras.main.worldView = { top: 13800, bottom: 15720 };
scene.cameras.main.zoom = 0.5;
scene._syncStreetLotVisibility();
assert(visibleLots().length <= 32, 'zoom-out rendering stays viewport-bounded');
for (const visual of scene.streetLotsVisual) {
  if (visual.lot.bottom >= 13800 && visual.lot.bottom <= 15720)
    assert(visual.visible, 'visible lots cannot disappear at low zoom');
}
// Directory updates replace sprites; fresh replacements inherit visibility
// even when the camera has not moved.
const distant = scene.streetLotsVisual[0];
distant.structure = [object()];
distant.visible = undefined;
scene._streetLotVisibleKey = null;
scene._syncStreetLotVisibility();
assert.equal(distant.structure[0].visible, false);
assert.equal(scene.streetLotsVisual.length, 132, 'culling must not remove lots or ownership data');
console.log('PASS: 132-lot viewport culling, portal culling, scrolling, zoom, and hidden replacements');