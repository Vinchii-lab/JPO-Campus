// Focused production-handler contracts for Store's post-commit refresh path.
// These execute the handler slices from server.js, rather than a duplicate
// implementation, so a read outage cannot accidentally become a retryable
// Store failure or leave a removed blocker in memory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
const returnStart = source.indexOf('  socket.on("homeLayoutReturn",');
const returnEnd = source.indexOf('  socket.on("homeAccessSet",', returnStart);
const refreshStart = source.indexOf('  socket.on("homeSnapshotRequest",');
const refreshEnd = source.indexOf('  // The invite picker', refreshStart);
assert(returnStart >= 0 && returnEnd > returnStart);
assert(refreshStart >= 0 && refreshEnd > refreshStart);

const ownerEmail = 'store-fixture@example.com';
const instanceId = '00000000-0000-0000-0000-000000000001';
const otherId = '00000000-0000-0000-0000-000000000002';

async function runReturn() {
  const events = [];
  const cache = new Map([[ownerEmail, [
    { instanceId },
    { instanceId: otherId },
  ]]]);
  let handler;
  let committed = false;
  const queries = [];
  const player = { email: ownerEmail, locationId: `home:${ownerEmail}` };
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql === 'COMMIT') committed = true;
      if (sql.includes('DELETE FROM jpo_home_layout_items')) {
        return { rows: [{ furniture_instance_id: instanceId }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const context = {
    socket: {
      id: 'fixture',
      on(name, fn) { if (name === 'homeLayoutReturn') handler = fn; },
      emit(name, data) { events.push({ name, data }); },
    },
    players: { fixture: player },
    parseLocation: () => ({ kind: 'home', id: `home:${ownerEmail}`, ownerEmail }),
    locationOf: () => player.locationId,
    isHuddleTestIdentity: () => false,
    furnitureOccupied: () => false,
    withHomeOperation: async (_owner, operation) => operation(),
    pool: { async connect() { return client; } },
    ensureHome: async () => {},
    emitHomeSnapshotToOccupants: async () => {
      throw new Error('simulated snapshot read outage after COMMIT');
    },
    homeSnapshot: async () => ({ ownerEmail, revision: 2, layout: [] }),
    invalidateStreetHomes() {},
    refreshStreetHomes: async () => {},
    locationRoom: () => 'neighborhood',
    io: { to: () => ({ emit() {} }) },
    removeHomeLayoutCacheInstance(email, id) {
      const existing = cache.get(email);
      if (existing) cache.set(email, existing.filter((entry) => entry.instanceId !== id));
    },
    console: { error() {} },
  };
  vm.runInNewContext(source.slice(returnStart, returnEnd), context);
  await handler({ instanceId });
  return { events, cache, committed, queries };
}

async function runRefresh(cache) {
  const events = [];
  let handler;
  let lockHeld = false;
  const snapshot = {
    ownerEmail, revision: 3,
    layout: [{ id: otherId, furnitureId: 'oak_chair', gridX: 2, gridY: 2, rotation: 0 }],
    inventory: [{ id: instanceId, furnitureId: 'oak_chair' }],
  };
  const context = {
    socket: {
      id: 'fixture',
      on(name, fn) { if (name === 'homeSnapshotRequest') handler = fn; },
      emit(name, data) { events.push({ name, data }); },
    },
    players: { fixture: { email: ownerEmail, locationId: 'neighborhood' } },
    parseLocation: () => ({ id: 'neighborhood' }),
    locationOf: () => 'neighborhood',
    isHuddleTestIdentity: () => false,
    withHomeOperation: async (_owner, operation) => {
      lockHeld = true;
      try { return await operation(); } finally { lockHeld = false; }
    },
    pool: {},
    homeSnapshot: async () => snapshot,
    homeAccess: async () => ({ ok: true }),
    cacheHomeLayoutSnapshot(email, next) {
      assert.equal(lockHeld, true, 'cache rebuild stays inside the home operation lock');
      cache.set(email, next.layout.map((entry) => ({ instanceId: entry.id })));
    },
    console: { error() {} },
  };
  vm.runInNewContext(source.slice(refreshStart, refreshEnd), context);
  await handler();
  return { events, cache };
}

(async () => {
  const committed = await runReturn();
  const result = committed.events.find((event) => event.name === 'homeActionResult')?.data;
  assert.equal(committed.committed, true);
  assert.equal(result?.ok, true, 'a committed Store remains successful when refresh fails');
  assert.equal(result?.refreshPending, true);
  assert(!committed.queries.includes('ROLLBACK'), 'post-commit refresh failure never rolls back');
  const targetedDelete = committed.queries.find((sql) => sql.includes('DELETE FROM jpo_home_layout_items'));
  assert(targetedDelete?.includes('l.furniture_instance_id=$1::uuid') &&
    targetedDelete.includes('l.home_owner_email=$2') &&
    targetedDelete.includes('l.placement_zone=$3'),
  'Store uses one owner/zone/instance-targeted delete');
  assert.deepEqual(committed.cache.get(ownerEmail), [{ instanceId: otherId }],
    'the exact stored instance blocker is removed immediately');

  const refreshed = await runRefresh(committed.cache);
  assert.equal(refreshed.events.find((event) => event.name === 'homeSnapshot')?.data?.revision, 3,
    'refresh emits the authoritative snapshot after rebuilding');
  assert.deepEqual(refreshed.cache.get(ownerEmail), [{ instanceId: otherId }],
    'a refresh rebuilds the cache from the authoritative layout, not an omitted client array');
  console.log('PASS: production Store commit/refresh handler preserves success and rebuilds exact collision cache');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});