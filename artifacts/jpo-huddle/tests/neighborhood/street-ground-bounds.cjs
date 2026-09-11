// Keep Willow Walk renderable when durable lot numbers make its world tall.
// This runs the real renderer methods with Phaser-sized stubs; it specifically
// guards against reintroducing a world-height TileSprite backing canvas.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '../../public/neighborhood.js'), 'utf8');
function method(name, next) {
  const start = source.indexOf(`    ${name}(`);
  const end = source.indexOf(`\n    ${next}(`, start);
  assert(start >= 0 && end >= 0, `missing renderer method ${name}`);
  return source.slice(start, end);
}

const scene = vm.runInNewContext(`(() => {
  class Neighborhood {
${method('_tileField', '_streetYardKey')}
${method('_drawNeighborhood', '_residenceSignText')}
    _path() { this.paths = (this.paths || 0) + 1; }
    _roadDetails() { this.roads = (this.roads || 0) + 1; }
    _exterior() { return {}; }
    _sign() { return { setText() {} }; }
    _residenceSignText() { return 'LOT'; }
    _drawResidenceStage() { return []; }
    _drawStreetYard() { return []; }
    _streetYardKey() { return ''; }
  }
  return new Neighborhood();
})()`, {});

const canvasSizes = [];
const graphics = {
  fillStyle() { return this; }, fillRect() { return this; },
  lineStyle() { return this; }, strokeRect() { return this; },
  fillCircle() { return this; }, generateTexture() {}, destroy() {},
};
scene.textures = { exists: () => false };
scene.make = { graphics: () => graphics };
scene.add = {
  tileSprite(x, y, width, height) {
    canvasSizes.push({ x, y, width, height });
    return {
      setScrollFactor() { return this; }, setDepth() { return this; },
      setScale(value) { this.scale = value; return this; },
      setPosition(x, y) { this.x = x; this.y = y; return this; },
    };
  },
};
scene.cameras = { main: { scrollX: 0, scrollY: 0 } };
scene.mapWidth = 1440;
scene.mapHeight = 960 * 10000 + 96; // sparse durable lot far down Willow Walk
scene.scale = { width: 1440, height: 900 };
scene._tileField(0x77a45f, 0x6f9b59);
assert.equal(canvasSizes.length, 2, 'ground has viewport pieces only, never one per street segment');
assert(canvasSizes.every(({ width, height }) => width <= 1024 && height <= 1024),
  `TileSprite canvas must stay bounded: ${JSON.stringify(canvasSizes)}`);
scene.cameras.main.zoom = 0.7;
scene._syncTileField();
for (const tile of scene._groundTiles) {
  const screenLeft = (tile.x - tile._groundWidth * tile.scale / 2 - 720) * 0.7 + 720;
  const screenTop = (tile.y - tile._groundHeight * tile.scale / 2 - 450) * 0.7 + 450;
  assert(Math.abs(screenLeft - tile._groundScreenX) < 1e-8, 'zoomed ground must cover left edge');
  assert(Math.abs(screenTop - tile._groundScreenY) < 1e-8, 'zoomed ground must cover top edge');
}

// Drawing a sparse street must derive its range from server map height rather
// than `streetLots.length / 8`, but keep only near-camera scenery alive. The
// lone lot itself is deliberately far down a ten-thousand-segment street.
scene.mapHeight = 960 * 10000 + 96;
scene.info = { streetLots: [{
  lot: 79993, x: 180, bottom: 9599380, northSide: true, construction: { stage: 'empty' }, yard: [],
}] };
scene._drawNeighborhood();
assert.equal(scene.streetSegmentCount, 10000, 'road range derives from canonical map bounds');
assert(scene._streetScenerySegments.size <= 3 && scene.roads <= 3,
  'initial street scenery stays viewport-bounded');
scene.cameras.main.scrollY = 960 * 7500;
scene._syncStreetScenery();
assert(scene._streetScenerySegments.size <= Math.ceil(scene.scale.height / scene.cameras.main.zoom / 960) + 2,
  'camera travel replaces old scenery instead of accumulating every segment');
assert(scene.streetLotsVisual[0].sign, 'residence visual retains its sign for live updates');

console.log('PASS: bounded viewport ground/scenery, height-derived streets, and live lot signs');