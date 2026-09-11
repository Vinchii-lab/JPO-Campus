const fs = require('fs');
let content = fs.readFileSync('artifacts/jpo-huddle/neighborhood.mjs', 'utf8');

const staticSeatStandCandidatesFunc = `
export function staticSeatStandCandidates(seat) {
  if (!seat) return [];
  if (Array.isArray(seat.stands) && seat.stands.length > 0) return seat.stands;
  if (seat.stand) return [seat.stand];
  
  // Default fallback positions based on seat direction
  // This matches standard parkbench exit behavior
  const standRadius = 40;
  if (seat.dir === "up") return [{ x: seat.x, y: seat.y - standRadius, dir: "up" }];
  if (seat.dir === "down") return [{ x: seat.x, y: seat.y + standRadius, dir: "down" }];
  if (seat.dir === "left") return [{ x: seat.x - standRadius, y: seat.y, dir: "left" }];
  if (seat.dir === "right") return [{ x: seat.x + standRadius, y: seat.y, dir: "right" }];
  
  return [{ x: seat.x, y: seat.y + standRadius, dir: "down" }]; // Default fallback
}
`;

if (!content.includes('export function staticSeatStandCandidates')) {
  content += '\n' + staticSeatStandCandidatesFunc;
}

fs.writeFileSync('artifacts/jpo-huddle/neighborhood.mjs', content);
