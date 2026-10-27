import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

const rinkCode = readFileSync(new URL('../public/christmas-rink.js', import.meta.url), 'utf8');
const officeCode = readFileSync(new URL('../public/christmas-office.js', import.meta.url), 'utf8');
const map = JSON.parse(readFileSync(new URL('../public/assets/JPO_HQ.tmj', import.meta.url), 'utf8'));
const layer = (n) => map.layers.find(l => l.name === n);
const at = (n, c, r) => layer(n).data[r * map.width + c] || 0;

function fixture({ withOffice = false } = {}) {
  const objects = [], tweens = [], warnings = [], updates = new Set();
  const window = { matchMedia: () => ({ matches: false }) };
  const ctx = { window, Date, console: { warn: (...a) => warnings.push(a) }, localStorage: { getItem: () => null } };
  ctx.globalThis = ctx;
  vm.runInNewContext(rinkCode, ctx);
  if (withOffice) vm.runInNewContext(officeCode, ctx);
  const events = new EventEmitter();
  const on = events.on.bind(events), off = events.off.bind(events);
  events.on = (n, f) => { if (n === 'update') updates.add(f); return on(n, f); };
  events.off = (n, f) => { if (n === 'update') updates.delete(f); return off(n, f); };
  const obj = (extra) => {
    const o = { ...extra, destroyed: false, visible: true, text: '', destroy() { this.destroyed = true; } };
    for (const m of ['setDepth', 'setScale', 'setAlpha', 'fillStyle', 'fillRect', 'clear', 'setTileScale', 'setOrigin']) o[m] = () => o;
    o.setScrollFactor = (v) => { o.scrollFactorX = v; return o; };
    o.setVisible = (v) => { o.visible = v; return o; };
    o.setText = (t) => { o.text = t; return o; };
    objects.push(o); return o;
  };
  const scene = {
    events, children: { moveAbove() {} }, scale: { width: 800, height: 600 }, textures: { exists: () => true },
    add: { graphics: (c) => obj(c), rectangle: () => obj({}), tileSprite: () => obj({}), text: () => obj({}) },
    tweens: { add(config) { const t = { config, removed: false, remove() { this.removed = true; } }; tweens.push(t); return t; } }
  };
  for (const [key, name] of [['floorLayer', 'Floor'], ['wallLayer', 'Wall'], ['furnitureLayer', 'Furniture']]) {
    const l = layer(name);
    scene[key] = { getTileAt(c, r) { return { index: l.data[r * map.width + c] || -1 }; } };
  }
  return { scene, objects, tweens, warnings, updates, window, Rink: window.ChristmasRink, Office: window.ChristmasOffice };
}

test('authored rink rectangle is clear indoor floor with margin, away from props/spawn/doors', () => {
  const { Rink, Office } = fixture({ withOffice: true });
  const { col, row, cols, rows } = Rink.RECT;
  assert.deepEqual({ col, row, cols, rows }, { col: 141, row: 56, cols: 7, rows: 10 });
  for (let c = col - 1; c <= col + cols; c++) for (let r = row - 1; r <= row + rows; r++) {
    assert.ok(at('Floor', c, r) > 0, `floor ${c},${r}`);
    assert.equal(at('Wall', c, r), 0, `wall ${c},${r}`);
    assert.equal(at('Furniture', c, r), 0, `furniture ${c},${r}`);
  }
  // Indoors: east cafeteria wall at c149 bounds it; ceiling wall run at r43.
  assert.ok(at('Wall', 149, 60) > 0 && at('Wall', 145, 43) > 0);
  // Not on the r44-50 main aisle, >=3 rows from the c149 r69-71 doorway.
  assert.ok(row > 51 && row + rows <= 66);
  const far = (c, r, d) => c < col - d || c > col + cols + d || r < row - d || r > row + rows + d;
  assert.ok(far(110, 46, 4), 'HQ spawn'); assert.ok(far(26, 47, 4), 'lawn spawn');
  for (const a of Object.values(Office.ANCHORS)) assert.ok(far(a.col, a.row, 4), a.id);
  assert.equal(Rink.BOUNDS.x, 6768); assert.equal(Rink.BOUNDS.y, 2688);
  assert.equal(Rink.BOUNDS.right, 7104); assert.equal(Rink.BOUNDS.bottom, 3168);
});

