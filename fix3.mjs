import fs from 'fs';

let content = fs.readFileSync('artifacts/jpo-huddle/generate_layouts.mjs', 'utf8');

// Remove shop_cash_register
content = content.replace(
  `"shop_cash_register": "16_Grocery_Store_Singles/Grocery_Store_Singles_125.png",`,
  ``
);
content = content.replace(
  `objects.push(mkObj("shop_cash_register", 480, 200));
blockers.push(mkBlock(456, 176, 48, 48));`,
  ``
);

// Remove diner_burger
content = content.replace(
  `"diner_burger": "12_Kitchen_Singles/Kitchen_Singles_167.png",`,
  ``
);
content = content.replace(
  `objects.push(mkObj("diner_burger", bx, by - 15));`,
  ``
);

fs.writeFileSync('artifacts/jpo-huddle/generate_layouts.mjs', content);
