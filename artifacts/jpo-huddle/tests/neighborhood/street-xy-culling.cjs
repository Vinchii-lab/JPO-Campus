// Street presentation culling is two-dimensional. A lot or portal far east
// must disappear even when its y coordinate is inside the camera, and vice
// versa.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../../public/neighborhood.js'), 'utf8');
const start = source.indexOf('    _syncStreetLotVisibility(');
const end = source.indexOf('\n    _residenceSignText(', start);
assert(start >= 0 && end > start);

const scene = vm.runInNewContext(`new (class { ${source.slice(start, end)} })()`);
const object = () => ({ visible: true, setVisible(value) { this.visible = value; } });
const lotVisual = (lot) => ({
  lot, path: object(), sign: object(), structure: [object()], yard: [object()],
});
scene.location = 'neighborhood';
scene.cameras = {
  main: {
    worldView: { left: 0, top: 0, right: 1440, bottom: 960 },
    zoom: 1,
  },
};
scene.streetLotsVisual = [
  lotVisual({ lot: 1, x: 180, bottom: 340, northSide: true }),
  lotVisual({ lot: 2, x: 5100, bottom: 3300, northSide: true }),
  lotVisual({ lot: 3, x: 180, bottom: 3300, northSide: true }),
];
scene._streetPortalVisuals = [
  { x: 120, width: 96, left: 120, right: 216, top: 420, bottom: 590, objects: [object()] },
  { x: 5100, width: 96, left: 5100, right: 5196, top: 3300, bottom: 3470, objects: [object()] },
];

scene._syncStreetLotVisibility();
assert.equal(scene.streetLotsVisual[0].visible, true);
assert.equal(scene.streetLotsVisual[1].visible, false, 'far-east lot is culled');
assert.equal(scene.streetLotsVisual[2].visible, false, 'far-south lot is culled');
assert.equal(scene._streetPortalVisuals[0].objects[0].visible, true);
assert.equal(scene._streetPortalVisuals[1].objects[0].visible, false, 'far portal is culled');

scene.cameras.main.worldView = { left: 4800, top: 2880, right: 6240, bottom: 3840 };
scene._syncStreetLotVisibility();
assert.equal(scene.streetLotsVisual[0].visible, false);
assert.equal(scene.streetLotsVisual[1].visible, true, 'east lot returns after horizontal camera travel');
assert.equal(scene.streetLotsVisual[2].visible, false);
assert.equal(scene._streetPortalVisuals[0].objects[0].visible, false);
assert.equal(scene._streetPortalVisuals[1].objects[0].visible, true);

scene.cameras.main.worldView = { left: 0, top: 2880, right: 1440, bottom: 3840 };
scene._syncStreetLotVisibility();
assert.equal(scene.streetLotsVisual[1].visible, false);
assert.equal(scene.streetLotsVisual[2].visible, true, 'south lot returns after vertical camera travel');
assert.equal(scene._streetPortalVisuals[1].objects[0].visible, false);

console.log('PASS: Willow Walk x/y lot and portal culling with quantized camera keys');