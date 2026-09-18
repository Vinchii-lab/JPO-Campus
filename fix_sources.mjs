import fs from 'fs';

let content = fs.readFileSync('artifacts/jpo-huddle/generate_layouts.mjs', 'utf8');

content = content.replace(
  `"diner_grill": "12_Kitchen_Singles/Kitchen_Singles_140.png",`,
  `"diner_grill": "12_Kitchen_Singles/Kitchen_Singles_140.png",
  "diner_burger": "12_Kitchen_Singles/Kitchen_Singles_167.png",`
);

content = content.replace(
  `"sushi_screen": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_62.png",`,
  `"sushi_screen": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_62.png",
  "sushi_plate": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_74.png",`
);

fs.writeFileSync('artifacts/jpo-huddle/generate_layouts.mjs', content);
