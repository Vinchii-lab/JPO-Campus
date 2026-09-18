import fs from 'fs';
import path from 'path';

const SRC = "/tmp/sprites/1_Interiors/16x16/Theme_Sorter_Singles";
const OUT_DIR = "/home/runner/workspace/artifacts/jpo-huddle/public/assets/neighborhood/commercial";
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const manifest = { assets: {}, rooms: {} };

const assetSources = {
  // Museum
  "museum_foyer_desk": "22_Museum_Singles/Museum_Singles_25.png",
  "museum_velvet_rope": "22_Museum_Singles/Museum_Singles_27.png",
  "museum_info_board": "22_Museum_Singles/Museum_Singles_14.png",
  "museum_door": "22_Museum_Singles/Museum_Singles_1.png", 
  "museum_art_1": "22_Museum_Singles/Museum_Singles_91.png",
  "museum_art_2": "22_Museum_Singles/Museum_Singles_101.png",
  "museum_art_3": "22_Museum_Singles/Museum_Singles_111.png",
  "museum_sculpture_1": "22_Museum_Singles/Museum_Singles_255.png",
  "museum_sculpture_2": "22_Museum_Singles/Museum_Singles_256.png",
  "museum_sculpture_3": "22_Museum_Singles/Museum_Singles_285.png",
  "museum_fossil_trex_head": "22_Museum_Singles/Museum_Singles_350.png",
  "museum_fossil_trex_body": "22_Museum_Singles/Museum_Singles_351.png",
  "museum_fossil_trex_tail": "22_Museum_Singles/Museum_Singles_352.png",
  "museum_fossil_tri_head": "22_Museum_Singles/Museum_Singles_345.png",
  "museum_fossil_tri_body": "22_Museum_Singles/Museum_Singles_346.png",
  "museum_fossil_tri_tail": "22_Museum_Singles/Museum_Singles_347.png",
  "museum_display_case": "22_Museum_Singles/Museum_Singles_129.png",
  "museum_display_case_2": "22_Museum_Singles/Museum_Singles_130.png",
  "museum_plant_display": "22_Museum_Singles/Museum_Singles_197.png",
  "museum_butterfly_display": "22_Museum_Singles/Museum_Singles_164.png",
  "museum_vase": "22_Museum_Singles/Museum_Singles_64.png",
  "museum_bench": "22_Museum_Singles/Museum_Singles_5.png",

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

  // Shops (Decor)
  "shop_sofa": "2_Living_Room_Singles/Living_Room_Singles_117.png",
  "shop_shelf": "2_Living_Room_Singles/Living_Room_Singles_92.png",
  "shop_lamp": "2_Living_Room_Singles/Living_Room_Singles_84.png",
  "shop_rug": "2_Living_Room_Singles/Living_Room_Singles_4.png",
  "shop_mirror": "2_Living_Room_Singles/Living_Room_Singles_90.png",
  "shop_plant_large": "16_Grocery_Store_Singles/Grocery_Store_Singles_452.png",
  "shop_plant_small": "16_Grocery_Store_Singles/Grocery_Store_Singles_461.png",
  "shop_display_stand": "22_Museum_Singles/Museum_Singles_129.png",
  "shop_cash_register": "16_Grocery_Store_Singles/Grocery_Store_Singles_125.png",

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
  }
}

const mkObj = (asset, x, y, depth = y) => ({ asset, x, y, depth, scale: 3 });
const mkBlock = (x, y, w, h) => ({ x, y, width: w, height: h });

let objects = [];
let blockers = [];
let seats = [];
let idCounter = 0;

