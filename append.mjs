import fs from 'fs';

let content = fs.readFileSync('artifacts/jpo-huddle/generate_layouts.mjs', 'utf8');

// Replace diner booths loop to add burgers
content = content.replace(
  `booths.forEach(([bx, by]) => {
  objects.push(mkObj("diner_table", bx, by));`,
  `booths.forEach(([bx, by]) => {
  objects.push(mkObj("diner_table", bx, by));
  objects.push(mkObj("diner_burger", bx, by - 15));`
);

// Replace sushi tables loop to add plates
content = content.replace(
  `sTables.forEach(([tx, ty]) => {
  objects.push(mkObj("sushi_table", tx, ty));`,
  `sTables.forEach(([tx, ty]) => {
  objects.push(mkObj("sushi_table", tx, ty));
  objects.push(mkObj("sushi_plate", tx - 10, ty - 5));
  objects.push(mkObj("sushi_plate", tx + 10, ty - 5));`
);

fs.writeFileSync('artifacts/jpo-huddle/generate_layouts.mjs', content);
