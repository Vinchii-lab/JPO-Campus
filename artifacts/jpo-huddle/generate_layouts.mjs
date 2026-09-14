import fs from 'fs';
import path from 'path';

const SRC = "/tmp/sprites/1_Interiors/16x16/Theme_Sorter_Singles";
const OUT_DIR = "/home/runner/workspace/artifacts/jpo-huddle/public/assets/neighborhood/commercial";
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const manifest = { assets: {}, rooms: {} };

// Define assets with their source paths relative to SRC
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

  // Cafe (using Kitchen & Living Room)
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
  "diner_jukebox": "10_Birthday_Party_Singles/Birthday_Party_Singles_3.png", // fallback
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

  // Shops
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

// Copy files and build assets map
for (const [key, relPath] of Object.entries(assetSources)) {
  const src = path.join(SRC, relPath);
  const dst = path.join(OUT_DIR, `${key}.png`);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    manifest.assets[key] = `assets/neighborhood/commercial/${key}.png`;
  } else {
    console.log("WARNING: Missing asset source:", src);
  }
}

// Helpers
const mkObj = (asset, x, y, depth = y) => ({ asset, x, y, depth, scale: 3 });
const mkBlock = (x, y, w, h) => ({ x, y, width: w, height: h });
// Footprint helper (anchor is bottom-center, typical for 48x48 sprite)
// So x is center, y is bottom. Blocker would be x-24, y-24, 48, 24 roughly
const autoBlock = (objs) => objects.map(o => mkBlock(o.x - 20, o.y - 20, 40, 20));

let objects = [];
let blockers = [];
let seats = [];

function clearRoom() {
  objects = []; blockers = []; seats = [];
}

// Draw a line of objects
function drawLine(asset, startX, startY, count, stepX, stepY, blockWidth=40, blockHeight=20) {
  for(let i=0; i<count; i++) {
    const x = startX + i*stepX;
    const y = startY + i*stepY;
    objects.push(mkObj(asset, x, y));
    blockers.push(mkBlock(x - blockWidth/2, y - blockHeight, blockWidth, blockHeight));
  }
}

// MUSEUM FOYER
clearRoom();
// 4 doors at x192, 384, 576, 768. Width 96.
// Desk in middle
drawLine("museum_foyer_desk", 480 - 48, 300, 3, 48, 0, 48, 24);
objects.push(mkObj("museum_info_board", 200, 400));
objects.push(mkObj("museum_info_board", 760, 400));
blockers.push(mkBlock(180, 380, 40, 20), mkBlock(740, 380, 40, 20));
// Velvet ropes guiding to center
drawLine("museum_velvet_rope", 336, 450, 4, 0, 48, 10, 48);
drawLine("museum_velvet_rope", 624, 450, 4, 0, 48, 10, 48);

