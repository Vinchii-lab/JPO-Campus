import json, os, shutil
from PIL import Image

SRC = "/tmp/sprites/1_Interiors/16x16/Theme_Sorter_Singles"
OUT_DIR = "/home/runner/workspace/artifacts/jpo-huddle/public/assets/neighborhood/commercial"
os.makedirs(OUT_DIR, exist_ok=True)

manifest = {"assets": {}, "rooms": {}}

assets_map = {
    # Museum
    "museum_desk": "22_Museum_Singles/Museum_Singles_25.png",
    "museum_rope": "22_Museum_Singles/Museum_Singles_27.png",
    "museum_sign": "22_Museum_Singles/Museum_Singles_12.png",
    
    # Art Gallery
    "museum_art_1": "22_Museum_Singles/Museum_Singles_91.png",
    "museum_art_2": "22_Museum_Singles/Museum_Singles_101.png",
    "museum_art_3": "22_Museum_Singles/Museum_Singles_111.png",
    "museum_art_4": "22_Museum_Singles/Museum_Singles_121.png",
    "museum_bench": "22_Museum_Singles/Museum_Singles_141.png",
    
    # Fossil Gallery
    "museum_fossil_trex_head": "22_Museum_Singles/Museum_Singles_350.png",
    "museum_fossil_trex_body": "22_Museum_Singles/Museum_Singles_351.png",
    "museum_fossil_trex_tail": "22_Museum_Singles/Museum_Singles_352.png",
    "museum_fossil_tri_head": "22_Museum_Singles/Museum_Singles_345.png",
    "museum_fossil_tri_body": "22_Museum_Singles/Museum_Singles_346.png",
    "museum_fossil_tri_tail": "22_Museum_Singles/Museum_Singles_347.png",
    "museum_fossil_display": "22_Museum_Singles/Museum_Singles_337.png",
    
    # Antiquities
    "museum_sculpture_1": "22_Museum_Singles/Museum_Singles_275.png",
    "museum_sculpture_2": "22_Museum_Singles/Museum_Singles_255.png",
    "museum_sculpture_3": "22_Museum_Singles/Museum_Singles_285.png",
    "museum_vase": "22_Museum_Singles/Museum_Singles_64.png",
    "museum_pillar": "22_Museum_Singles/Museum_Singles_145.png",
    
    # Botanical / Bugs
    "museum_plant_display": "22_Museum_Singles/Museum_Singles_197.png",
    "museum_bug_display": "22_Museum_Singles/Museum_Singles_164.png",
    "museum_butterfly": "22_Museum_Singles/Museum_Singles_165.png",
    
    # Cafe
    "cafe_counter": "12_Kitchen_Singles/Kitchen_Singles_134.png",
    "cafe_table": "12_Kitchen_Singles/Kitchen_Singles_314.png",
    "cafe_chair": "12_Kitchen_Singles/Kitchen_Singles_290.png",
    "cafe_machine": "12_Kitchen_Singles/Kitchen_Singles_152.png",
    "cafe_plant": "2_Living_Room_Singles/Living_Room_Singles_13.png",
    "cafe_shelf": "12_Kitchen_Singles/Kitchen_Singles_155.png",
    
    # Diner
    "diner_booth": "12_Kitchen_Singles/Kitchen_Singles_316.png",
    "diner_table": "12_Kitchen_Singles/Kitchen_Singles_314.png", # fallback
    "diner_counter": "12_Kitchen_Singles/Kitchen_Singles_304.png",
    "diner_stool": "12_Kitchen_Singles/Kitchen_Singles_298.png",
    "diner_grill": "12_Kitchen_Singles/Kitchen_Singles_140.png",
    "diner_jukebox": "10_Birthday_Party_Singles/Birthday_Party_Singles_3.png",
    
    # Bakery
    "bakery_display": "24_Ice_Cream_Shop_Singles/Ice_Cream_Shop_Singles_21.png",
    "bakery_shelf": "16_Grocery_Store_Singles/Grocery_Store_Singles_121.png",
    "bakery_counter": "16_Grocery_Store_Singles/Grocery_Store_Singles_122.png",
    "bakery_bread": "16_Grocery_Store_Singles/Grocery_Store_Singles_82.png",
    "bakery_table": "12_Kitchen_Singles/Kitchen_Singles_284.png",
    "bakery_chair": "12_Kitchen_Singles/Kitchen_Singles_290.png",
    
    # Sushi
    "sushi_counter": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_61.png",
    "sushi_table": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_50.png",
    "sushi_cushion": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_42.png",
    "sushi_lantern": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_17.png",
    "sushi_bonsai": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_57.png",
    "sushi_screen": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_62.png",
    
    # Furniture Shop
    "furn_sofa": "2_Living_Room_Singles/Living_Room_Singles_117.png",
    "furn_chair": "2_Living_Room_Singles/Living_Room_Singles_119.png",
    "furn_bed": "4_Bedroom_Singles/Bedroom_Singles_11.png", 
    "furn_shelf": "2_Living_Room_Singles/Living_Room_Singles_92.png",
    "furn_tv": "2_Living_Room_Singles/Living_Room_Singles_66.png",
    
    # Garden Shop
    "garden_tree": "16_Grocery_Store_Singles/Grocery_Store_Singles_452.png",
    "garden_plant_1": "16_Grocery_Store_Singles/Grocery_Store_Singles_461.png",
    "garden_plant_2": "16_Grocery_Store_Singles/Grocery_Store_Singles_462.png",
    "garden_flower": "16_Grocery_Store_Singles/Grocery_Store_Singles_421.png",
    "garden_shelf": "16_Grocery_Store_Singles/Grocery_Store_Singles_356.png",
    
    # Decor Shop
    "decor_lamp": "2_Living_Room_Singles/Living_Room_Singles_84.png",
    "decor_mirror": "2_Living_Room_Singles/Living_Room_Singles_90.png",
    "decor_art": "22_Museum_Singles/Museum_Singles_91.png",
    "decor_rug": "2_Living_Room_Singles/Living_Room_Singles_4.png",
    "decor_plant": "2_Living_Room_Singles/Living_Room_Singles_14.png"
}

