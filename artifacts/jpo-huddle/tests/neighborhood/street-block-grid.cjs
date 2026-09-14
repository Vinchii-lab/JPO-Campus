// The server's full street block rectangles are the only source of the
// Willow Walk landscape grid. Sparse permanent lot numbers must not expand or
// reshape that grid on the client.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '../../public/neighborhood.js'), 'utf8');
const start = source.indexOf('    _drawNeighborhood(');
const end = source.indexOf('\n    _residenceSignText(', start);
assert(start >= 0 && end > start);

const scene = vm.runInNewContext(`new (class {
${source.slice(start, end)}
  _tileField() {}
  _path() { return { setVisible() {} }; }
  _drawResidenceStage() { return []; }
  _drawStreetYard() { return []; }
  _streetYardKey() { return ''; }
  _sign() { return {}; }
  _residenceSignText() { return 'LOT'; }
  _exterior(kind, x, y) { return { kind, x, y }; }
})()`);

scene.info = {
  // 132 durable addresses can occupy 17 blocks, but the server sends a
  // complete 5x4 rectangle so every block edge remains connected.
  streetBlocks: Array.from({ length: 20 }, (_, index) => {
    const column = index % 5, row = Math.floor(index / 5);
    return { index, row, column, x: column * 1440, y: row * 960, width: 1440, height: 960 };
  }),
  streetLots: [{ lot: 132, x: 972, bottom: 812, northSide: false }],
};
scene.mapWidth = 7200;
scene.mapHeight = 3936;
scene.cameras = { main: { worldView: { left: 0, top: 0, right: 1440, bottom: 960 }, zoom: 1 } };
scene._syncStreetScenery = () => {};
scene._drawNeighborhood();

assert.equal(scene.streetSegmentCount, 20);
assert.equal(scene.streetBlocks[19].x, 5760);
assert.equal(scene.streetBlocks[19].y, 2880);
assert.equal(scene.streetLotsVisual[0].lot.lot, 132, 'durable lot numbers remain unchanged');

const captured = [];
scene.add = {
  image(x, y, texture) {
    captured.push({ x, y, texture });
    return {
      setOrigin() { return this; },
      setScale() { return this; },
      setDepth() { return this; },
    };
  },
};
scene._streetSurfaceTexture = width => `road:${width}`;
scene._drawStreetSegment(19);
assert.deepEqual(captured[0], { x: 5760, y: 2880, texture: 'road:1440' });

console.log('PASS: authoritative dense Willow Walk 5x4 block grid and sparse lot addresses');