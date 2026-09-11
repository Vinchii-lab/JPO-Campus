const fs = require('fs');
let content = fs.readFileSync('artifacts/jpo-huddle/neighborhood.mjs', 'utf8');

const missingFuncs = `
export function streetReturnSpawnForOwner(entries, ownerEmail) {
  const lot = streetLotForOwner(entries, ownerEmail);
  return lot ? lot.returnSpawn : null;
}

export function staticSeatForPoint(location, x, y, radius = 24) {
  const geometry = LOCATION_GEOMETRY[location.kind === "home" ? "home" : location.id];
  if (!geometry || !geometry.seats) return null;
  return geometry.seats.find((seat) => 
    Math.abs(seat.x - x) <= radius && Math.abs(seat.y - y) <= radius
  ) || null;
}

export function staticSeatStandCandidates(seat) {
  if (!seat) return [];
  if (Array.isArray(seat.stands) && seat.stands.length > 0) return seat.stands;
  if (seat.stand) return [seat.stand];
  
  const standRadius = 40;
  if (seat.dir === "up") return [{ x: seat.x, y: seat.y - standRadius, dir: "up" }];
  if (seat.dir === "down") return [{ x: seat.x, y: seat.y + standRadius, dir: "down" }];
  if (seat.dir === "left") return [{ x: seat.x - standRadius, y: seat.y, dir: "left" }];
  if (seat.dir === "right") return [{ x: seat.x + standRadius, y: seat.y, dir: "right" }];
  
  return [{ x: seat.x, y: seat.y + standRadius, dir: "down" }];
}
`;

if (!content.includes('export function staticSeatForPoint')) {
  content += '\n' + missingFuncs;
  fs.writeFileSync('artifacts/jpo-huddle/neighborhood.mjs', content);
}