# 3x scale extraction
for k, v in assets_map.items():
    src = os.path.join(SRC, v)
    if os.path.exists(src):
        dst = os.path.join(OUT_DIR, k + ".png")
        try:
            im = Image.open(src)
            # Scale 3x nearest neighbor
            im_resized = im.resize((im.width * 3, im.height * 3), Image.NEAREST)
            im_resized.save(dst)
            manifest["assets"][k] = "assets/neighborhood/commercial/" + k + ".png"
        except Exception as e:
            print("Error resizing", src, e)
    else:
        # Fallback to a placeholder transparent image just in case
        print("Missing", src)

def mkobj(asset, x, y):
    # we already scaled the image by 3x, so in phaser we can just draw it at scale 1, 
    # but the layout uses the sprite's bottom center as anchor if we follow standard. 
    # Actually phaser JpoInteriors usually does setOrigin(0.5, 1). 
    # Let's specify scale 1 since we hard-scaled it, or scale 3 if we rely on Phaser?
    # Wait, if we scale it 3x in Python, it's a 48x48 image natively. 
    # The prompt says "Extract individual PNGs 3x nearest no placeholders. ... Native sprites can be 96x64 not 16x16 treat multi-tile objects."
    # If it's already 3x, Phaser scaling it another 3x would make it 9x!
    # "Art is rendered at native 3x and bottom-anchored" in neighborhood.mjs might mean we should leave it 1x and let Phaser scale it, or if we scale it here, we shouldn't scale in Phaser.
    # The instructions say "Extract individual PNGs 3x nearest... Native sprites can be 96x64 not 16x16". This implies the saved PNG should be 3x bigger (e.g. 48x48).
    # Then in Phaser, we just use it at scale 1, OR the prompt means the asset is ALREADY 3x natively (since we scale it) and Phaser shouldn't scale it further.
    # Let's just output scale: 1 in JSON.
    return {"asset": asset, "x": x, "y": y, "scale": 1}

def mkblock(x, y, w, h):
    return {"x": x, "y": y, "width": w, "height": h}

# Reserve bottom exit: 408..552, 648..720
rooms = {}

# Museum Foyer
rooms["museum"] = {
    "label": "Museum Foyer", "width": 960, "height": 720,
    "objects": [
        mkobj("museum_desk", 480, 400),
        mkobj("museum_desk", 432, 400),
        mkobj("museum_desk", 528, 400),
        mkobj("museum_sign", 250, 400),
        mkobj("museum_sign", 710, 400),
        # Ropes guiding the doors
        mkobj("museum_rope", 336, 400), mkobj("museum_rope", 336, 448),
        mkobj("museum_rope", 624, 400), mkobj("museum_rope", 624, 448),
    ],
    "blockers": [
        mkblock(408, 360, 144, 40),
        mkblock(320, 360, 32, 100),
        mkblock(608, 360, 32, 100),
    ],
    "seats": []
}

