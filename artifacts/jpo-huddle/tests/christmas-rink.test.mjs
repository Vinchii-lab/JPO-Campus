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

const clear = (c, r) => at('Floor', c, r) > 0 && !at('Wall', c, r) && !at('Furniture', c, r);
const walled = (c, r) => c >= 0 && r >= 0 && c < map.width && r < map.height && at('Wall', c, r) > 0;
const isDoor = (c, r) => {
  if (!clear(c, r)) return false;
  for (let d = 1; d <= 5; d++) for (let e = 1; e <= 5; e++) {
    if (walled(c - d, r) && walled(c + e, r) && d + e <= 6) return true;
    if (walled(c, r - d) && walled(c, r + e) && d + e <= 3) return true;
  }
  return false;
};

test('multiple patch envelopes are clear indoor floor, spread out, away from aisle/spawn/doors/anchors', () => {
  const { Rink, Office } = fixture({ withOffice: true });
  const P = Rink.PATCHES;
  assert.equal(P.length, 10, 'exactly ten patches');
  assert.deepEqual(JSON.parse(JSON.stringify(P.map(p => [p.col, p.row, p.cols, p.rows]))),
    [[44, 34, 6, 8], [92, 30, 6, 12], [158, 35, 13, 7], [68, 55, 10, 8], [124, 72, 23, 7],
     [151, 57, 10, 12], [34, 86, 7, 6], [65, 82, 7, 9], [82, 86, 32, 6], [162, 97, 26, 5]]);
  // Distinct rooms, varied sides, at most one cafeteria patch.
  assert.equal(new Set(P.map(p => p.room)).size, 10);
  assert.ok(new Set(P.map(p => p.side)).size >= 4);
  assert.equal(P.filter(p => /cafeteria/i.test(p.room)).length, 1);
  // Building-wide: north (r<43) and south halves, west and east wings.
  assert.ok(P.filter(p => p.row + p.rows < 43).length >= 3);
  assert.ok(P.filter(p => p.row > 80).length >= 3);
  assert.ok(P.some(p => p.col < 50) && P.some(p => p.col > 150));
  for (const p of P) {
    assert.ok(p.col >= 31, `${p.id} indoors (lawn is c<30)`);
    // Envelope + 1-tile ring clear (the ice blob sits >=1 sub-cell inside the
    // envelope, so the whole foot body on ice is >=1 tile from any blocker).
    for (let c = p.col - 1; c < p.col + p.cols + 1; c++) for (let r = p.row - 1; r < p.row + p.rows + 1; r++)
      assert.ok(clear(c, r), `${p.id} clear ${c},${r}`);
    for (let c = p.col - 2; c < p.col + p.cols + 2; c++) for (let r = p.row - 2; r < p.row + p.rows + 2; r++)
      assert.ok(!isDoor(c, r), `${p.id} doorway near ${c},${r}`);
    assert.ok(p.row > 51 || p.row + p.rows < 43, `${p.id} off main aisle`);
    const far = (c, r, d) => c < p.col - d || c >= p.col + p.cols + d || r < p.row - d || r >= p.row + p.rows + d;
    assert.ok(far(110, 46, 5) && far(26, 47, 5), 'spawns');
    for (const a of Object.values(Office.ANCHORS)) assert.ok(far(a.col, a.row, 5), a.id);
  }
  // Spread: pairwise separated by >=4 tiles, and span both halves of HQ.
  for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
    const a = P[i], b = P[j];
    const gap = Math.max(b.col - (a.col + a.cols), a.col - (b.col + b.cols), b.row - (a.row + a.rows), a.row - (b.row + b.rows));
    assert.ok(gap >= 4, `${a.id}/${b.id} separated`);
  }
  assert.ok(Math.max(...P.map(p => p.col)) - Math.min(...P.map(p => p.col)) >= 60);
  // Bigger than the old 7x10 rink, with at least one long glide lane.
  assert.ok(P.some(p => p.cols >= 30));
  assert.ok(P.reduce((s, p) => s + p.cols * p.rows, 0) > 10 * 70);
});

test('shapes are irregular (not rectangles), stay inside envelope, ice nested inside snow', () => {
  const { Rink } = fixture();
  Rink.PATCHES.forEach((p, k) => {
    const sh = Rink.shape(k), iceAt1 = [], rowsSpan = [];
    for (let j = 0; j < sh.h; j++) {
      let lo = Infinity, hi = -1;
      for (let i = 0; i < sh.w; i++) {
        const snow = sh.s[j * sh.w + i] >= Rink.snowCut(1), ice = Rink.isIceCell(k, i, j, 1);
        if (ice) { iceAt1.push(1); lo = Math.min(lo, i); hi = Math.max(hi, i); }
        if (i === 0 || j === 0 || i === sh.w - 1 || j === sh.h - 1) assert.ok(!snow && !ice, `${p.id} edge cell empty`);
      }
      if (hi >= 0) rowsSpan.push(hi - lo);
    }
    // Ice coverage well below the bounding rectangle, and row widths vary.
    assert.ok(iceAt1.length < sh.w * sh.h * 0.6 && iceAt1.length > sh.w * sh.h * 0.15, `${p.id} ice fraction`);
    assert.ok(new Set(rowsSpan).size >= 3, `${p.id} irregular rows`);
    // Corners of the envelope never slip.
    const x0 = p.col * 48, y0 = p.row * 48;
    assert.equal(Rink.containsBody(x0 + 20, y0 + 20 - 27 + 16, 1), false);
  });
});

