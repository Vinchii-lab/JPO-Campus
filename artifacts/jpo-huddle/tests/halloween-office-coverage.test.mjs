import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

const code = readFileSync(new URL('../public/halloween-office.js', import.meta.url), 'utf8');
const map = JSON.parse(readFileSync(new URL('../public/assets/JPO_HQ.tmj', import.meta.url), 'utf8'));

// Execute the production renderer against authentic map tiles, not synthetic
// room rectangles. Rendering methods alone are mocked; native screenshots
// remain necessary for visual acceptance.
function fixture() {
  const objects = [], tweens = [], warnings = [];
  const window = {};
  vm.runInNewContext(code, { window, console: { warn: (...args) => warnings.push(args) } });
  const scene = {
    events: new EventEmitter(),
    children: { moveAbove() {} },
    add: {
      graphics(config) {
        const object = { ...config, destroyed: false, destroy() { this.destroyed = true; } };
        for (const method of ['setDepth', 'setScale', 'setAlpha', 'fillStyle', 'fillRect', 'lineStyle', 'lineBetween'])
          object[method] = () => object;
        objects.push(object);
        return object;
      }
    },
    tweens: {
      add(config) {
        const tween = { config, removed: false, remove() { this.removed = true; } };
        tweens.push(tween);
        return tween;
      }
    }
  };
  for (const [key, name] of [['floorLayer', 'Floor'], ['wallLayer', 'Wall'], ['furnitureLayer', 'Furniture']]) {
    const layer = map.layers.find(l => l.name === name);
    scene[key] = { getTileAt(c, r) { return { index: layer.data[r * map.width + c] || -1 }; } };
  }
  return { scene, objects, tweens, warnings, mount: window.HalloweenOffice.mount };
}

test('authored physical-room coverage mounts every web and thematic vignette on the real HQ map', () => {
  const f = fixture(), cleanup = f.mount(f.scene), report = cleanup.report();
  assert.equal(report.rooms.length, 34);
  assert.equal(new Set(report.rooms.map(r => r.room)).size, 34);
  assert.equal(report.rooms.filter(r => !r.mounted).length, 0);
  assert.equal(report.props.length, 12);
  assert.equal(report.props.filter(p => !p.mounted).length, 0);
  assert.equal(f.warnings.length, 0);
  assert.ok(report.rooms.every(r => r.col >= 32), 'no garden decorations');
  assert.ok(report.tweens < 30, 'bounded animations, not one tween per decorative pixel');
  cleanup();
});

test('repeat mount, season cleanup, shutdown and destroy release all objects and tweens', () => {
  const f = fixture(), first = f.mount(f.scene);
  const oldObjects = [...f.objects], oldTweens = [...f.tweens];
  const second = f.mount(f.scene);
  assert.equal(first.report().destroyed, true);
  assert.ok(oldObjects.every(o => o.destroyed));
  assert.ok(oldTweens.every(t => t.removed));
  assert.equal(f.scene.events.listenerCount('shutdown'), 1);
  assert.equal(f.scene.events.listenerCount('destroy'), 1);
  // This is the same cleanup function the authoritative season listener owns.
  second(); second();
  assert.ok(f.objects.every(o => o.destroyed));
  assert.ok(f.tweens.every(t => t.removed));
  assert.equal(f.scene.events.listenerCount('shutdown'), 0);
  assert.equal(f.scene.events.listenerCount('destroy'), 0);
  for (const event of ['shutdown', 'destroy']) {
    const cleanup = f.mount(f.scene);
    f.scene.events.emit(event);
    assert.equal(cleanup.report().destroyed, true);
    assert.ok(f.objects.every(o => o.destroyed));
    assert.ok(f.tweens.every(t => t.removed));
  }
});