# Museum Room 1 (Art)
rooms["museum-room-1"] = {
    "label": "Art Gallery", "width": 960, "height": 720,
    "objects": [
        mkobj("museum_art_1", 200, 200),
        mkobj("museum_art_2", 480, 200),
        mkobj("museum_art_3", 760, 200),
        mkobj("museum_bench", 480, 400),
    ],
    "blockers": [
        mkblock(432, 380, 96, 40),
    ],
    "seats": [
        {"id": "bench1", "x": 480, "y": 400, "dir": "down", "stands": [{"x": 480, "y": 440, "dir": "down"}]}
    ]
}

# Museum Room 2 (Fossils)
rooms["museum-room-2"] = {
    "label": "Fossil Gallery", "width": 960, "height": 720,
    "objects": [
        mkobj("museum_fossil_trex_head", 250, 350),
        mkobj("museum_fossil_trex_body", 298, 350),
        mkobj("museum_fossil_trex_tail", 346, 350),
        mkobj("museum_fossil_tri_head", 600, 350),
        mkobj("museum_fossil_tri_body", 648, 350),
        mkobj("museum_fossil_tri_tail", 696, 350),
    ],
    "blockers": [
        mkblock(226, 330, 144, 40),
        mkblock(576, 330, 144, 40),
    ],
    "seats": []
}

# Museum Room 3 (Antiquities)
rooms["museum-room-3"] = {
    "label": "Antiquities Gallery", "width": 960, "height": 720,
    "objects": [
        mkobj("museum_sculpture_1", 300, 300),
        mkobj("museum_sculpture_2", 660, 300),
        mkobj("museum_pillar", 480, 250),
        mkobj("museum_vase", 480, 210),
    ],
    "blockers": [
        mkblock(276, 280, 48, 40),
        mkblock(636, 280, 48, 40),
        mkblock(456, 230, 48, 40),
    ],
    "seats": []
}

# Museum Room 4 (Botanical)
rooms["museum-room-4"] = {
    "label": "Botanical Gallery", "width": 960, "height": 720,
    "objects": [
        mkobj("museum_plant_display", 300, 250),
        mkobj("museum_plant_display", 660, 250),
        mkobj("museum_bug_display", 480, 350),
    ],
    "blockers": [
        mkblock(276, 230, 48, 40),
        mkblock(636, 230, 48, 40),
        mkblock(456, 330, 48, 40),
    ],
    "seats": []
}

# Cafe
rooms["cafe"] = {
    "label": "The Daily Grind", "width": 960, "height": 720,
    "objects": [
        mkobj("cafe_counter", 300, 200), mkobj("cafe_counter", 348, 200), mkobj("cafe_counter", 396, 200), mkobj("cafe_counter", 444, 200), mkobj("cafe_counter", 492, 200), mkobj("cafe_counter", 540, 200), mkobj("cafe_counter", 588, 200), mkobj("cafe_counter", 636, 200), mkobj("cafe_counter", 684, 200),
        mkobj("cafe_machine", 480, 180),
        mkobj("cafe_plant", 200, 200), mkobj("cafe_plant", 760, 200),
        # Tables
        mkobj("cafe_table", 300, 400), mkobj("cafe_chair", 300, 360), mkobj("cafe_chair", 300, 440),
        mkobj("cafe_table", 660, 400), mkobj("cafe_chair", 660, 360), mkobj("cafe_chair", 660, 440),
    ],
    "blockers": [
        mkblock(276, 180, 432, 40),
        mkblock(176, 180, 48, 40), mkblock(736, 180, 48, 40),
        mkblock(276, 380, 48, 48), mkblock(636, 380, 48, 48),
    ],
    "seats": [
        {"id": "cafe-1", "x": 300, "y": 360, "dir": "down", "stands": [{"x": 300, "y": 320, "dir": "down"}]},
        {"id": "cafe-2", "x": 300, "y": 440, "dir": "up", "stands": [{"x": 300, "y": 480, "dir": "up"}]},
        {"id": "cafe-3", "x": 660, "y": 360, "dir": "down", "stands": [{"x": 660, "y": 320, "dir": "down"}]},
        {"id": "cafe-4", "x": 660, "y": 440, "dir": "up", "stands": [{"x": 660, "y": 480, "dir": "up"}]},
    ]
}

