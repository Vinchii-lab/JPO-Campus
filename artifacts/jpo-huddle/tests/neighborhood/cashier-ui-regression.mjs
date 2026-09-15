// Browser-free cashier UI contracts: commercial rooms start closed, the
// scripted dialogue emits the server protocol, and range/room changes close
// stale dialogs before another room can render.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMERCIAL_CASHIERS,
  parseLocation,
  validLocationMove,
} from '../../neighborhood.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sceneSource = fs.readFileSync(path.join(here, '../../public/neighborhood.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(here, '../../public/neighborhood-ui.js'), 'utf8');

const expected = ['furniture-shop', 'garden-shop', 'decor-shop', 'cafe', 'diner', 'bakery', 'sushi'];
assert.deepEqual(Object.keys(COMMERCIAL_CASHIERS), expected,
  'all seven commercial rooms have one fixed cashier');
const ids = new Set();
for (const location of expected) {
  const cashier = COMMERCIAL_CASHIERS[location];
  assert(cashier.name && cashier.character, `${location}: cashier has a visible identity`);
  assert(!ids.has(cashier.id), `${location}: cashier id is unique`);
  ids.add(cashier.id);
  assert(validLocationMove(parseLocation(location), cashier.x, cashier.y),
    `${location}: cashier stand is collision-valid`);
  assert.match(cashier.greeting, /\S/, `${location}: cashier greeting is authored`);
  assert.match(cashier.info, /\S/, `${location}: cashier information is authored`);
}
assert.equal(COMMERCIAL_CASHIERS['furniture-shop'].kind, 'furniture');
for (const location of ['cafe', 'diner', 'bakery', 'sushi']) {
  assert.equal(COMMERCIAL_CASHIERS[location].kind, 'food');
  assert.match(COMMERCIAL_CASHIERS[location].menuKey, /^\w+$/);
}

assert.match(uiSource, /if \(!ctx\.isShop \|\| !ctx\.cashierOpen \|\| !ctx\.cashier\)/,
  'shop panel stays hidden until a cashier dialogue is open');
assert.match(uiSource, /data-browse[\s\S]{0,180}ctx\.onOpenMenu\?\.\(\)/,
  'Browse requests the server-backed cashier menu');
assert.match(uiSource, /data-buy-menu[\s\S]{0,180}ctx\.onOpenMenu\?\.\(\)/,
  'Buy requests the same server-backed cashier menu');
assert.match(uiSource, /data-goodbye[\s\S]{0,160}ctx\.onGoodbye\?\.\(\)/,
  'Goodbye invokes the cashier close callback');

assert.match(sceneSource, /socket\.emit\('cashierMenuRequest', \{ cashierId: activeCashier\.id \}\)/,
  'Browse/Buy protocol sends only the fixed cashier id');
assert.match(sceneSource, /socket\.emit\('buyFood', \{\s*cashierId: activeCashier\.id, station: activeCashier\.id, item: id,\s*\}\)/,
  'food purchase protocol carries the fixed cashier id and server item id');
assert.match(sceneSource, /socket\.emit\('homePurchase', \{ cashierId: activeCashier\.id, furnitureId: id \}\)/,
  'furniture purchase protocol carries the fixed cashier id and server item id');
assert.match(sceneSource, /if \(cashierOpen && \(!nearbyCashier \|\| nearbyCashier\.id !== activeCashier\?\.id\)\) closeCashier\(\)/,
  'range exit closes the active dialogue');
assert.match(sceneSource, /else if \(this\.nearbyCashier\) this\._interactCashier\(\)/,
  'E/touch interaction chooses the visible nearby cashier before showroom actions');

const transitionStart = sceneSource.indexOf('const finish = () => {');
const transitionEnd = sceneSource.indexOf('currentLocation = result.location;', transitionStart);
assert(transitionStart >= 0 && transitionEnd > transitionStart);
assert(sceneSource.slice(transitionStart, transitionEnd).includes('closeCashier();'),
  'room entry clears any previous cashier dialog before applying the new room');
assert(sceneSource.slice(transitionStart, transitionEnd).includes('nearbyCashier = null;'),
  'room entry clears stale cashier proximity');

console.log('PASS: fixed cashier identities, closed room entry, Browse/Buy/Goodbye protocol, and range teardown');