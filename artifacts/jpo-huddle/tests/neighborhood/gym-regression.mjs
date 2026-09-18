import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { GYM_STATIONS, GYM_DURATION_MS, applyGymLayout } from '../../gym-layout.mjs';
import { COMMERCIAL_CASHIERS, LOCATIONS, LOCATION_GEOMETRY } from '../../neighborhood.mjs';

const manifest = { rooms: { cafe: { objects: ['old counter'] }, diner: { untouched: true } } };
applyGymLayout(manifest);
assert.equal(manifest.rooms.cafe.label, 'Plaza Gym');
assert.deepEqual(manifest.rooms.cafe.objects, []);
assert.equal(manifest.rooms.cafe.gymStations.length, 6);
assert.equal(manifest.rooms.diner.untouched, true);
assert.equal(COMMERCIAL_CASHIERS.cafe, undefined);
assert.equal(LOCATIONS.cafe.label, 'Plaza Gym');
assert.equal(LOCATION_GEOMETRY.cafe.seats.length, 0);

// Every exercise waypoint and its aisle approach clears the authoritative
// sprite-center collision radius. Test small steps, not only endpoints.
const blocked = (x, y) => LOCATION_GEOMETRY.cafe.blockers.some(b =>
  x > b.x - 16 && x < b.x + b.width + 16 && y > b.y - 16 && y < b.y + b.height + 16);
for (const station of GYM_STATIONS) {
  assert(!blocked(station.anchor.x, station.anchor.y), station.id);
  const route = station.kind === 'punch'
    ? [[480, 576], [336, 576], [336, 264], [station.anchor.x, 264], [station.anchor.x, station.anchor.y]]
    : [[480, 576], [station.anchor.x, 576], [station.anchor.x, station.anchor.y]];
  for (let i = 1; i < route.length; i++) {
    const [x, y] = route[i - 1], [tx, ty] = route[i];
    const steps = Math.ceil(Math.hypot(tx - x, ty - y) / 4);
    for (let n = 0; n <= steps; n++) assert(!blocked(x + (tx - x) * n / steps,
      y + (ty - y) * n / steps), `${station.id}: accessible approach`);
  }
}

// Run the actual server gym branch without opening sockets or a DB.
const source = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
const start = source.indexOf('  socket.on("interact", (payload) => {');
const end = source.indexOf('    if (!isOfficePlayer(socket.id))', start);
assert(start > 0 && end > start);
let handler;
const events = [];
const states = new Map();
const player = { email: 'gym-test@example.invalid', location: 'cafe',
  x: GYM_STATIONS[0].anchor.x, y: GYM_STATIONS[0].anchor.y };
const context = {
  players: { self: player }, GYM_STATIONS, GYM_DURATION_MS,
  plazaGymActivities: states, Date, Math,
  locationOf: p => p.location, takeToken: () => true, interactBucket: {},
  socket: { id: 'self', on: (_event, fn) => { handler = fn; },
    emit: (event, data) => events.push({ event, data }) },
  emitToLocation: (location, event, data) => events.push({ location, event, data }),
  stopPlazaGym: id => states.delete(id),
};
vm.runInNewContext(source.slice(start, end) + '\n  });', context);
handler({ object: GYM_STATIONS[0].id });
assert.equal(states.get('self').endsAt - states.get('self').startedAt, 8000);
assert.equal(events.at(-1).location, 'cafe');
handler({ object: 'plaza-gym:sync' });
assert.equal(events.at(-1).event, 'plazaGymSnapshot');
handler({ object: 'plaza-gym:stop' });
assert.equal(states.size, 0);
player.location = 'city';
handler({ object: GYM_STATIONS[0].id });
assert.equal(events.at(-1).event, 'interactError');
assert.equal(states.size, 0);
player.location = 'cafe'; player.x = 480; player.y = 576;
handler({ object: GYM_STATIONS[0].id });
assert.equal(events.at(-1).event, 'interactError');
assert.equal(states.size, 0);
player.x = GYM_STATIONS[0].anchor.x; player.y = GYM_STATIONS[0].anchor.y;
states.set('other', { id: 'other', object: GYM_STATIONS[0].id });
handler({ object: GYM_STATIONS[0].id });
assert.match(events.at(-1).data.message, /in use/);
assert.equal(states.size, 1);
// Exercise the actual bounded cleanup loop for walking, travel, expiry,
// and disconnect (no timer or running app needed).
let cleanup;
const cleanupStart = source.indexOf('setInterval(() => {', source.indexOf('const plazaGymActivities'));
const cleanupEnd = source.indexOf('}, 150).unref();', cleanupStart) + '}, 150).unref();'.length;
context.setInterval = fn => { cleanup = fn; return { unref() {} }; };
vm.runInNewContext(source.slice(cleanupStart, cleanupEnd), context);
for (const reason of ['walk', 'travel', 'expiry', 'disconnect']) {
  states.clear();
  player.location = reason === 'travel' ? 'city' : 'cafe';
  context.players.self = player;
  if (reason === 'disconnect') delete context.players.self;
  states.set('self', { id: 'self', x: reason === 'walk' ? player.x - 20 : player.x,
    y: player.y, endsAt: reason === 'expiry' ? Date.now() - 1 : Date.now() + 8000 });
  cleanup();
  assert.equal(states.size, 0, reason + ' cleanup');
}
console.log('PASS: gym geometry, layout, menu removal, 8s activity, scope, proximity, occupancy and sync');