# Diner
rooms["diner"] = {
    "label": "Neon Diner", "width": 960, "height": 720,
    "objects": [
        mkobj("diner_counter", 200, 250), mkobj("diner_counter", 248, 250), mkobj("diner_counter", 296, 250), mkobj("diner_counter", 344, 250), mkobj("diner_counter", 392, 250), mkobj("diner_counter", 444, 250), mkobj("diner_counter", 492, 250), mkobj("diner_counter", 540, 250), mkobj("diner_counter", 588, 250), mkobj("diner_counter", 636, 250), mkobj("diner_counter", 684, 250), mkobj("diner_counter", 732, 250), mkobj("diner_counter", 780, 250),
        mkobj("diner_stool", 248, 290), mkobj("diner_stool", 344, 290), mkobj("diner_stool", 444, 290), mkobj("diner_stool", 540, 290), mkobj("diner_stool", 636, 290), mkobj("diner_stool", 732, 290),
        mkobj("diner_jukebox", 850, 200),
        # Booths
        mkobj("diner_booth", 250, 500), mkobj("diner_table", 250, 500),
        mkobj("diner_booth", 710, 500), mkobj("diner_table", 710, 500),
    ],
    "blockers": [
        mkblock(176, 230, 624, 40),
        mkblock(826, 180, 48, 40),
        mkblock(202, 470, 96, 60),
        mkblock(662, 470, 96, 60),
    ],
    "seats": [
        {"id": "stool-1", "x": 248, "y": 290, "dir": "up", "stands": [{"x": 248, "y": 330, "dir": "up"}]},
        {"id": "stool-2", "x": 344, "y": 290, "dir": "up", "stands": [{"x": 344, "y": 330, "dir": "up"}]},
        {"id": "stool-3", "x": 444, "y": 290, "dir": "up", "stands": [{"x": 444, "y": 330, "dir": "up"}]},
        {"id": "stool-4", "x": 540, "y": 290, "dir": "up", "stands": [{"x": 540, "y": 330, "dir": "up"}]},
        {"id": "stool-5", "x": 636, "y": 290, "dir": "up", "stands": [{"x": 636, "y": 330, "dir": "up"}]},
        {"id": "stool-6", "x": 732, "y": 290, "dir": "up", "stands": [{"x": 732, "y": 330, "dir": "up"}]},
        {"id": "diner-b-1", "x": 226, "y": 500, "dir": "right", "stands": [{"x": 178, "y": 500, "dir": "right"}]},
        {"id": "diner-b-2", "x": 274, "y": 500, "dir": "left", "stands": [{"x": 322, "y": 500, "dir": "left"}]},
        {"id": "diner-b-3", "x": 686, "y": 500, "dir": "right", "stands": [{"x": 638, "y": 500, "dir": "right"}]},
        {"id": "diner-b-4", "x": 734, "y": 500, "dir": "left", "stands": [{"x": 782, "y": 500, "dir": "left"}]},
    ]
}

# Bakery
rooms["bakery"] = {
    "label": "Sweet Crust Bakery", "width": 960, "height": 720,
    "objects": [
        mkobj("bakery_counter", 300, 200), mkobj("bakery_display", 348, 200), mkobj("bakery_counter", 396, 200), mkobj("bakery_display", 444, 200), mkobj("bakery_counter", 492, 200), mkobj("bakery_display", 540, 200), mkobj("bakery_counter", 588, 200), mkobj("bakery_counter", 636, 200),
        mkobj("bakery_bread", 150, 150), mkobj("bakery_bread", 810, 150),
        mkobj("bakery_table", 300, 450), mkobj("bakery_chair", 300, 410),
        mkobj("bakery_table", 660, 450), mkobj("bakery_chair", 660, 410),
    ],
    "blockers": [
        mkblock(276, 180, 384, 40),
        mkblock(126, 130, 48, 40), mkblock(786, 130, 48, 40),
        mkblock(276, 430, 48, 48), mkblock(636, 430, 48, 48),
    ],
    "seats": [
        {"id": "bak-1", "x": 300, "y": 410, "dir": "down", "stands": [{"x": 300, "y": 370, "dir": "down"}]},
        {"id": "bak-2", "x": 660, "y": 410, "dir": "down", "stands": [{"x": 660, "y": 370, "dir": "down"}]},
    ]
}

