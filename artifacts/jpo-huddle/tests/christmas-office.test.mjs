import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

const code = readFileSync(new URL('../public/christmas-office.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const map = JSON.parse(readFileSync(new URL('../public/assets/JPO_HQ.tmj', import.meta.url), 'utf8'));
const asset = (p) => new URL('../public/assets/' + p, import.meta.url);

function fixture() {
  const objects = [], tweens = [], warnings = [], updates = new Set();
  const window = { matchMedia: () => ({ matches: false }) };
  const ctx = { window, globalThis: {}, console: { warn: (...a) => warnings.push(a) }, localStorage: { getItem: () => null } };
  ctx.globalThis = ctx;
  vm.runInNewContext(code, ctx);
  const events = new EventEmitter();
  const origOn = events.on.bind(events), origOff = events.off.bind(events);
  events.on = (n, f) => { if (n === 'update') updates.add(f); return origOn(n, f); };
  events.off = (n, f) => { if (n === 'update') updates.delete(f); return origOff(n, f); };
  const obj = (extra) => {
    const o = { ...extra, destroyed: false, visible: true, destroy() { this.destroyed = true; } };
    for (const m of ['setDepth', 'setScale', 'setAlpha', 'fillStyle', 'fillRect', 'clear', 'setTileScale'])
      o[m] = () => o;
    o.setScrollFactor = (v) => { o.scrollFactorX = v; return o; };
    o.setVisible = (v) => { o.visible = v; return o; };
    objects.push(o); return o;
  };
  const scene = {
    events, children: { moveAbove() {} }, scale: { width: 800, height: 600 },
    textures: { exists: () => true },
    add: { graphics: (c) => obj(c), rectangle: () => obj({}), tileSprite: () => obj({}) },
    tweens: { add(config) { const t = { config, removed: false, remove() { this.removed = true; } }; tweens.push(t); return t; } }
  };
  for (const [key, name] of [['floorLayer', 'Floor'], ['wallLayer', 'Wall'], ['furnitureLayer', 'Furniture']]) {
    const layer = map.layers.find(l => l.name === name);
    scene[key] = { getTileAt(c, r) { return { index: layer.data[r * map.width + c] || -1 }; } };
  }
  return { scene, objects, tweens, warnings, updates, api: window.ChristmasOffice, ctx };
}

test('activity anchors sit on clear authored floor pockets and match world px', () => {
  const f = fixture(), cleanup = f.api.mount(f.scene), r = cleanup.report();
  assert.equal(f.warnings.length, 0);
  assert.ok(r.props.every(p => p.mounted), JSON.stringify(r.props.filter(p => !p.mounted)));
  for (const a of Object.values(f.api.ANCHORS)) {
    assert.equal(a.x, (a.col + 1) * 48);
    assert.equal(a.y, Math.round((a.row + 1.5) * 48));
  }
  cleanup();
});

test('cleanup on repeat mount, shutdown and season switch releases everything (snow included)', () => {
  const f = fixture(), first = f.api.mount(f.scene);
  assert.equal(f.updates.size, 1);
  const second = f.api.mount(f.scene);
  assert.ok(first.report().destroyed);
  assert.equal(f.updates.size, 1);
  f.scene.events.emit('shutdown');
  assert.ok(second.report().destroyed);
  assert.equal(f.updates.size, 0);
  assert.ok(f.objects.every(o => o.destroyed));
  assert.ok(f.tweens.every(t => t.removed));
});

test('reduced effects: no snow, no tweens; ornaments follow authoritative counts', () => {
  const f = fixture(), c = f.api.mount(f.scene, { reduced: true });
  assert.equal(f.updates.size, 0);
  assert.equal(c.report().tweens, 0);
  c.setState({ active: true, tree: { contributions: 0, goal: 100 }, delivery: { stage: 'ready' } });
  assert.equal(c.report().ornaments, 0);
  c.setState({ active: true, tree: { contributions: 50, goal: 100 }, delivery: { stage: 'done' } });
  assert.ok(c.report().ornaments > 0 && c.report().ornaments < 27);
  c();
});

test('preview helper is test-only', () => {
  const f = fixture();
  assert.throws(() => f.api.applyPreviewForTest(f.scene));
  f.ctx.__JPO_CHRISTMAS_PREVIEW_TEST__ = true;
  const c = f.api.applyPreviewForTest(f.scene);
  c();
});

test('catalog, slots and assets are wired for every Christmas id', () => {
  const ids = ['santahat', 'reindeerantlers', 'christmasscarf', 'christmassweater', 'elfoutfit', 'snowflakewings'];
  for (const id of ids) {
    assert.match(html, new RegExp(`id: '${id}'[^\\n]*season: 'christmas'`));
    assert.ok(existsSync(asset(`wear_${id}.png`)), id);
    assert.match(html, new RegExp(`${id}:\\s*\\{ tex: 'wear_${id}'`));
  }
  assert.match(html, /christmasscarf: 'neckwear', christmassweater: 'top', elfoutfit: 'top'/);
  assert.match(html, /id: 'pet_reindeer'[^\n]*season: 'christmas'/);
  for (const s of ['', '_s2', '_s3']) {
    assert.ok(existsSync(asset(`pets/pet_reindeer${s}.png`)));
    for (const fr of ['walk1', 'walk2', 'walk3', 'sit', 'action']) assert.ok(existsSync(asset(`pets/anim/reindeer${s}_${fr}.png`)));
  }
  assert.match(html, /_applyOfficeArrival\(state\)/, 'office-arrival fix preserved');
});