function clearRoom() {
  objects = []; blockers = []; seats = []; idCounter = 0;
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
objects.push(mkObj("museum_foyer_desk", 480, 300));
blockers.push(mkBlock(432, 276, 96, 48));
objects.push(mkObj("museum_info_board", 300, 300));
blockers.push(mkBlock(280, 290, 40, 20));
objects.push(mkObj("museum_info_board", 660, 300));
blockers.push(mkBlock(640, 290, 40, 20));
addSeat("museum_bench", 200, 450, 435, "down", 200, 490);
addSeat("museum_bench", 760, 450, 435, "down", 760, 490);
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
addSeat("museum_bench", 480, 600, 585, "down", 480, 640);
manifest.rooms["museum-room-1"] = {
  label: "Art Gallery", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// === MUSEUM GALLERY 2 ===
clearRoom();
objects.push(mkObj("museum_fossil_trex_head", 400, 350));
objects.push(mkObj("museum_fossil_trex_body", 448, 350));
objects.push(mkObj("museum_fossil_trex_tail", 496, 350));
blockers.push(mkBlock(376, 330, 144, 48));
objects.push(mkObj("museum_fossil_tri_head", 400, 550));
objects.push(mkObj("museum_fossil_tri_body", 448, 550));
objects.push(mkObj("museum_fossil_tri_tail", 496, 550));
blockers.push(mkBlock(376, 530, 144, 48));
manifest.rooms["museum-room-2"] = {
  label: "Fossil Gallery", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// === MUSEUM GALLERY 3 ===
clearRoom();
objects.push(mkObj("museum_display_case", 300, 350));
objects.push(mkObj("museum_display_case_2", 660, 350));
blockers.push(mkBlock(276, 326, 48, 48), mkBlock(636, 326, 48, 48));
addSeat("museum_bench", 480, 550, 535, "down", 480, 590);
manifest.rooms["museum-room-3"] = {
  label: "Exhibit Gallery", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// === MUSEUM GALLERY 4 ===
clearRoom();
objects.push(mkObj("museum_plant_display", 300, 350));
objects.push(mkObj("museum_butterfly_display", 660, 350));
blockers.push(mkBlock(276, 326, 48, 48), mkBlock(636, 326, 48, 48));
addSeat("museum_bench", 480, 550, 535, "down", 480, 590);
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
  addSeat("cafe_chair_down", tx, ty+35, ty+35 - 15, "up", tx, ty+70); 
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
  addSeat("diner_stool", 144 + i*48, 260, 260 - 15, "up", 144 + i*48, 290);
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

const bakTables = [[300,450],[600,450],[450,600]];
bakTables.forEach(([tx, ty]) => {
  objects.push(mkObj("bakery_table", tx, ty));
  blockers.push(mkBlock(tx-20, ty-20, 40, 40));
  addSeat("bakery_chair", tx, ty+35, ty+35 - 15, "up", tx, ty+70);
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
  addSeat("sushi_cushion", 300 + i*48, 290, 290 - 10, "up", 300 + i*48, 330);
}
objects.push(mkObj("sushi_bonsai", 750, 200));
blockers.push(mkBlock(726, 176, 48, 48));
objects.push(mkObj("sushi_lantern", 250, 150));
objects.push(mkObj("sushi_lantern", 750, 150));

const sTables = [[250, 450], [700, 450]];
sTables.forEach(([tx, ty]) => {
  objects.push(mkObj("sushi_table", tx, ty));
  blockers.push(mkBlock(tx-36, ty-24, 72, 48));
  addSeat("sushi_cushion", tx - 40, ty, ty - 10, "right", tx - 70, ty);
  addSeat("sushi_cushion", tx + 40, ty, ty - 10, "left", tx + 70, ty);
});
manifest.rooms["sushi"] = {
  label: "Sushi", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// === PLAZA DECOR (decor-shop) ===
clearRoom();
objects.push(mkObj("shop_cash_register", 480, 200));
blockers.push(mkBlock(456, 176, 48, 48));

for(let i=0; i<4; i++) {
  objects.push(mkObj("shop_shelf", 200 + i*48, 150));
  blockers.push(mkBlock(200 + i*48 - 24, 126, 48, 48));
}

objects.push(mkObj("shop_rug", 300, 400));
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

manifest.rooms["furniture-shop"] = manifest.rooms["decor-shop"];
manifest.rooms["garden-shop"] = manifest.rooms["decor-shop"];

// Try loading gym
try {
  const { applyGymLayout } = await import('./gym-layout.mjs');
  applyGymLayout(manifest);
} catch (e) {}

fs.writeFileSync(path.join(OUT_DIR, "../commercial-layouts.json"), JSON.stringify(manifest, null, 2));
