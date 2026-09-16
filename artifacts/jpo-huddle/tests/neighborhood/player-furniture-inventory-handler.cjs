// Cheap source-slice regression for the personal furniture inventory read.
//
// This executes the checked-in production socket handler with a tiny database
// double.  It intentionally does not start a server or touch the shared
// database: the opt-in real-server/browser pass owns that coverage.  Keeping
// this contract cheap makes it suitable for every server change.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
const start = source.indexOf('  socket.on("playerFurnitureInventoryRequest",');
const end = source.indexOf('  socket.on("homeSnapshotRequest",', start);
assert(start >= 0 && end > start, 'personal inventory handler must remain in server.js');
const handlerSource = source.slice(start, end);

const OWNER = 'inventory-owner@example.com';
const HOST = 'inventory-host@example.com';
const SECRET = 'simulated database credentials must not reach clients';
const CATALOG = {
  oak_chair: { name: 'Oak Chair' },
  plush_bed: { name: 'Plush Bed' },
  floor_rug: { name: 'Floor Rug' },
};
// VM-executed handlers create arrays/objects in a different realm. Normalize
// only the JSON-shaped response before strict comparisons; this preserves the
// exact wire contract while avoiding realm-prototype identity noise.
const wire = (value) => JSON.parse(JSON.stringify(value));

function harness({
  rows = [{
    revision: '17',
    items: [
      { id: 'stored-uuid', furnitureId: 'oak_chair', zone: 'stored' },
      { id: 'indoor-uuid', furnitureId: 'plush_bed', zone: 'indoor' },
      { id: 'yard-uuid', furnitureId: 'floor_rug', zone: 'yard' },
      // A stale/unknown catalog row must not leak through the public view.
      { id: 'unknown-uuid', furnitureId: 'not-a-catalog-item', zone: 'stored' },
    ],
  }],
  queryError = null,
  email = OWNER,
} = {}) {
  const events = [];
  const queries = [];
  let handler;
  const player = { email };
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (queryError) throw new Error(queryError);
      return { rows };
    },
  };
  const socket = {
    id: 'inventory-fixture-socket',
    on(name, callback) {
      if (name === 'playerFurnitureInventoryRequest') handler = callback;
    },
    emit(name, data) {
      events.push({ name, data });
    },
  };
  vm.runInNewContext(handlerSource, {
    socket,
    players: { [socket.id]: player },
    pool: { query: (...args) => client.query(...args) },
    FURNITURE_CATALOG: CATALOG,
    console: { error() {} },
  });
  assert.equal(typeof handler, 'function', 'personal inventory handler is registered');
  return { events, queries, handler, player, socket };
}

async function readInventory(options, payload) {
  const test = harness(options);
  await test.handler(payload);
  const result = test.events.find(
    (event) => event.name === 'playerFurnitureInventoryResult',
  )?.data;
  assert.ok(result, 'inventory request emits one result');
  return { ...test, result };
}

(async () => {
  const first = await readInventory(undefined, {
    requestId: 91,
    email: HOST,
    ownerEmail: HOST,
  });
  assert.equal(first.queries.length, 1, 'one consistent read supplies revision and all zones');
  assert.equal(first.queries[0].params[0], OWNER,
    'query identity comes from authenticated player state, not payload');
  assert(!first.queries[0].sql.match(/\b(INSERT|UPDATE|DELETE|UPSERT|CREATE|ALTER|DROP)\b/i),
    'personal inventory read has no mutation SQL');
  assert.equal(first.result.ok, true);
  assert.equal(first.result.requestId, 91);
  assert.equal(first.result.ownerEmail, OWNER,
    'response identity comes from authenticated player state, not payload');
  assert.equal(first.result.revision, 17,
    'revision is returned from the same snapshot query as the item rows');
  assert.deepEqual(wire(first.result.inventory), [
    { id: 'stored-uuid', furnitureId: 'oak_chair' },
  ], 'stored furniture is exposed in own inventory');
  assert.deepEqual(wire(first.result.layout), [
    { id: 'indoor-uuid', furnitureId: 'plush_bed' },
  ], 'indoor placements stay separate from stored inventory');
  assert.deepEqual(wire(first.result.yard), [
    { id: 'yard-uuid', furnitureId: 'floor_rug' },
  ], 'yard placements stay separate from indoor placements');
  assert.equal(JSON.stringify(first.result).includes('unknown-uuid'), false,
    'unknown catalog rows are not disclosed');

  // A subsequent authoritative snapshot must carry its own revision, rather
  // than retaining or mixing the first response's value.
  const second = await readInventory({
    rows: [{
      revision: 18,
      items: [{ id: 'stored-uuid', furnitureId: 'oak_chair', zone: 'stored' }],
    }],
  }, { requestId: 92 });
  assert.equal(second.result.revision, 18,
    'a later inventory response carries its matching authoritative revision');
  assert.deepEqual(wire(second.result.inventory), [
    { id: 'stored-uuid', furnitureId: 'oak_chair' },
  ]);
  assert.deepEqual(wire(second.result.layout), []);
  assert.deepEqual(wire(second.result.yard), []);

  const failed = await readInventory(
    { queryError: SECRET },
    { requestId: 93, email: HOST },
  );
  assert.equal(failed.result.ok, false, 'database failure returns a controlled error');
  assert.equal(failed.result.requestId, 93);
  assert.equal(failed.result.message, 'Could not load your furniture. Please try again.',
    'database error detail is not sent to the client');
  assert.equal(JSON.stringify(failed.result).includes(SECRET), false,
    'database error detail never leaks in the response');
  assert.equal(failed.queries.length, 1);

  console.log(
    'PASS: personal furniture inventory handler is auth-scoped, read-only, revision-consistent, zone-separated, and sanitized on errors',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});