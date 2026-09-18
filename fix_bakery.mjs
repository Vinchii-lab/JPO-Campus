import fs from 'fs';
let content = fs.readFileSync('artifacts/jpo-huddle/generate_layouts.mjs', 'utf8');

content = content.replace(
  `const bakTables = [[300,450],[600,450],[450,600]];`,
  `const bakTables = [[300,450],[600,450],[250,600]];`
);

fs.writeFileSync('artifacts/jpo-huddle/generate_layouts.mjs', content);
