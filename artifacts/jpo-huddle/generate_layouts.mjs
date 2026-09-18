import { applyGymLayout } from './gym-layout.mjs';
import { applyFoodVenueLayouts } from './food-venue-layouts.mjs';
import { applyDecorSushiLayouts } from './decor-sushi-layouts.mjs';
import { applyMuseumLayout } from './museum-layout.mjs';
import fs from 'fs';
import path from 'path';

const SRC = "/tmp/sprites/1_Interiors/16x16/Theme_Sorter_Singles";
const OUT_DIR = "/home/runner/workspace/artifacts/jpo-huddle/public/assets/neighborhood/commercial";
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const manifest = { assets: {}, rooms: {} };

const assetSources = {
  // Museum
  "museum_velvet_rope": "22_Museum_Singles/Museum_Singles_27.png",
  "museum_info_board": "22_Museum_Singles/Museum_Singles_109.png",
  "museum_art_1": "22_Museum_Singles/Museum_Singles_109.png",
  "museum_art_2": "22_Museum_Singles/Museum_Singles_114.png",
  "museum_art_3": "22_Museum_Singles/Museum_Singles_115.png",
  "museum_sculpture_1": "22_Museum_Singles/Museum_Singles_256.png",
  "museum_gallery_display_1": "22_Museum_Singles/Museum_Singles_281.png",
  "museum_gallery_display_2": "22_Museum_Singles/Museum_Singles_301.png",
  "museum_fossil_exhibit_left": "22_Museum_Singles/Museum_Singles_356.png",
  "museum_fossil_exhibit_right": "22_Museum_Singles/Museum_Singles_357.png",
  "museum_display_case": "22_Museum_Singles/Museum_Singles_129.png",
  "museum_display_case_2": "22_Museum_Singles/Museum_Singles_130.png",
  "museum_plant_display": "22_Museum_Singles/Museum_Singles_197.png",
  "museum_butterfly_display": "22_Museum_Singles/Museum_Singles_164.png",
  "museum_vase": "22_Museum_Singles/Museum_Singles_64.png",

  // Cafe
  "cafe_table": "12_Kitchen_Singles/Kitchen_Singles_314.png",
  "cafe_chair_up": "12_Kitchen_Singles/Kitchen_Singles_290.png",
  "cafe_chair_down": "12_Kitchen_Singles/Kitchen_Singles_291.png",
  "cafe_counter": "12_Kitchen_Singles/Kitchen_Singles_134.png",
  "cafe_coffee_machine": "12_Kitchen_Singles/Kitchen_Singles_152.png",
  "cafe_menu": "24_Ice_Cream_Shop_Singles/Ice_Cream_Shop_Singles_14.png",
  "cafe_plant": "2_Living_Room_Singles/Living_Room_Singles_13.png",

  // Diner
  "diner_booth_red": "12_Kitchen_Singles/Kitchen_Singles_316.png",
  "diner_table": "12_Kitchen_Singles/Kitchen_Singles_314.png",
  "diner_counter": "12_Kitchen_Singles/Kitchen_Singles_304.png",
  "diner_stool": "12_Kitchen_Singles/Kitchen_Singles_298.png",
  "diner_jukebox": "10_Birthday_Party_Singles/Birthday_Party_Singles_3.png",
  "diner_grill": "12_Kitchen_Singles/Kitchen_Singles_140.png",


  // Bakery
  "bakery_display_case": "24_Ice_Cream_Shop_Singles/Ice_Cream_Shop_Singles_21.png",
  "bakery_bread_rack": "16_Grocery_Store_Singles/Grocery_Store_Singles_82.png",
  "bakery_counter": "16_Grocery_Store_Singles/Grocery_Store_Singles_121.png",
  "bakery_cake": "10_Birthday_Party_Singles/Birthday_Party_Singles_16.png",
  "bakery_table": "12_Kitchen_Singles/Kitchen_Singles_284.png",
  "bakery_chair": "12_Kitchen_Singles/Kitchen_Singles_290.png",

  // Sushi (Japanese)
  "sushi_counter": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_61.png",
  "sushi_table": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_50.png",
  "sushi_cushion": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_42.png",
  "sushi_lantern": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_17.png",
  "sushi_bonsai": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_57.png",
  "sushi_mat": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_9.png",
  "sushi_screen": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_62.png",
  "sushi_plate": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_74.png",

  // Shops (Decor)
  "shop_sofa": "2_Living_Room_Singles/Living_Room_Singles_117.png",
  "shop_shelf": "2_Living_Room_Singles/Living_Room_Singles_92.png",
  "shop_lamp": "2_Living_Room_Singles/Living_Room_Singles_84.png",
  "shop_rug": "2_Living_Room_Singles/Living_Room_Singles_4.png",
  "shop_mirror": "2_Living_Room_Singles/Living_Room_Singles_90.png",
  "shop_plant_large": "16_Grocery_Store_Singles/Grocery_Store_Singles_452.png",
  "shop_plant_small": "16_Grocery_Store_Singles/Grocery_Store_Singles_461.png",
  "shop_display_stand": "22_Museum_Singles/Museum_Singles_129.png",


  // Floors / Walls (architectural fallback)
  "floor_wood": "16_Grocery_Store_Singles/Grocery_Store_Singles_182.png",
  "floor_tile": "12_Kitchen_Singles/Kitchen_Singles_221.png",
  "floor_carpet": "2_Living_Room_Singles/Living_Room_Singles_5.png"
};

