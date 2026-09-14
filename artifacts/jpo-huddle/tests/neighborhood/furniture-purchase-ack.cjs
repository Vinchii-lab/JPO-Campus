const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
const start = source.indexOf('  socket.on("homePurchase",');
const end = source.indexOf('  socket.on("homeLayoutSet",', start);
assert(start >= 0 && end > start);

async function purchase({ location = 'furniture-shop', snapshotFails = false, affordable = true } = {}) {
  const events = [], queries = [];
  let handler, connections = 0;
  const player = { email: 'purchase-fixture@example.com', coins: 20000 };
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
  await handler({ furnitureId: 'oak_chair' });
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
  assert(!committed.queries.includes('ROLLBACK'), 'do not roll back after successful commit');
  assert.equal(committed.events.filter(event => event.name === 'homePurchaseResult').length, 1);

  const outside = await purchase({ location: 'neighborhood' });
  assert.equal(outside.connections, 0, 'remote purchases never touch the database');
  assert.equal(outside.events[0].data.code, 'shop_only');

  const poor = await purchase({ affordable: false });
  assert.equal(poor.events.find(event => event.name === 'homePurchaseResult').data.ok, false);
  assert(!poor.queries.some(sql => sql.includes('INSERT INTO jpo_home_furniture')));
  assert(poor.queries.includes('ROLLBACK'));
  console.log('PASS: store-only purchases, insufficient funds, and committed-purchase acknowledgement');
})().catch(error => { console.error(error); process.exitCode = 1; });