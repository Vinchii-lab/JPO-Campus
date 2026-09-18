import fs from 'fs';
let content = fs.readFileSync('artifacts/jpo-huddle/generate_layouts.mjs', 'utf8');

// Change museum-room-2
content = content.replace(
  `// === MUSEUM GALLERY 2 ===
clearRoom();
objects.push(mkObj("museum_fossil_trex_head", 400, 350));
objects.push(mkObj("museum_fossil_trex_body", 448, 350));
objects.push(mkObj("museum_fossil_trex_tail", 496, 350));
blockers.push(mkBlock(376, 330, 144, 48));
objects.push(mkObj("museum_fossil_tri_head", 400, 550));
objects.push(mkObj("museum_fossil_tri_body", 448, 550));
objects.push(mkObj("museum_fossil_tri_tail", 496, 550));
blockers.push(mkBlock(376, 530, 144, 48));`,
  `// === MUSEUM GALLERY 2 ===
clearRoom();
objects.push(mkObj("museum_fossil_trex_head", 400, 200));
objects.push(mkObj("museum_fossil_trex_body", 448, 200));
objects.push(mkObj("museum_fossil_trex_tail", 496, 200));
blockers.push(mkBlock(376, 176, 144, 48));
objects.push(mkObj("museum_fossil_tri_head", 400, 450));
objects.push(mkObj("museum_fossil_tri_body", 448, 450));
objects.push(mkObj("museum_fossil_tri_tail", 496, 450));
blockers.push(mkBlock(376, 426, 144, 48));`
);

fs.writeFileSync('artifacts/jpo-huddle/generate_layouts.mjs', content);