test('slippery geometry equals painted ice cells with full foot containment, and grows', () => {
  const { Rink } = fixture();
  const { FOOT_OFFSET_Y: OY, HALF_W, HALF_H } = Rink.FOOT;
  let longest = 0;
  Rink.PATCHES.forEach((p, k) => {
    const sh = Rink.shape(k), ox = p.col * 48, oy = p.row * 48;
    let prev = 0;
    for (const prog of [0.49, 0.5, 0.75, 1]) {
      let count = 0;
      for (let y = oy; y < oy + p.rows * 48; y += 6) for (let x = ox; x < ox + p.cols * 48; x += 6) {
        const yy = y - OY, got = Rink.containsBody(x, yy, prog);
        // brute-force reference: every 12px cell under the foot box is ice
        let ref = prog >= 0.5;
        for (let j = Math.floor((y - HALF_H - oy) / 12); ref && j <= Math.ceil((y + HALF_H - oy) / 12) - 1; j++)
          for (let i = Math.floor((x - HALF_W - ox) / 12); i <= Math.ceil((x + HALF_W - ox) / 12) - 1; i++)
            if (!Rink.isIceCell(k, i, j, prog)) { ref = false; break; }
        assert.equal(got, ref, `${p.id} ${x},${y} p=${prog}`);
        if (got) count++;
      }
      if (prog < 0.5) assert.equal(count, 0);
      else assert.ok(count > prev, `${p.id} grows at ${prog}`);
      prev = count;
    }
    // Long glide: widest contiguous slippery run along the centre row.
    const cy = oy + p.rows * 24 - OY; let run = 0, best = 0;
    for (let x = ox; x < ox + p.cols * 48; x += 6) { run = Rink.containsBody(x, cy, 1) ? run + 6 : 0; best = Math.max(best, run); }
    longest = Math.max(longest, best);
    // Narrow rooms glide along their long axis (centre column).
    const cx = ox + p.cols * 24; run = 0;
    for (let y = oy; y < oy + p.rows * 48; y += 6) { run = Rink.containsBody(cx, y - OY, 1) ? run + 6 : 0; best = Math.max(best, run); }
    assert.ok(best >= 150, `${p.id} glide ${best}`);
    void sh;
  });
  assert.ok(longest >= 750, `longest glide ${longest}`);
});

test('runtime fails closed per patch when floor is blocked', () => {
  const f = fixture();
  const P = f.Rink.PATCHES[0], real = f.scene.furnitureLayer;
  f.scene.furnitureLayer = { getTileAt: (c, r) => (c === P.col + 5 && r === P.row + 2 ? { index: 99 } : real.getTileAt(c, r)) };
  const cleanup = f.Rink.mount(f.scene, { reduced: true });
  const rep = cleanup.report();
  assert.equal(rep.patches[0].mounted, false);
  assert.ok(rep.patches.slice(1).every(p => p.mounted));
  assert.equal(f.warnings.length, 1);
  f.window._christmasSnowStartedAt = Date.now() - 200000;
  const cx = (P.col + P.cols / 2) * 48, cy = (P.row + P.rows / 2) * 48 - 27;
  assert.equal(f.Rink.containsBody(cx, cy, 1), true);
  assert.equal(f.scene._christmasRink.isSlippery(cx, cy), false);
  cleanup();
  const g = fixture();
  g.scene.floorLayer = { getTileAt: () => ({ index: -1 }) };
  const c2 = g.Rink.mount(g.scene, { reduced: true });
  assert.equal(c2.report().mounted, false);
  assert.equal(g.scene._christmasRink, undefined);
  assert.equal(g.objects.length, 0);
  c2();
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

test('isSlippery needs ice (server clock) and full foot body inside an ice core', () => {
  const f = fixture(), cleanup = f.Rink.mount(f.scene, { reduced: true });
  const rink = f.scene._christmasRink;
  assert.equal(rink.mounted, true);
  assert.equal(rink.patches.length, f.Rink.PATCHES.length);
  for (const P of f.Rink.PATCHES) {
    const cx = (P.col + P.cols / 2) * 48, cy = (P.row + P.rows / 2) * 48 - 27;
    f.window._christmasSnowStartedAt = null;
    assert.equal(rink.progress(), 0); assert.equal(rink.isSlippery(cx, cy), false);
    f.window._christmasSnowStartedAt = Date.now() - 30000; f.window._christmasServerOffsetMs = 0;
    assert.equal(rink.isSlippery(cx, cy), false);
    f.window._christmasSnowStartedAt = Date.now() - 61000;
    assert.equal(rink.isSlippery(cx, cy), true, P.id);
    assert.equal(rink.patchAt(cx, cy), P.id);
    // Walk out along x: once false, stays false (no stray slippery islands at the rim).
    let x = cx; while (rink.isSlippery(x, cy)) x += 3;
    for (let k = 0; k < 40; k++) assert.equal(rink.isSlippery(x + k * 3, cy), false);
    // Full body: a single pixel step past containment flips it.
    assert.equal(rink.isSlippery(x - 3, cy), true);
    assert.equal(rink.isSlippery(P.col * 48 + 17, cy), false);
  }
  assert.equal(rink.isSlippery(110 * 48, 46 * 48), false);
  assert.equal(rink.label(), 'Ice ready');
  cleanup();
  assert.equal(rink.isSlippery((82 + 16) * 48, (86 + 3) * 48 - 27), false);
  assert.equal(rink.isSlippery((124 + 11.5) * 48, (72 + 3.5) * 48 - 27), false);
});

test('lifecycle: repeat mount, shutdown, reduced, and office integration', () => {
  const f = fixture();
  const a = f.Rink.mount(f.scene, { reduced: false });
  assert.equal(f.updates.size, 1); assert.equal(a.report().tweens, 1);
  assert.equal(a.report().objects, 2 * f.Rink.PATCHES.length);
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
  // No signage, labels-on-map or checker borders.
  assert.doesNotMatch(rinkCode, /add\.text|SKATING|paintBorder/);
});
