const fs = require('fs');
let content = fs.readFileSync('artifacts/jpo-huddle/neighborhood.mjs', 'utf8');

// 1. Remove the malformed geometry from LOCATIONS
const badGeometryStart = content.indexOf('  cafe: {\n    blockers: [');
const badGeometryEnd = content.indexOf('  "decor-shop": { id: "decor-shop", label: "Plaza Decor"');

if (badGeometryStart > -1 && badGeometryEnd > -1) {
  content = content.slice(0, badGeometryStart) + content.slice(badGeometryEnd);
}

// Ensure the LOCATIONS block doesn't have double bounds for sushi
content = content.replace(/bounds: \{ width: 960, height: 720 \} \}, bounds: \{ width: 1152, height: 912 \} \},/, 'bounds: { width: 960, height: 720 } },');

// 2. Add staticSeatForPoint
const staticSeatFunc = `
export function staticSeatForPoint(location, x, y, radius = 24) {
  const geometry = LOCATION_GEOMETRY[location.kind === "home" ? "home" : location.id];
  if (!geometry || !geometry.seats) return null;
  return geometry.seats.find((seat) => 
    Math.abs(seat.x - x) <= radius && Math.abs(seat.y - y) <= radius
  ) || null;
}
`;

if (!content.includes('export function staticSeatForPoint')) {
  content += '\n' + staticSeatFunc;
}

fs.writeFileSync('artifacts/jpo-huddle/neighborhood.mjs', content);