# Sushi
rooms["sushi"] = {
    "label": "Sakura Sushi", "width": 960, "height": 720,
    "objects": [
        mkobj("sushi_counter", 300, 250), mkobj("sushi_counter", 348, 250), mkobj("sushi_counter", 396, 250), mkobj("sushi_counter", 444, 250), mkobj("sushi_counter", 492, 250), mkobj("sushi_counter", 540, 250), mkobj("sushi_counter", 588, 250), mkobj("sushi_counter", 636, 250), mkobj("sushi_counter", 684, 250),
        mkobj("sushi_lantern", 200, 150), mkobj("sushi_lantern", 760, 150),
        mkobj("sushi_bonsai", 492, 220),
        mkobj("sushi_cushion", 348, 290), mkobj("sushi_cushion", 444, 290), mkobj("sushi_cushion", 540, 290), mkobj("sushi_cushion", 636, 290),
        mkobj("sushi_table", 250, 450), mkobj("sushi_cushion", 250, 410), mkobj("sushi_cushion", 250, 490),
        mkobj("sushi_table", 710, 450), mkobj("sushi_cushion", 710, 410), mkobj("sushi_cushion", 710, 490),
    ],
    "blockers": [
        mkblock(276, 230, 432, 40),
        mkblock(176, 130, 48, 40), mkblock(736, 130, 48, 40),
        mkblock(226, 430, 48, 40), mkblock(686, 430, 48, 40),
    ],
    "seats": [
        {"id": "sushi-st-1", "x": 348, "y": 290, "dir": "up", "stands": [{"x": 348, "y": 330, "dir": "up"}]},
        {"id": "sushi-st-2", "x": 444, "y": 290, "dir": "up", "stands": [{"x": 444, "y": 330, "dir": "up"}]},
        {"id": "sushi-st-3", "x": 540, "y": 290, "dir": "up", "stands": [{"x": 540, "y": 330, "dir": "up"}]},
        {"id": "sushi-st-4", "x": 636, "y": 290, "dir": "up", "stands": [{"x": 636, "y": 330, "dir": "up"}]},
        {"id": "sushi-tb-1-u", "x": 250, "y": 410, "dir": "down", "stands": [{"x": 250, "y": 370, "dir": "down"}]},
        {"id": "sushi-tb-1-d", "x": 250, "y": 490, "dir": "up", "stands": [{"x": 250, "y": 530, "dir": "up"}]},
        {"id": "sushi-tb-2-u", "x": 710, "y": 410, "dir": "down", "stands": [{"x": 710, "y": 370, "dir": "down"}]},
        {"id": "sushi-tb-2-d", "x": 710, "y": 490, "dir": "up", "stands": [{"x": 710, "y": 530, "dir": "up"}]},
    ]
}

# Furniture Shop
rooms["furniture-shop"] = {
    "label": "Huddle Home", "width": 960, "height": 720,
    "objects": [
        mkobj("furn_sofa", 300, 300),
        mkobj("furn_tv", 300, 150),
        mkobj("furn_shelf", 660, 200),
        mkobj("furn_chair", 660, 400),
    ],
    "blockers": [
        mkblock(252, 270, 96, 40),
        mkblock(276, 130, 48, 40),
        mkblock(636, 180, 48, 40),
        mkblock(636, 380, 48, 40),
    ],
    "seats": [
        {"id": "furn-s1", "x": 300, "y": 300, "dir": "down", "stands": [{"x": 300, "y": 340, "dir": "down"}]},
        {"id": "furn-c1", "x": 660, "y": 400, "dir": "down", "stands": [{"x": 660, "y": 440, "dir": "down"}]},
    ]
}

# Garden Shop
rooms["garden-shop"] = {
    "label": "Willow & Green", "width": 960, "height": 720,
    "objects": [
        mkobj("garden_tree", 200, 200), mkobj("garden_tree", 760, 200),
        mkobj("garden_shelf", 480, 200),
        mkobj("garden_flower", 432, 400), mkobj("garden_flower", 528, 400),
    ],
    "blockers": [
        mkblock(176, 170, 48, 40), mkblock(736, 170, 48, 40),
        mkblock(456, 180, 48, 40),
        mkblock(408, 380, 48, 40), mkblock(504, 380, 48, 40),
    ],
    "seats": []
}

# Decor Shop
rooms["decor-shop"] = {
    "label": "Plaza Decor", "width": 960, "height": 720,
    "objects": [
        mkobj("decor_rug", 480, 350),
        mkobj("decor_lamp", 250, 250), mkobj("decor_lamp", 710, 250),
        mkobj("decor_mirror", 480, 150),
        mkobj("decor_plant", 300, 450),
    ],
    "blockers": [
        mkblock(226, 230, 48, 40), mkblock(686, 230, 48, 40),
        mkblock(456, 130, 48, 40),
        mkblock(276, 430, 48, 40),
    ],
    "seats": []
}

manifest["rooms"] = rooms
with open("/home/runner/workspace/artifacts/jpo-huddle/public/commercial-layouts.json", "w") as f:
    json.dump(manifest, f, indent=2)

print("commercial-layouts.json and sprites extracted.")
