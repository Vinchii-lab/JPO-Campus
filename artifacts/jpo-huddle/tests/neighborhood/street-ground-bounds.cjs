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
${method('_fitNeighborhoodCamera', '_drawNeighborhood')}
${method('_tileField', '_streetYardKey')}
${method('_drawNeighborhood', '_residenceSignText')}
    _path() { this.paths = (this.paths || 0) + 1; }
    _roadDetails() { this.roads = (this.roads || 0) + 1; }
    _streetSurfaceTexture() { this.roads = (this.roads || 0) + 1; return 'shared-road'; }
    _exterior() { return {}; }
    _sign() { return { setText() {} }; }
    _residenceSignText() { return 'LOT'; }
    _drawResidenceStage() { return []; }
    _drawStreetYard() { return []; }
    _streetYardKey() { return ''; }
  }
  return new Neighborhood();
})()`, { syncZoomControls() {} });

let positions = 0;
const canvasSizes = [];
const graphics = {
  fillStyle() { return this; }, fillRect() { return this; },
  lineStyle() { return this; }, strokeRect() { return this; },
  fillCircle() { return this; }, generateTexture(_key, width, height) { canvasSizes.push({ width, height }); }, destroy() {},
};
scene.textures = { exists: () => false };
scene.make = { graphics: () => graphics };
scene.add = {
  tileSprite() { throw new Error('Ground must not repaint Canvas TileSprites while walking'); },
  image() {
    return {
      setOrigin() { return this; }, setDepth() { return this; },
      setVisible(value) { this.visible = value; return this; },
      setScale(value) { this.scale = value; return this; },
      setPosition(x, y) { positions++; this.x = x; this.y = y; return this; },
    };
  },
};
scene.cameras = { main: { scrollX: 0, scrollY: 0 } };
scene.mapWidth = 1440;
scene.mapHeight = 960 * 10000 + 96; // sparse durable lot far down Willow Walk
scene.scale = { width: 1440, height: 900 };
scene._tileField(0x77a45f, 0x6f9b59);
assert.equal(canvasSizes.length, 1, 'one shared pattern, independent of street height');
assert(canvasSizes.every(({ width, height }) => width === 240 && height === 240));
scene.cameras.main.zoom = 0.7;
scene._syncTileField();
for (const zoom of [0.5, 0.7, 1, 4]) {
  scene.cameras.main.zoom = zoom;
  scene._syncTileField();
  const visible = scene._groundTiles.filter(t => t.visible);
  const left = 720 * (1 - 1 / zoom), top = 450 * (1 - 1 / zoom);
  assert(Math.min(...visible.map(t => t.x)) <= left);
  assert(Math.max(...visible.map(t => t.x + 240)) >= left + 1440 / zoom);
  assert(Math.min(...visible.map(t => t.y)) <= top);
  assert(Math.max(...visible.map(t => t.y + 240)) >= top + 900 / zoom);
  assert(scene._groundTiles.length < 200, 'pool stays viewport-bounded even in a huge world');
}
scene.cameras.main.zoom = 1;
scene._syncTileField();
const beforePan = positions;
for (let x = 1; x < 100; x++) { scene.cameras.main.scrollX = x; scene._syncTileField(); }
assert.equal(positions, beforePan, 'sub-chunk camera travel does not update/repaint ground objects');
scene.cameras.main.zoom = 0.7;

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

scene.cameras.main.setZoom = function (zoom) { this.zoom = zoom; };
scene.location = 'neighborhood';
scene.mapWidth = 1440;
for (const width of [390, 1024, 1920, 2560]) {
  scene.cameras.main.width = width;
  scene.cameras.main.height = 900;
  scene._fitNeighborhoodCamera();
  assert.equal(scene.cameras.main.zoom, 1, 'viewport fitting does not override HQ zoom');
}
scene.location = 'city';
scene.mapWidth = 1152;
scene.mapHeight = 912;
scene._fitNeighborhoodCamera();
const fittedZoom = scene.cameras.main.zoom;
scene._setOutdoorZoom(2);
assert(scene.cameras.main.zoom > fittedZoom, 'outdoor zoom can increase');
scene._fitNeighborhoodCamera();
assert.equal(scene.cameras.main.zoom, 2, 'update preserves manual zoom');
scene._setOutdoorZoom(0.1);
assert.equal(scene.cameras.main.zoom, 0.5, 'zoom out matches HQ minimum');
scene._setOutdoorZoom(10);
assert.equal(scene.cameras.main.zoom, 4, 'zoom in matches HQ maximum');
scene.location = 'home:owner';
scene._fitNeighborhoodCamera();
assert.equal(scene.cameras.main.zoom, 4, 'interiors preserve chosen zoom');

console.log('PASS: pooled immutable ground, no per-frame ground updates, bounded scenery, HQ zoom, and live lot signs');