test('progress uses server clock, linear 120s, invalid start -> 0', () => {
  const { Rink } = fixture();
  const t0 = 1_700_000_000_000;
  assert.equal(Rink.computeProgress(t0, null, 0), 0);
  assert.equal(Rink.computeProgress(t0, 'garbage', 0), 0);
  assert.equal(Rink.computeProgress(t0, NaN, 0), 0);
  assert.equal(Rink.computeProgress(t0, t0 + 5000, 0), 0);
  assert.equal(Rink.computeProgress(t0 + 60000, t0, 0), 0.5);
  assert.equal(Rink.computeProgress(t0 + 30000, t0, 30000), 0.5);
  assert.equal(Rink.computeProgress(t0 + 999999, t0, 0), 1);
});

test('isSlippery needs ice and full foot body inside bounds', () => {
  const f = fixture(), cleanup = f.Rink.mount(f.scene, { reduced: true });
  const rink = f.scene._christmasRink, B = f.Rink.BOUNDS;
  const cx = B.x + B.w / 2, cy = B.y + B.h / 2 - 27;
  f.window._christmasSnowStartedAt = null;
  assert.equal(rink.progress(), 0); assert.equal(rink.isSlippery(cx, cy), false);
  f.window._christmasSnowStartedAt = Date.now() - 30000; f.window._christmasServerOffsetMs = 0;
  assert.equal(rink.isSlippery(cx, cy), false);
  f.window._christmasSnowStartedAt = Date.now() - 61000;
  assert.equal(rink.isSlippery(cx, cy), true);
  assert.equal(rink.isSlippery(B.left + 18, cy), true);
  assert.equal(rink.isSlippery(B.left + 17, cy), false);
  assert.equal(rink.isSlippery(cx, B.top + 15 - 27), true);
  assert.equal(rink.isSlippery(cx, B.top + 14 - 27), false);
  assert.equal(rink.isSlippery(cx, B.bottom - 15 - 27), true);
  assert.equal(rink.isSlippery(cx, B.bottom - 14 - 27), false);
  assert.equal(rink.label(), 'Ice ready');
  cleanup();
});

test('lifecycle: repeat mount, shutdown, reduced, and office integration', () => {
  const f = fixture();
  const a = f.Rink.mount(f.scene, { reduced: false });
  assert.equal(f.updates.size, 1); assert.equal(a.report().tweens, 1);
  const b = f.Rink.mount(f.scene, { reduced: true });
  assert.ok(a.report().destroyed); assert.equal(f.updates.size, 1); assert.equal(b.report().tweens, 0);
  assert.equal(f.scene._christmasRink, b.api);
  a(); // stale cleanup must not clear the new owner
  assert.equal(f.scene._christmasRink, b.api);
  f.scene.events.emit('shutdown');
  assert.equal(f.scene._christmasRink, undefined);
  assert.equal(f.updates.size, 0);
  assert.ok(f.objects.every(o => o.destroyed)); assert.ok(f.tweens.every(t => t.removed));

  const g = fixture({ withOffice: true });
  const off = g.Office.mount(g.scene, { reduced: true });
  assert.ok(g.scene._christmasRink?.bounds);
  assert.equal(g.warnings.length, 0, JSON.stringify(g.warnings));
  off();
  assert.equal(g.scene._christmasRink, undefined);
  assert.equal(g.updates.size, 0);
  assert.ok(g.objects.every(o => o.destroyed));
});

test('no emoji and no map/physics mutation in rink source', () => {
  assert.doesNotMatch(rinkCode, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  assert.doesNotMatch(rinkCode, /physics|putTileAt|setCollision|removeTileAt/);
});
