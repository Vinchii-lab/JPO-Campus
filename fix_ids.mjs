import fs from 'fs';

let content = fs.readFileSync('artifacts/jpo-huddle/generate_layouts.mjs', 'utf8');

// Change seat ID generation to be globally unique
content = content.replace(
  `    id: \`seat-\${idCounter++}\`,`,
  `    id: \`\${roomId}-\${idCounter++}\`,`
);

// We need roomId in addSeat, let's just make it simpler: use global idCounter and don't reset it.
content = content.replace(
  `function clearRoom() {
  objects = []; blockers = []; seats = []; idCounter = 0;
}`,
  `function clearRoom() {
  objects = []; blockers = []; seats = [];
}`
);

fs.writeFileSync('artifacts/jpo-huddle/generate_layouts.mjs', content);