for (const [key, relPath] of Object.entries(assetSources)) {
  const src = path.join(SRC, relPath);
  const dst = path.join(OUT_DIR, `${key}.png`);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    manifest.assets[key] = `assets/neighborhood/commercial/${key}.png`;
  } else {
    console.error("Missing art:", src);
    process.exit(1);
  }
}

// The museum sheet's first sprite is a multi-tile ticket-counter assembly,
// not a doorway. Reuse the already verified single shop doorway instead.
const nativeMuseumDoor = path.join(
  "/home/runner/workspace/artifacts/jpo-huddle/public/assets/neighborhood/facades",
  "shop_door.png"
);
fs.copyFileSync(nativeMuseumDoor, path.join(OUT_DIR, "museum_door.png"));
manifest.assets.museum_door = "assets/neighborhood/commercial/museum_door.png";

const mkObj = (asset, x, y, depth = y) => ({ asset, x, y, depth, scale: 3 });
const mkBlock = (x, y, w, h) => ({ x, y, width: w, height: h });

let objects = [];
let blockers = [];
let seats = [];
let idCounter = 0;

function clearRoom() {
  objects = []; blockers = []; seats = [];
}

function addSeat(asset, objX, objY, padY, dir, standsX, standsY) {
  objects.push(mkObj(asset, objX, objY));
  seats.push({
    id: `seat-${idCounter++}`,
    x: objX,
    y: padY - 27,
    depthAnchor: objY,
    dir,
    stands: [{ x: standsX, y: standsY, dir }]
  });
}

