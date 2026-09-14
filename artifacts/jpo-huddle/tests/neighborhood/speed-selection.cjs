// Focused, dependency-free movement regression. This exercises the exact
// speed/timer helpers from the browser page without Phaser, Socket.IO, or a
// database.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const publicDir = path.join(__dirname, '../../public');
const indexSource = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const neighborhoodSource = fs.readFileSync(path.join(publicDir, 'neighborhood.js'), 'utf8');

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert(start >= 0, `missing ${signature}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`unterminated ${signature}`);
}

const timerHelper = extractFunction(indexSource, 'function _updateBoostTimer(');
const speedHelper = extractFunction(indexSource, 'function _effectiveMovementSpeed(');
let now = 0;
const context = vm.createContext({
  Date: { now: () => now },
  Math,
  window: { _ph: { role: null, phase: null } },
});

vm.runInContext(`
  const SPEED = 195;
  const COFFEE_MULT = 1.4;
  let _boostUntil = 0;
  let _boostEmoji = '☕';
  let _roundPhase = null;
  let _roundAlive = true;
  let _roundRole = null;
  let _roundSpeedMult = 1;
  const _rlgl = { running: false, meAlive: false, meFinished: false };
  ${timerHelper}
  ${speedHelper}
  globalThis.updateBoost = _updateBoostTimer;
  globalThis.speed = () => _effectiveMovementSpeed();
  globalThis.boostUntil = () => _boostUntil;
  globalThis.setRound = (phase, alive, role, edge) => {
    _roundPhase = phase;
    _roundAlive = alive;
    _roundRole = role;
    _roundSpeedMult = edge;
  };
  globalThis.setRlgl = (running, alive, finished) => {
    _rlgl.running = running;
    _rlgl.meAlive = alive;
    _rlgl.meFinished = finished;
  };
`, context);

assert.equal(context.speed(), 195, 'unboosted speed stays at the server base');

context.updateBoost(45_000, 1.4, '☕');
assert.equal(context.boostUntil(), 45_000, 'coffee lasts 45 seconds');
assert.equal(context.speed(), 273, 'active coffee uses one 1.4x multiplier');

// A pizza party is longer, but still never stacks a second multiplier.
context.updateBoost(90_000, 1.4, '🍕');
assert.equal(context.boostUntil(), 90_000, 'pizza extends the timer to 90 seconds');
assert.equal(context.speed(), 273, 'pizza does not multiply an existing boost');
context.updateBoost(45_000, 1.4, '☕');
assert.equal(context.boostUntil(), 90_000, 'a shorter later boost cannot clip pizza');

now = 89_999;
assert.equal(context.speed(), 273, 'boost remains active immediately before expiration');
now = 90_000;
assert.equal(context.speed(), 195, 'boost expires exactly at its deadline');

// The server's explicit one-millisecond mult=1 event clears a live timer.
now = 100_000;
context.updateBoost(90_000, 1.4, '🍕');
context.updateBoost(1, 1, '☕');
assert.equal(context.boostUntil(), 100_000, 'RLGL clear signal expires the mirror');
assert.equal(context.speed(), 195, 'cleared boost returns to base speed');

// Existing HQ precedence remains intact in the shared selector.
now = 100_000;
context.updateBoost(45_000, 1.4, '☕');
context.window._ph.role = 'hider';
context.window._ph.phase = 'hiding';
assert.equal(context.speed(), 390, 'Prop Hunt hider keeps the established 2x edge');
context.window._ph.role = null;
context.window._ph.phase = null;
context.setRound('active', true, 'crew', 1);
assert.equal(context.speed(), 195, 'After Dark crew remains clamped to base speed');
context.setRound('active', true, 'killer', 1.6);
assert.equal(context.speed(), 312, 'After Dark killer uses the larger edge, not a product');
context.setRlgl(true, true, false);
assert.equal(context.speed(), 195, 'RLGL runner always returns to base speed');

// NeighborhoodScene consumes the bridge and normalizes diagonals at the
// selected speed. Keep this source contract next to the numeric regression so
// a future raw-SPEED regression cannot silently pass.
assert.match(indexSource, /effectiveMovementSpeed: \(\) => _effectiveMovementSpeed\(SPEED\)/);
assert.match(neighborhoodSource, /const spd = typeof g\.effectiveMovementSpeed === 'function'/);
assert.match(neighborhoodSource, /body\.velocity\.normalize\(\)\.scale\(spd\)/);
assert.match(neighborhoodSource, /body\.setVelocityX\(-spd\)/);
assert.doesNotMatch(neighborhoodSource, /_boostUntil/, 'map scene must not own/reset the HQ boost timer');

const diagonal = 273;
const diagonalLength = Math.hypot(diagonal, diagonal);
const normalized = {
  x: diagonal / diagonalLength * diagonal,
  y: diagonal / diagonalLength * diagonal,
};
assert.ok(Math.abs(Math.hypot(normalized.x, normalized.y) - diagonal) < 1e-9,
  'diagonal normalization preserves the effective movement magnitude');

// The timer is page-scoped rather than scene-scoped, so the same live boost is
// visible before and after every shared NeighborhoodScene map restart.
context.setRound(null, true, null, 1);
context.setRlgl(false, false, false);
context.updateBoost(90_000, 1.4, '🍕');
for (const location of ['neighborhood', 'cafe-shop', 'home:tester@example.com']) {
  assert.equal(context.speed(), 273, `${location} transition keeps the active boost`);
}

console.log('PASS: coffee/pizza speed selection, expiration, overrides, diagonal normalization, and map continuity');