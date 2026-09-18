import fs from 'fs';

let content = fs.readFileSync('artifacts/jpo-huddle/generate_layouts.mjs', 'utf8');

// Museum Bench: 
// addSeat("museum_bench", 200, 450, 435, "down", 200, 490);
// No overlap

// Cafe
content = content.replace(
  /addSeat\("cafe_chair_down", tx, ty\+65, ty\+65 - 15, "up", tx, ty\+95\);/g,
  `addSeat("cafe_chair_down", tx, ty+85, ty+85 - 15, "up", tx, ty+115);`
);

// Diner Stool
content = content.replace(
  /addSeat\("diner_stool", 144 \+ i\*48, 275, 275 - 15, "up", 144 \+ i\*48, 305\);/g,
  `addSeat("diner_stool", 144 + i*48, 290, 290 - 15, "up", 144 + i*48, 320);`
);

// Bakery Chair
content = content.replace(
  /addSeat\("bakery_chair", tx, ty\+65, ty\+65 - 15, "up", tx, ty\+95\);/g,
  `addSeat("bakery_chair", tx, ty+85, ty+85 - 15, "up", tx, ty+115);`
);

// Sushi Cushions (counter)
content = content.replace(
  /addSeat\("sushi_cushion", 300 \+ i\*48, 315, 315 - 10, "up", 300 \+ i\*48, 355\);/g,
  `addSeat("sushi_cushion", 300 + i*48, 330, 330 - 10, "up", 300 + i*48, 370);`
);

// Sushi Cushions (table)
content = content.replace(
  /addSeat\("sushi_cushion", tx - 40, ty, ty - 10, "right", tx - 70, ty\);/g,
  `addSeat("sushi_cushion", tx - 55, ty, ty - 10, "right", tx - 85, ty);`
);
content = content.replace(
  /addSeat\("sushi_cushion", tx \+ 40, ty, ty - 10, "left", tx \+ 70, ty\);/g,
  `addSeat("sushi_cushion", tx + 55, ty, ty - 10, "left", tx + 85, ty);`
);

fs.writeFileSync('artifacts/jpo-huddle/generate_layouts.mjs', content);
