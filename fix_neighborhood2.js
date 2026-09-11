const fs = require('fs');
let content = fs.readFileSync('artifacts/jpo-huddle/neighborhood.mjs', 'utf8');

const badGeometryStart = content.indexOf('  cafe: {\n    blockers: [');
const badGeometryEnd = content.indexOf('  "decor-shop": { id: "decor-shop", label: "Plaza Decor"');

if (badGeometryStart > -1 && badGeometryEnd > -1) {
  content = content.slice(0, badGeometryStart) + content.slice(badGeometryEnd);
  fs.writeFileSync('artifacts/jpo-huddle/neighborhood.mjs', content);
  console.log("Fixed LOCATIONS block.");
} else {
  console.log("Could not find start or end:", badGeometryStart, badGeometryEnd);
}
