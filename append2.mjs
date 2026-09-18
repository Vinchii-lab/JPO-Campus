import fs from 'fs';

let content = fs.readFileSync('artifacts/jpo-huddle/generate_layouts.mjs', 'utf8');

content = content.replace(
  `// === MUSEUM FOYER ===
clearRoom();
objects.push(mkObj("museum_foyer_desk", 480, 300));`,
  `// === MUSEUM FOYER ===
clearRoom();
// 4 doors
[192, 384, 576, 768].forEach(x => {
  objects.push(mkObj("museum_door", x, 48));
});
objects.push(mkObj("museum_foyer_desk", 480, 300));`
);

fs.writeFileSync('artifacts/jpo-huddle/generate_layouts.mjs', content);
