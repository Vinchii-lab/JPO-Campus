// Browser-free contracts for the cashier DOM bubble's camera projection and
// viewport clamping. The actual speech bubble still uses the browser's
// getBoundingClientRect; these cases cover the deterministic math around it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '../../public/neighborhood-ui.js'), 'utf8');
const sceneSource = fs.readFileSync(path.join(here, '../../public/neighborhood.js'), 'utf8');
const context = { window: {}, console };
vm.runInNewContext(source, context);
const anchor = context.window.JpoCashierSpeechBubble;
assert(anchor, 'cashier anchoring helpers are exported');

const point = anchor.worldToClientPoint(
  { x: 260, y: 180 },
  { x: 0, y: 0, scrollX: 100, scrollY: 50, zoom: 2, originX: 0, originY: 0, width: 800, height: 600 },
  { left: 20, top: 10, width: 800, height: 600 },
  800,
  600,
);
assert.deepEqual({ x: point.x, y: point.y }, { x: 340, y: 270 },
  'world coordinates project through camera zoom and canvas bounds');
const zoomedCenter = anchor.worldToClientPoint(
  { x: 2397, y: 1348 },
  {
    x: 0, y: 0, scrollX: 1757, scrollY: 988, zoom: 0.267,
    originX: 0.5, originY: 0.5, width: 1280, height: 720,
  },
  { left: 0, top: 0, width: 1280, height: 720 },
  1280,
  720,
);
assert(Math.abs(zoomedCenter.x - 640) < 0.01 && Math.abs(zoomedCenter.y - 360) < 0.01,
  'zoomed camera origin keeps a centered world actor centered in the canvas');

const centered = anchor.computeBubblePosition(
  point,
  { width: 240, height: 120 },
  { left: 0, top: 0, right: 840, bottom: 600 },
);
assert.equal(centered.placement, 'bottom', 'bubble prefers the space above the cashier');
assert.equal(centered.left, 220);
assert.equal(centered.top, 140);
assert.equal(centered.tailX, 120, 'tail remains over the cashier after centering');

const leftClamped = anchor.computeBubblePosition(
  { x: 4, y: 300 },
  { width: 260, height: 100 },
  { left: 0, top: 0, right: 320, bottom: 480 },
);
assert.equal(leftClamped.left, 12, 'bubble stays inside the left viewport gutter');
assert(leftClamped.tailX < 16.1, 'tail points toward an edge cashier after horizontal clamping');

const topFallback = anchor.computeBubblePosition(
  { x: 160, y: 30 },
  { width: 220, height: 110 },
  { left: 0, top: 0, right: 320, bottom: 480 },
);
assert.equal(topFallback.placement, 'top', 'bubble flips its tail when there is no room above');
assert(topFallback.top >= 12, 'top fallback remains within the viewport');

assert.match(source, /element\.hidden = true[\s\S]{0,180}offscreen/,
  'offscreen projection hides the bubble before lifecycle teardown closes it');
assert.match(sceneSource, /if \(result\?\.offscreen\) closeCashier\(\)/,
  'offscreen cashiers close the active dialogue rather than leaving a hidden overlay');
assert.match(sceneSource, /window\.addEventListener\('resize', scheduleCashierBubblePosition\)/,
  'resize schedules a fresh camera-to-client projection');
assert.match(sceneSource, /cancelCashierBubbleFrame\(\);\s*cashierOpen = false/,
  'closing cancels the pending frame before clearing cashier state');
assert.match(sceneSource, /event\.key !== 'Escape'[\s\S]{0,160}closeCashier\(\)/,
  'Escape closes the active cashier dialogue');
assert.match(sceneSource, /Walking remains available while speaking/,
  'dialogue does not disable the normal movement path used for range teardown');
console.log('PASS: cashier world projection, clamping, tail orientation, and offscreen contract');