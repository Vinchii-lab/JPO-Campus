const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
const start = source.indexOf('  socket.on("homePurchase",');
const end = source.indexOf('  socket.on("homeLayoutSet",', start);
assert(start >= 0 && end > start);

const CASHIER = { id: 'cashier:furniture-shop', x: 480, y: 340, radius: 116 };

async function purchase({
  location = 'furniture-shop', snapshotFails = false, affordable = true,
  cashierId = CASHIER.id, x = CASHIER.x, y = CASHIER.y,
} = {}) {
  const events = [], queries = [];
  let handler, connections = 0;
  const player = { email: 'purchase-fixture@example.com', coins: 20000, x, y };
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes('UPDATE jpo_players')) return { rows: affordable ? [{ coins: 15000 }] : [] };
      if (sql.includes('INSERT INTO jpo_home_furniture')) return { rows: [{ id: 'owned-fixture' }] };
      return { rows: [] };
    },
    release() {},
  };
  const context = {
    socket: {
      id: 'fixture',
      on(_name, fn) { handler = fn; },
      emit(name, data) { events.push({ name, data }); },
    },
    players: { fixture: player },
    locationOf: () => location,
    validateCommercialCashier: (candidate, id) => {
      if (location !== 'furniture-shop' || id !== CASHIER.id) {
        return { ok: false, code: 'cashier', message: 'That cashier is not available here.' };
      }
      if (Math.hypot(candidate.x - CASHIER.x, candidate.y - CASHIER.y) > CASHIER.radius) {
        return { ok: false, code: 'distance', message: 'Walk closer to Mara.' };
      }
      return { ok: true, locationId: location, cashier: { ...CASHIER, kind: 'furniture' } };
    },
    isShopLocation: value => value === 'furniture-shop',
    homeShopCatalog: () => ({ oak_chair: { price: 5000 } }),
    isHuddleTestIdentity: () => false,
    takeToken: () => true,
    buyBucket: {},
    inAnyMatch: () => false,
    inActiveRound: () => false,
    pool: { async connect() { connections++; return client; } },
    ensureHome: async () => ({}),
    homeSnapshot: async () => {
      if (snapshotFails) throw new Error('simulated read outage after COMMIT');
      return { inventory: [{ id: 'owned-fixture', furnitureId: 'oak_chair' }] };
    },
    console: { error() {} },
  };
  vm.runInNewContext(source.slice(start, end), context);
  await handler({ cashierId, furnitureId: 'oak_chair' });
  return { events, queries, connections, player };
}

(async () => {
  const committed = await purchase({ snapshotFails: true });
  const result = committed.events.find(event => event.name === 'homePurchaseResult').data;
  assert.equal(result.ok, true, 'a committed purchase cannot become a failed purchase');
  assert.equal(result.item.id, 'owned-fixture');
  assert.equal(result.refreshPending, true);
  assert.equal(committed.player.coins, 15000);
  assert(committed.queries.includes('COMMIT'));
  assert(committed.queries.some(sql => sql.includes('layout_revision=layout_revision+1')),
    'a committed purchase advances the full-home snapshot revision transactionally');
  assert(!committed.queries.includes('ROLLBACK'), 'do not roll back after successful commit');
  assert.equal(committed.events.filter(event => event.name === 'homePurchaseResult').length, 1);

  const outside = await purchase({ location: 'neighborhood' });
  assert.equal(outside.connections, 0, 'remote purchases never touch the database');
  assert.equal(outside.events[0].data.code, 'shop_only');

  const noCashier = await purchase({ cashierId: '' });
  assert.equal(noCashier.connections, 0, 'a purchase without a cashier never touches the database');
  assert.equal(noCashier.events[0].data.code, 'cashier');

  const wrongCashier = await purchase({ cashierId: 'cashier:cafe' });
  assert.equal(wrongCashier.connections, 0, 'a purchase through another venue cashier is rejected');
  assert.equal(wrongCashier.events[0].data.code, 'cashier');

  const outOfRange = await purchase({ x: CASHIER.x + CASHIER.radius + 1 });
  assert.equal(outOfRange.connections, 0, 'an out-of-range purchase never touches the database');
  assert.equal(outOfRange.events[0].data.code, 'distance');

  const poor = await purchase({ affordable: false });
  assert.equal(poor.events.find(event => event.name === 'homePurchaseResult').data.ok, false);
  assert(!poor.queries.some(sql => sql.includes('INSERT INTO jpo_home_furniture')));
  assert(poor.queries.includes('ROLLBACK'));
  console.log('PASS: cashier-authorized atomic purchase, cashier/range guards, and committed-purchase acknowledgement');
})().catch(error => { console.error(error); process.exitCode = 1; });