// === MUSEUM FOYER ===
clearRoom();
// 4 doors
[192, 384, 576, 768].forEach(x => {
  objects.push(mkObj("museum_door", x, 48));
});
objects.push(mkObj("museum_info_board", 300, 300));
objects.push(mkObj("museum_info_board", 660, 300));
objects.push(mkObj("museum_gallery_display_1", 192, 420));
objects.push(mkObj("museum_gallery_display_2", 768, 420));
blockers.push(
  mkBlock(276, 276, 48, 48), mkBlock(636, 276, 48, 48),
  mkBlock(168, 372, 48, 48), mkBlock(744, 372, 48, 48)
);
manifest.rooms["museum"] = {
  label: "Museum Foyer", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// === MUSEUM GALLERY 1 ===
clearRoom();
objects.push(mkObj("museum_art_1", 200, 250));
objects.push(mkObj("museum_art_2", 480, 250));
objects.push(mkObj("museum_art_3", 760, 250));
blockers.push(mkBlock(152, 226, 96, 48), mkBlock(432, 226, 96, 48), mkBlock(712, 226, 96, 48));
objects.push(mkObj("museum_sculpture_1", 480, 450));
blockers.push(mkBlock(456, 426, 48, 48));
manifest.rooms["museum-room-1"] = {
  label: "Art Gallery", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// === MUSEUM GALLERY 2 ===
clearRoom();
objects.push(mkObj("museum_fossil_exhibit_left", 300, 300));
objects.push(mkObj("museum_fossil_exhibit_right", 660, 300));
blockers.push(mkBlock(180, 252, 240, 72), mkBlock(540, 252, 240, 72));
manifest.rooms["museum-room-2"] = {
  label: "Fossil Gallery", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// === MUSEUM GALLERY 3 ===
clearRoom();
objects.push(mkObj("museum_display_case", 300, 350));
objects.push(mkObj("museum_display_case_2", 660, 350));
blockers.push(mkBlock(276, 326, 48, 48), mkBlock(636, 326, 48, 48));
manifest.rooms["museum-room-3"] = {
  label: "Exhibit Gallery", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// === MUSEUM GALLERY 4 ===
clearRoom();
objects.push(mkObj("museum_plant_display", 300, 350));
objects.push(mkObj("museum_butterfly_display", 660, 350));
blockers.push(mkBlock(276, 326, 48, 48), mkBlock(636, 326, 48, 48));
manifest.rooms["museum-room-4"] = {
  label: "Nature Gallery", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// === CAFE ===
clearRoom();
for(let i=0; i<6; i++) {
  objects.push(mkObj("cafe_counter", 144 + i*48, 150));
  blockers.push(mkBlock(144 + i*48 - 24, 126, 48, 48));
}
objects.push(mkObj("cafe_coffee_machine", 240, 130));
objects.push(mkObj("cafe_menu", 480, 100));
objects.push(mkObj("cafe_plant", 800, 150));
const cafeTables = [[200,350],[400,350],[600,350],[800,350], [200,550],[400,550],[600,550],[800,550]];
cafeTables.forEach(([tx, ty]) => {
  objects.push(mkObj("cafe_table", tx, ty));
  blockers.push(mkBlock(tx-20, ty-20, 40, 40));
  addSeat("cafe_chair_down", tx, ty+85, ty+85 - 15, "up", tx, ty+115);
  addSeat("cafe_chair_up", tx, ty-25, ty-25 - 15, "down", tx, ty-60);
});
manifest.rooms["cafe"] = {
  label: "Cafe", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// === DINER ===
clearRoom();
for(let i=0; i<8; i++) {
  objects.push(mkObj("diner_counter", 144 + i*48, 200));
  blockers.push(mkBlock(144 + i*48 - 24, 176, 48, 48));
}
objects.push(mkObj("diner_grill", 240, 150));
objects.push(mkObj("diner_grill", 288, 150));
blockers.push(mkBlock(216, 126, 96, 48));
objects.push(mkObj("diner_jukebox", 800, 200));
blockers.push(mkBlock(776, 176, 48, 48));

for(let i=0; i<8; i++) {
  addSeat("diner_stool", 144 + i*48, 290, 290 - 15, "up", 144 + i*48, 320);
}

const booths = [[250, 450], [250, 600], [700, 450], [700, 600]];
booths.forEach(([bx, by]) => {
  objects.push(mkObj("diner_table", bx, by));

  blockers.push(mkBlock(bx-20, by-20, 40, 40));
  addSeat("diner_booth_red", bx - 40, by, by - 15, "right", bx - 70, by);
  addSeat("diner_booth_red", bx + 40, by, by - 15, "left", bx + 70, by);
});
manifest.rooms["diner"] = {
  label: "Diner", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// === BAKERY ===
clearRoom();
for(let i=0; i<4; i++) {
  objects.push(mkObj("bakery_counter", 300 + i*48, 250));
  blockers.push(mkBlock(300 + i*48 - 24, 226, 48, 48));
}
objects.push(mkObj("bakery_display_case", 200, 250));
blockers.push(mkBlock(176, 226, 48, 48));
objects.push(mkObj("bakery_cake", 348, 230));

for(let i=0; i<5; i++) {
  objects.push(mkObj("bakery_bread_rack", 150 + i*48, 150));
  blockers.push(mkBlock(150 + i*48 - 24, 126, 48, 48));
}

const bakTables = [[300,450],[600,450],[250,600]];
bakTables.forEach(([tx, ty]) => {
  objects.push(mkObj("bakery_table", tx, ty));
  blockers.push(mkBlock(tx-20, ty-20, 40, 40));
  // The back-row chair is next to the south wall: approach from its side,
  // without moving its authored cushion/feet anchor or crossing the table.
  addSeat("bakery_chair", tx, ty+85, ty+85 - 15, "up",
    ty === 600 ? tx + 64 : tx, ty === 600 ? ty + 43 : ty + 115);
  addSeat("bakery_chair", tx, ty-25, ty-25 - 15, "down", tx, ty-60);
});
manifest.rooms["bakery"] = {
  label: "Bakery", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// === SUSHI ===
clearRoom();
for(let i=0; i<6; i++) {
  objects.push(mkObj("sushi_counter", 300 + i*48, 250));
  blockers.push(mkBlock(300 + i*48 - 24, 226, 48, 48));
  objects.push(mkObj("sushi_mat", 300 + i*48, 240));
  addSeat("sushi_cushion", 300 + i*48, 330, 330 - 10, "up", 300 + i*48, 370);
}
objects.push(mkObj("sushi_bonsai", 750, 200));
blockers.push(mkBlock(726, 176, 48, 48));
objects.push(mkObj("sushi_lantern", 250, 150));
objects.push(mkObj("sushi_lantern", 750, 150));

const sTables = [[250, 450], [700, 450]];
sTables.forEach(([tx, ty]) => {
  objects.push(mkObj("sushi_table", tx, ty));
  objects.push(mkObj("sushi_plate", tx - 10, ty - 5));
  objects.push(mkObj("sushi_plate", tx + 10, ty - 5));
  blockers.push(mkBlock(tx-36, ty-24, 72, 48));
  addSeat("sushi_cushion", tx - 55, ty, ty - 10, "right", tx - 85, ty);
  addSeat("sushi_cushion", tx + 55, ty, ty - 10, "left", tx + 85, ty);
});
manifest.rooms["sushi"] = {
  label: "Sushi", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// === PLAZA DECOR (decor-shop) ===
clearRoom();


for(let i=0; i<4; i++) {
  objects.push(mkObj("shop_shelf", 200 + i*48, 150));
  blockers.push(mkBlock(200 + i*48 - 24, 126, 48, 48));
}

addSeat("shop_sofa", 300, 400, 385, "down", 300, 450);
objects.push(mkObj("shop_lamp", 200, 400));
blockers.push(mkBlock(186, 376, 30, 48));

objects.push(mkObj("shop_mirror", 600, 400));
blockers.push(mkBlock(576, 376, 48, 48));
objects.push(mkObj("shop_plant_large", 700, 400));
blockers.push(mkBlock(676, 376, 48, 48));

objects.push(mkObj("shop_display_stand", 480, 500));
blockers.push(mkBlock(456, 476, 48, 48));

manifest.rooms["decor-shop"] = {
  label: "Plaza Decor", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// === FURNITURE SHOP ===
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
};

applyGymLayout(manifest);
applyFoodVenueLayouts(manifest);
applyDecorSushiLayouts(manifest);
applyMuseumLayout(manifest);


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
    if (!manifest.assets[obj.asset]) {
      console.error("Room references missing asset:", obj.asset);
      process.exit(1);
    }
  }
}

const json = JSON.stringify(manifest, null, 2);
fs.writeFileSync("/home/runner/workspace/artifacts/jpo-huddle/public/commercial-layouts.json", json);
fs.writeFileSync(path.join(OUT_DIR, "../commercial-layouts.json"), json);
