import fs from 'fs';
let content = fs.readFileSync('artifacts/jpo-huddle/generate_layouts.mjs', 'utf8');

// Cafe tables: blockers at [tx-20, ty-20, 40, 40] => y from ty-20 to ty+20
// So anchor must be < ty-20 or > ty+20.
content = content.replace(
  `addSeat("cafe_chair_down", tx, ty+35, ty+35 - 15, "up", tx, ty+70); 
  addSeat("cafe_chair_up", tx, ty-25, ty-25 - 15, "down", tx, ty-60);`,
  `addSeat("cafe_chair_down", tx, ty+65, ty+65 - 15, "up", tx, ty+95); 
  addSeat("cafe_chair_up", tx, ty-25, ty-25 - 15, "down", tx, ty-60);`
);

// Diner stools: counter at 200, blocker 176 to 224.
// Stool originally at 260 => pad 245 => anchor 218 (blocked)
content = content.replace(
  `addSeat("diner_stool", 144 + i*48, 260, 260 - 15, "up", 144 + i*48, 290);`,
  `addSeat("diner_stool", 144 + i*48, 275, 275 - 15, "up", 144 + i*48, 305);`
);

// Diner booths: table blocker [bx-20, by-20, 40, 40]. (x from bx-20 to bx+20, y from by-20 to by+20)
// red booths left and right
// addSeat("diner_booth_red", bx - 40, by, by - 15, "right", bx - 70, by);
// Wait, x=bx-40. Does x=bx-40 hit [bx-20, bx+20]? No. The x coordinate is clear.
// So diner booth x is fine.

// Bakery tables: blocker [ty-20 to ty+20]
// addSeat("bakery_chair", tx, ty+35, ty+35 - 15, "up", tx, ty+70);
content = content.replace(
  `addSeat("bakery_chair", tx, ty+35, ty+35 - 15, "up", tx, ty+70);
  addSeat("bakery_chair", tx, ty-25, ty-25 - 15, "down", tx, ty-60);`,
  `addSeat("bakery_chair", tx, ty+65, ty+65 - 15, "up", tx, ty+95);
  addSeat("bakery_chair", tx, ty-25, ty-25 - 15, "down", tx, ty-60);`
);

// Sushi cushions: counter at 250, blocker 226 to 274.
// Cushion originally at 290 => pad 280 => anchor 253 (blocked)
content = content.replace(
  `addSeat("sushi_cushion", 300 + i*48, 290, 290 - 10, "up", 300 + i*48, 330);`,
  `addSeat("sushi_cushion", 300 + i*48, 315, 315 - 10, "up", 300 + i*48, 355);`
);

// Sushi tables: blocker x [tx-36, tx+36], y [ty-24, ty+24]
// addSeat("sushi_cushion", tx - 40, ty, ty - 10, "right", tx - 70, ty);
// Cushion at x=tx-40. Blocker x from tx-36. tx-40 < tx-36. Clear.

fs.writeFileSync('artifacts/jpo-huddle/generate_layouts.mjs', content);
