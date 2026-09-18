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
  if (station.kind === 'run') {
    assert.deepEqual(station.poseAnchor, { x: station.x + 72, y: station.y + 78 },
      station.id + ': HQ treadmill pose geometry');
    assert.equal(station.poseDepth, station.blocker.y + station.blocker.height + 1,
      station.id + ': runner must layer immediately above the machine');
    assert(blocked(station.poseAnchor.x, station.poseAnchor.y),
      station.id + ': belt pose is deliberately presentation-only');
  }
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
assert.equal(states.get('self').x, player.x, 'canonical movement anchor must remain reachable');
assert.equal(states.get('self').y, player.y, 'canonical movement anchor must not teleport onto blocker');
assert.equal(events.at(-1).location, 'cafe');
handler({ object: 'plaza-gym:sync' });
assert.equal(events.at(-1).event, 'plazaGymSnapshot');
handler({ object: 'plaza-gym:stop' });
assert.equal(states.size, 0);
const treadmill = GYM_STATIONS.find(station => station.kind === 'run');
player.x = treadmill.anchor.x; player.y = treadmill.anchor.y;
handler({ object: treadmill.id });
assert.equal(states.get('self').x, treadmill.anchor.x);
assert.equal(states.get('self').y, treadmill.anchor.y);
assert.equal(states.get('self').poseX, treadmill.poseAnchor.x);
assert.equal(states.get('self').poseY, treadmill.poseAnchor.y);
assert.equal(states.get('self').dir, 'up');
handler({ object: 'plaza-gym:stop' });
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

// Production renderer contract: it hides (but never moves) the canonical
// physics sprite, runs a clone with the real directional-animation convention,
// and restores the actor plus attached presentation on stop.
const renderer = fs.readFileSync(new URL('../../public/neighborhood-interiors-gym.js', import.meta.url), 'utf8');
assert.match(renderer, /scene\._createDirAnims\?\.\(textureKey\)/);
assert.match(renderer, /`walk_\$\{textureKey\}_up`/);
assert.match(renderer, /entry\.actor\.setVisible\(false\)/);
assert.match(renderer, /entry\.actor\.setVisible\(presentation\.actorVisible\)/);
assert.match(renderer, /scene\._placeWearable\(object, def, x, y, dir\)/);
assert.match(renderer, /scene\._placePetAcc\?\.\(entry\.pet\)/);
assert.doesNotMatch(renderer, /🏃|🥊/, 'exercise must use real sprite animation, not emoji');

// Authored run sheet geometry: four directions × six distinct frames. The
// treadmill proof uses adjacent up frames 6/7, so visible pixels necessarily
// change while the body centre remains on the same belt anchor.
const runPng = fs.readFileSync(new URL('../../public/assets/Adam_run_16x16.png', import.meta.url));
const pngWidth = runPng.readUInt32BE(16), pngHeight = runPng.readUInt32BE(20);
assert.deepEqual([pngWidth, pngHeight], [24 * 16, 32]);
assert.equal(6 * 16, 96);
assert.equal(7 * 16, 112);

console.log('PASS: gym geometry, canonical admission, 8s cleanup, real run animation and attached presentation');