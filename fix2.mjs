import fs from 'fs';
import path from 'path';

let content = fs.readFileSync('artifacts/jpo-huddle/generate_layouts.mjs', 'utf8');

// 1. Restore furniture-shop and garden-shop
content = content.replace(
  `manifest.rooms["furniture-shop"] = manifest.rooms["decor-shop"];
manifest.rooms["garden-shop"] = manifest.rooms["decor-shop"];`,
  `// === FURNITURE SHOP ===
clearRoom();
for(let i=0; i<4; i++) {
  objects.push(mkObj("shop_shelf", 144 + i*48, 150));
  blockers.push(mkBlock(144 + i*48 - 24, 126, 48, 48));
}
addSeat("shop_sofa", 240, 400, 385, "down", 240, 450);
objects.push(mkObj("shop_lamp", 180, 400));
blockers.push(mkBlock(166, 376, 30, 48));

manifest.rooms["furniture-shop"] = {
  label: "Furniture Shop", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// === GARDEN SHOP ===
clearRoom();
for(let i=0; i<4; i++) {
  objects.push(mkObj("shop_plant_large", 200 + i*96, 200));
  blockers.push(mkBlock(200 + i*96 - 24, 176, 48, 48));
}
for(let i=0; i<8; i++) {
  objects.push(mkObj("shop_plant_small", 200 + i*48, 350));
  blockers.push(mkBlock(200 + i*48 - 12, 338, 24, 24));
}
for(let i=0; i<4; i++) {
  objects.push(mkObj("shop_plant_large", 200 + i*96, 500));
  blockers.push(mkBlock(200 + i*96 - 24, 476, 48, 48));
}
manifest.rooms["garden-shop"] = {
  label: "Garden Shop", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};`
);

// Remove the try-catch for gym and make it direct
content = content.replace(
  `// Try loading gym
try {
  const { applyGymLayout } = await import('./gym-layout.mjs');
  applyGymLayout(manifest);
} catch (e) {}`,
  `import { applyGymLayout } from './gym-layout.mjs';
applyGymLayout(manifest);`
);

// Also remove dynamic import at the top if it's there
content = content.replace(/import \{ applyGymLayout \} from '\.\/gym-layout\.mjs';\n/g, ""); // remove existing to place at top
content = `import { applyGymLayout } from './gym-layout.mjs';\n` + content;

// Remove shop_rug and replace shop_sofa with addSeat in decor-shop
content = content.replace(
  `objects.push(mkObj("shop_rug", 300, 400));
addSeat("shop_sofa", 300, 400, 385, "down", 300, 450);`,
  `addSeat("shop_sofa", 300, 400, 385, "down", 300, 450);`
);

// Validate unique IDs and write to BOTH paths
content = content.replace(
  `fs.writeFileSync(path.join(OUT_DIR, "../commercial-layouts.json"), JSON.stringify(manifest, null, 2));`,
  `
// Validate unique IDs and asset existences
const allIds = new Set();
for (const [roomId, room] of Object.entries(manifest.rooms)) {
  for (const seat of room.seats || []) {
    if (allIds.has(seat.id)) {
      console.error("Duplicate seat ID found:", seat.id);
      process.exit(1);
    }
    allIds.add(seat.id);
  }
  for (const obj of room.objects || []) {
    if (!manifest.assets[obj.asset] && obj.asset !== 'museum_door') {
      console.error("Room references missing asset:", obj.asset);
      process.exit(1);
    }
  }
}

const json = JSON.stringify(manifest, null, 2);
fs.writeFileSync("/home/runner/workspace/artifacts/jpo-huddle/public/commercial-layouts.json", json);
fs.writeFileSync(path.join(OUT_DIR, "../commercial-layouts.json"), json);
`
);

fs.writeFileSync('artifacts/jpo-huddle/generate_layouts.mjs', content);
