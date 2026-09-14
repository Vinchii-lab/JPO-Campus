import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  LOCATIONS, LOCATION_GEOMETRY, LOCATION_PORTALS, parseLocation,
  validLocationMove, validContinuousLocationMove, staticSeatStandCandidates,
} from '../../neighborhood.mjs';
import manifest from '../../public/commercial-layouts.json' with { type: 'json' };

for (const [key, asset] of Object.entries(manifest.assets)) {
  const bytes = fs.readFileSync(new URL('../../public/' + asset, import.meta.url));
  assert.equal(bytes.toString('ascii', 1, 4), 'PNG', key + ' is a real PNG sprite');
  assert(bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0, key + ' has valid dimensions');
}

// Flood-fill the actual authoritative collision space, not just endpoint tests.
// Small grid steps catch the previously missed blocked door corridors.
function reachable(id) {
  const loc = parseLocation(id);
  const { width, height } = LOCATIONS[id].bounds;
  const step = 8, cols = Math.ceil(width / step);
  const valid = (x, y) => validLocationMove(loc, x, y);
  const spawn = LOCATIONS[id].spawn;
  assert(valid(spawn.x, spawn.y), id + ' spawn is clear');
  const start = [Math.round(spawn.x / step) * step, Math.round(spawn.y / step) * step];
  const queue = [start], seen = new Set([start[1] / step * cols + start[0] / step]);
  for (let head = 0; head < queue.length; head++) {
    const [x, y] = queue[head];
    for (const [nx, ny] of [[x - step, y], [x + step, y], [x, y - step], [x, y + step]]) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height || !valid(nx, ny)) continue;
      const key = ny / step * cols + nx / step;
      if (!seen.has(key)) { seen.add(key); queue.push([nx, ny]); }
    }
  }
  return (x, y) => {
    const gx = Math.round(x / step), gy = Math.round(y / step);
    return seen.has(gy * cols + gx);
  };
}

for (const id of Object.keys(manifest.rooms)) {
  const reaches = reachable(id);
  for (const portal of LOCATION_PORTALS[id]) {
    const x = portal.x + portal.width / 2;
    const y = portal.y < 72 ? 32 : portal.y + portal.height / 2;
    assert(reaches(x, y), `${id}: walkable route from spawn to ${portal.destination} (${x},${y})`);
  }
  for (const seat of LOCATION_GEOMETRY[id].seats || []) {
    assert(validLocationMove(parseLocation(id), seat.x, seat.y), `${id}: ${seat.id} has a valid sit anchor`);
    assert(staticSeatStandCandidates(parseLocation(id), seat).some(p => reaches(p.x, p.y) &&
      validContinuousLocationMove(parseLocation(id), p.x, p.y, seat.x, seat.y)),
      `${id}: ${seat.id} has a reachable, collision-valid stand position`);
  }
}
console.log('PASS: all commercial sprites exist; room exits and seating have real walkable paths');