manifest.rooms["museum"] = {
  label: "Museum Foyer", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// MUSEUM ROOM 1 (Art)
clearRoom();
drawLine("museum_art_1", 144, 150, 3, 144, 0, 48, 24);
drawLine("museum_art_2", 144, 300, 3, 144, 0, 48, 24);
drawLine("museum_display_case", 600, 200, 2, 96, 0, 48, 48);
drawLine("museum_display_case_2", 600, 400, 2, 96, 0, 48, 48);
objects.push(mkObj("museum_sculpture_1", 480, 250));
blockers.push(mkBlock(456, 226, 48, 24));
manifest.rooms["museum-room-1"] = {
  label: "Art Gallery", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// MUSEUM ROOM 2 (Fossils)
clearRoom();
// TRex
objects.push(mkObj("museum_fossil_trex_head", 250, 300));
objects.push(mkObj("museum_fossil_trex_body", 298, 300));
objects.push(mkObj("museum_fossil_trex_tail", 346, 300));
blockers.push(mkBlock(226, 280, 144, 24));
// Triceratops
objects.push(mkObj("museum_fossil_tri_head", 600, 450));
objects.push(mkObj("museum_fossil_tri_body", 648, 450));
objects.push(mkObj("museum_fossil_tri_tail", 696, 450));
blockers.push(mkBlock(576, 430, 144, 24));
manifest.rooms["museum-room-2"] = {
  label: "Fossil Gallery", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// MUSEUM ROOM 3 (Statues)
clearRoom();
drawLine("museum_sculpture_1", 200, 200, 4, 144, 0, 48, 24);
drawLine("museum_sculpture_2", 200, 400, 4, 144, 0, 48, 24);
drawLine("museum_vase", 272, 300, 3, 144, 0, 48, 24);
manifest.rooms["museum-room-3"] = {
  label: "Statue Gallery", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// MUSEUM ROOM 4 (Botanical/Bugs)
clearRoom();
drawLine("museum_plant_display", 200, 200, 3, 144, 0, 48, 48);
drawLine("museum_plant_display", 200, 400, 3, 144, 0, 48, 48);
drawLine("museum_butterfly_display", 650, 200, 2, 96, 0, 48, 48);
manifest.rooms["museum-room-4"] = {
  label: "Nature Gallery", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// CAFE
clearRoom();
drawLine("cafe_counter", 144, 150, 6, 48, 0, 48, 48);
objects.push(mkObj("cafe_coffee_machine", 240, 130));
objects.push(mkObj("cafe_menu", 480, 100));
objects.push(mkObj("cafe_plant", 800, 150));
// Tables
const cafeTables = [[200,300],[400,300],[600,300],[800,300], [200,500],[400,500],[600,500],[800,500]];
cafeTables.forEach(([tx, ty], i) => {
  objects.push(mkObj("cafe_table", tx, ty));
  blockers.push(mkBlock(tx-20, ty-20, 40, 40));
  objects.push(mkObj("cafe_chair_up", tx, ty-40));
  objects.push(mkObj("cafe_chair_down", tx, ty+40));
  seats.push({ id: `cafe-u-${i}`, x: tx, y: ty-40, dir: "down", stands: [{x: tx, y: ty-80, dir: "down"}] });
  seats.push({ id: `cafe-d-${i}`, x: tx, y: ty+40, dir: "up", stands: [{x: tx, y: ty+80, dir: "up"}] });
});
manifest.rooms["cafe"] = {
  label: "Cafe", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// DINER
clearRoom();
drawLine("diner_counter", 144, 200, 8, 48, 0, 48, 48);
drawLine("diner_grill", 240, 150, 2, 48, 0, 48, 24);
drawLine("diner_stool", 144, 248, 8, 48, 0, 24, 24);
// Booths
const booths = [[200, 400], [200, 550], [760, 400], [760, 550]];
booths.forEach(([bx, by], i) => {
  objects.push(mkObj("diner_booth_red", bx, by));
  blockers.push(mkBlock(bx-48, by-30, 96, 60));
  seats.push({ id: `booth-l-${i}`, x: bx-24, y: by, dir: "right", stands: [{x: bx-60, y: by, dir: "right"}] });
  seats.push({ id: `booth-r-${i}`, x: bx+24, y: by, dir: "left", stands: [{x: bx+60, y: by, dir: "left"}] });
});
manifest.rooms["diner"] = {
  label: "Diner", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// BAKERY
clearRoom();
drawLine("bakery_counter", 300, 200, 4, 48, 0, 48, 48);
objects.push(mkObj("bakery_display_case", 200, 200));
objects.push(mkObj("bakery_cake", 348, 180));
drawLine("bakery_bread_rack", 150, 150, 5, 48, 0, 48, 24);
const bakTables = [[300,400],[600,400],[450,550]];
bakTables.forEach(([tx, ty], i) => {
  objects.push(mkObj("bakery_table", tx, ty));
  blockers.push(mkBlock(tx-20, ty-20, 40, 40));
  objects.push(mkObj("bakery_chair", tx, ty-40));
  seats.push({ id: `bak-${i}`, x: tx, y: ty-40, dir: "down", stands: [{x: tx, y: ty-80, dir: "down"}] });
});
manifest.rooms["bakery"] = {
  label: "Bakery", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// SUSHI
clearRoom();
drawLine("sushi_counter", 300, 250, 6, 48, 0, 48, 48);
drawLine("sushi_mat", 300, 240, 6, 48, 0, 20, 20);
drawLine("sushi_cushion", 300, 300, 6, 48, 0, 24, 24);
for(let i=0; i<6; i++) {
  seats.push({ id: `sushi-${i}`, x: 300 + i*48, y: 300, dir: "up", stands: [{x: 300 + i*48, y: 340, dir: "up"}] });
}
objects.push(mkObj("sushi_bonsai", 750, 200));
objects.push(mkObj("sushi_lantern", 250, 150));
objects.push(mkObj("sushi_lantern", 750, 150));
// Tables
const sTables = [[250, 450], [700, 450]];
sTables.forEach(([tx, ty], i) => {
  objects.push(mkObj("sushi_table", tx, ty));
  blockers.push(mkBlock(tx-36, ty-24, 72, 48));
  objects.push(mkObj("sushi_cushion", tx, ty-40));
  objects.push(mkObj("sushi_cushion", tx, ty+40));
  seats.push({ id: `st-u-${i}`, x: tx, y: ty-40, dir: "down", stands: [{x: tx, y: ty-70, dir: "down"}] });
  seats.push({ id: `st-d-${i}`, x: tx, y: ty+40, dir: "up", stands: [{x: tx, y: ty+70, dir: "up"}] });
});
manifest.rooms["sushi"] = {
  label: "Sushi", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// FURNITURE SHOP
clearRoom();
// Dense showroom layout
drawLine("shop_shelf", 144, 150, 4, 48, 0, 48, 48);
objects.push(mkObj("shop_sofa", 240, 400));
objects.push(mkObj("shop_rug", 240, 410));
objects.push(mkObj("shop_lamp", 180, 400));
blockers.push(mkBlock(192, 380, 96, 48));
manifest.rooms["furniture-shop"] = {
  label: "Furniture Shop", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// GARDEN SHOP
clearRoom();
drawLine("shop_plant_large", 200, 200, 4, 96, 0, 48, 48);
drawLine("shop_plant_small", 200, 350, 8, 48, 0, 24, 24);
drawLine("shop_plant_large", 200, 500, 4, 96, 0, 48, 48);
manifest.rooms["garden-shop"] = {
  label: "Garden Shop", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

// DECOR SHOP
clearRoom();
drawLine("shop_rug", 300, 300, 3, 96, 0, 10, 10); // Rugs shouldn't block
drawLine("shop_mirror", 300, 150, 3, 96, 0, 48, 24);
drawLine("shop_lamp", 300, 450, 3, 96, 0, 24, 24);
manifest.rooms["decor-shop"] = {
  label: "Decor Shop", width: 960, height: 720,
  objects: [...objects], blockers: [...blockers], seats: [...seats]
};

fs.writeFileSync(path.join(OUT_DIR, "../commercial-layouts.json"), JSON.stringify(manifest, null, 2));
console.log("Layouts written to " + path.join(OUT_DIR, "../commercial-layouts.json"));
