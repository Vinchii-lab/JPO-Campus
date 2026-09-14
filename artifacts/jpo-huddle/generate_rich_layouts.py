import json, os
from PIL import Image

SRC = "/tmp/sprites/1_Interiors/16x16/Theme_Sorter_Singles"
OUT_DIR = "/home/runner/workspace/artifacts/jpo-huddle/public/assets/neighborhood/commercial"
os.makedirs(OUT_DIR, exist_ok=True)

manifest = {"assets": {}, "rooms": {}}

asset_map = {
    "museum_desk": "22_Museum_Singles/Museum_Singles_25.png",
    "museum_rope_h": "22_Museum_Singles/Museum_Singles_27.png",
    "museum_sign": "22_Museum_Singles/Museum_Singles_12.png",
    "museum_art_1": "22_Museum_Singles/Museum_Singles_91.png",
    "museum_art_2": "22_Museum_Singles/Museum_Singles_101.png",
    "museum_art_3": "22_Museum_Singles/Museum_Singles_111.png",
    "museum_art_4": "22_Museum_Singles/Museum_Singles_121.png",
    "museum_bench": "22_Museum_Singles/Museum_Singles_141.png",
    "museum_trex_head": "22_Museum_Singles/Museum_Singles_350.png",
    "museum_trex_body": "22_Museum_Singles/Museum_Singles_351.png",
    "museum_trex_tail": "22_Museum_Singles/Museum_Singles_352.png",
    "museum_tri_head": "22_Museum_Singles/Museum_Singles_345.png",
    "museum_tri_body": "22_Museum_Singles/Museum_Singles_346.png",
    "museum_tri_tail": "22_Museum_Singles/Museum_Singles_347.png",
    "museum_sculpt_1": "22_Museum_Singles/Museum_Singles_275.png",
    "museum_sculpt_2": "22_Museum_Singles/Museum_Singles_255.png",
    "museum_sculpt_3": "22_Museum_Singles/Museum_Singles_285.png",
    "museum_vase": "22_Museum_Singles/Museum_Singles_64.png",
    "museum_pillar": "22_Museum_Singles/Museum_Singles_145.png",
    "museum_plant_disp": "22_Museum_Singles/Museum_Singles_197.png",
    "museum_bug_disp": "22_Museum_Singles/Museum_Singles_164.png",
    "museum_butterfly": "22_Museum_Singles/Museum_Singles_165.png",
    "museum_door": "22_Museum_Singles/Museum_Singles_1.png", # add doors for the top
    
    "cafe_counter": "12_Kitchen_Singles/Kitchen_Singles_134.png",
    "cafe_table": "12_Kitchen_Singles/Kitchen_Singles_314.png",
    "cafe_chair": "12_Kitchen_Singles/Kitchen_Singles_290.png",
    "cafe_machine": "12_Kitchen_Singles/Kitchen_Singles_152.png",
    "diner_booth": "12_Kitchen_Singles/Kitchen_Singles_316.png",
    "diner_counter": "12_Kitchen_Singles/Kitchen_Singles_304.png",
    "diner_stool": "12_Kitchen_Singles/Kitchen_Singles_298.png",
    "diner_grill": "12_Kitchen_Singles/Kitchen_Singles_140.png",
    "diner_jukebox": "10_Birthday_Party_Singles/Birthday_Party_Singles_3.png",
    "cafe_plant": "2_Living_Room_Singles/Living_Room_Singles_13.png",
    "cafe_shelf": "12_Kitchen_Singles/Kitchen_Singles_155.png",
    
    "bakery_disp": "24_Ice_Cream_Shop_Singles/Ice_Cream_Shop_Singles_21.png",
    "bakery_shelf": "16_Grocery_Store_Singles/Grocery_Store_Singles_121.png",
    "bakery_counter": "16_Grocery_Store_Singles/Grocery_Store_Singles_122.png",
    "bakery_bread": "16_Grocery_Store_Singles/Grocery_Store_Singles_82.png",
    
    "sushi_counter": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_61.png",
    "sushi_table": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_50.png",
    "sushi_cushion": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_42.png",
    "sushi_lantern": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_17.png",
    "sushi_bonsai": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_57.png",
    "sushi_screen": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_62.png",
    "sushi_mat": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_9.png",
    
    "furn_sofa": "2_Living_Room_Singles/Living_Room_Singles_117.png",
    "furn_chair": "2_Living_Room_Singles/Living_Room_Singles_119.png",
    "furn_bed": "4_Bedroom_Singles/Bedroom_Singles_11.png", 
    "furn_shelf": "2_Living_Room_Singles/Living_Room_Singles_92.png",
    "furn_tv": "2_Living_Room_Singles/Living_Room_Singles_66.png",
    "furn_rug": "2_Living_Room_Singles/Living_Room_Singles_4.png",
    "decor_lamp": "2_Living_Room_Singles/Living_Room_Singles_84.png",
    "decor_mirror": "2_Living_Room_Singles/Living_Room_Singles_90.png",
    "garden_tree": "16_Grocery_Store_Singles/Grocery_Store_Singles_452.png",
    "garden_plant_1": "16_Grocery_Store_Singles/Grocery_Store_Singles_461.png",
    "garden_plant_2": "16_Grocery_Store_Singles/Grocery_Store_Singles_462.png",
    "garden_flower": "16_Grocery_Store_Singles/Grocery_Store_Singles_421.png",
    "garden_shelf": "16_Grocery_Store_Singles/Grocery_Store_Singles_356.png",

    "floor_wood": "16_Grocery_Store_Singles/Grocery_Store_Singles_182.png",
    "floor_tile": "12_Kitchen_Singles/Kitchen_Singles_221.png",
    "floor_museum": "22_Museum_Singles/Museum_Singles_241.png",
    "floor_tatami": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_3.png",
    
    "wall_brick": "12_Kitchen_Singles/Kitchen_Singles_202.png",
    "wall_museum": "22_Museum_Singles/Museum_Singles_201.png",
    "wall_wood": "2_Living_Room_Singles/Living_Room_Singles_201.png",
    "wall_paper": "4_Bedroom_Singles/Bedroom_Singles_201.png",
    "wall_japanese": "20_Japanese_Interiors_Singles/Japanese_Interiors_Singles_104.png",
}

for k, v in asset_map.items():
    src = os.path.join(SRC, v)
    dst = os.path.join(OUT_DIR, k + ".png")
    if os.path.exists(src):
        im = Image.open(src)
        im_resized = im.resize((im.width * 3, im.height * 3), Image.NEAREST)
        im_resized.save(dst)
        manifest["assets"][k] = "assets/neighborhood/commercial/" + k + ".png"

class RoomBuilder:
    def __init__(self, id, label):
        self.id = id
        self.label = label
        self.objects = []
        self.blockers = []
        self.seats = []

    def obj(self, asset, x, y, depth=None, scale=1):
        d = y if depth is None else depth
        self.objects.append({"asset": asset, "x": x, "y": y, "depth": d, "scale": scale})

    def blk(self, x, y, w, h):
        self.blockers.append({"x": x, "y": y, "width": w, "height": h})
        
    def seat(self, id, x, y, dir, sx, sy):
        self.seats.append({
            "id": id, "x": x, "y": y, "dir": dir, 
            "stands": [{"x": sx, "y": sy, "dir": dir}]
        })

    def fill_floor(self, asset):
        for x in range(24, 960, 48):
            for y in range(24, 720, 48):
                self.obj(asset, x, y, depth=-10)

    def draw_walls(self, asset):
        for x in range(24, 960, 48):
            self.obj(asset, x, 48, depth=-5)
            
    def compile(self):
        return {
            "label": self.label,
            "width": 960,
            "height": 720,
            "objects": self.objects,
            "blockers": self.blockers,
            "seats": self.seats
        }

rooms = {}

# ---------------------------------------------------------
# MUSEUM FOYER
# ---------------------------------------------------------
m = RoomBuilder("museum", "Museum Foyer")
m.fill_floor("floor_museum")
m.draw_walls("wall_museum")

# Doors at top: x=192, 384, 576, 768. We place an arch/door object there.
for x in [192, 384, 576, 768]:
    m.obj("museum_door", x, 48, depth=-4)

# We need to leave x=192, 384, 576, 768 free at y=96 for returning players.
# We need to leave x=480 free from y=576 up to those doors.

# Let's put reception desks on the sides, instead of the center!
# Left desk
m.obj("museum_desk", 150, 400)
m.obj("museum_desk", 150+48, 400)
m.blk(150-24, 400-24, 96, 40)
m.obj("museum_sign", 150+24, 400-48, depth=399)

# Right desk
m.obj("museum_desk", 760, 400)
m.obj("museum_desk", 760+48, 400)
m.blk(760-24, 400-24, 96, 40)
m.obj("museum_sign", 760+24, 400-48, depth=399)

# Foyer decor in the corners and between doors (avoiding x=192, 384, 576, 768)
# Safe x spots at top: 96, 288, 480, 672, 864
for x in [96, 288, 480, 672, 864]:
    m.obj("museum_plant_disp", x, 180)
    m.blk(x-24, 180-24, 48, 48)

for x in [96, 864]:
    m.obj("museum_sculpt_1", x, 600)
    m.blk(x-24, 600-24, 48, 48)

rooms["museum"] = m.compile()

# ---------------------------------------------------------
# MUSEUM GALLERY 1: Art
# ---------------------------------------------------------
g1 = RoomBuilder("museum-room-1", "Art Gallery 1")
g1.fill_floor("floor_wood")
g1.draw_walls("wall_museum")
g1.obj("museum_door", 480, 720, depth=1000) # exit

# Avoid x=480 y=576 (spawn)
for i, x in enumerate(range(150, 850, 150)):
    art = f"museum_art_{1 + (i % 4)}"
    g1.obj(art, x, 48, depth=-4)

g1.obj("museum_bench", 250, 400)
g1.blk(250-48, 400-24, 96, 40)
g1.seat("bench1-1", 220, 400, "down", 220, 440)
g1.seat("bench1-2", 280, 400, "down", 280, 440)

g1.obj("museum_bench", 710, 400)
g1.blk(710-48, 400-24, 96, 40)
g1.seat("bench1-3", 680, 400, "down", 680, 440)

g1.obj("museum_sculpt_2", 200, 200)
g1.blk(200-24, 200-24, 48, 48)
g1.obj("museum_sculpt_3", 760, 200)
g1.blk(760-24, 200-24, 48, 48)

rooms["museum-room-1"] = g1.compile()

# ---------------------------------------------------------
# MUSEUM GALLERY 2: Fossils
# ---------------------------------------------------------
g2 = RoomBuilder("museum-room-2", "Fossil Gallery 2")
g2.fill_floor("floor_museum")
g2.draw_walls("wall_museum")
g2.obj("museum_door", 480, 720, depth=1000)

g2.obj("museum_trex_head", 250, 250)
g2.obj("museum_trex_body", 298, 250)
g2.obj("museum_trex_tail", 346, 250)
g2.blk(250-24, 250-24, 144, 48)

g2.obj("museum_tri_head", 600, 350)
g2.obj("museum_tri_body", 648, 350)
g2.obj("museum_tri_tail", 696, 350)
g2.blk(600-24, 350-24, 144, 48)

rooms["museum-room-2"] = g2.compile()

# ---------------------------------------------------------
# MUSEUM GALLERY 3: Antiquities
# ---------------------------------------------------------
g3 = RoomBuilder("museum-room-3", "Antiquities 3")
g3.fill_floor("floor_museum")
g3.draw_walls("wall_museum")
g3.obj("museum_door", 480, 720, depth=1000)

for x in [250, 710]:
    g3.obj("museum_pillar", x, 300)
    g3.blk(x-24, 300-24, 48, 48)
    g3.obj("museum_vase", x, 250)

g3.obj("museum_pillar", 480, 200)
g3.blk(480-24, 200-24, 48, 48)
g3.obj("museum_sculpt_1", 480, 150)

rooms["museum-room-3"] = g3.compile()

# ---------------------------------------------------------
# MUSEUM GALLERY 4: Nature
# ---------------------------------------------------------
g4 = RoomBuilder("museum-room-4", "Nature Gallery 4")
g4.fill_floor("floor_wood")
g4.draw_walls("wall_museum")
g4.obj("museum_door", 480, 720, depth=1000)

g4.obj("museum_plant_disp", 200, 200)
g4.blk(200-24, 200-24, 48, 48)
g4.obj("museum_plant_disp", 760, 200)
g4.blk(760-24, 200-24, 48, 48)

g4.obj("museum_bug_disp", 200, 400)
g4.blk(200-24, 400-24, 48, 48)
g4.obj("museum_bug_disp", 760, 400)
g4.blk(760-24, 400-24, 48, 48)

g4.obj("museum_butterfly", 480, 48, depth=-4)

rooms["museum-room-4"] = g4.compile()

# ---------------------------------------------------------
# CAFE
# ---------------------------------------------------------
cafe = RoomBuilder("cafe", "Cafe")
cafe.fill_floor("floor_wood")
cafe.draw_walls("wall_brick")

# Bar on the left side
for y in range(150, 450, 48):
    cafe.obj("cafe_counter", 150, y)
    cafe.blk(150-24, y-24, 48, 40)
cafe.obj("cafe_machine", 150, 250)
cafe.obj("cafe_shelf", 100, 150, depth=149)

# Tables on the right
for bx, by in [(350, 200), (550, 200), (750, 200), (350, 400), (550, 400), (750, 400)]:
    cafe.obj("cafe_table", bx, by)
    cafe.blk(bx-20, by-20, 40, 40)
    cafe.obj("cafe_chair", bx, by-40)
    cafe.seat(f"c-u-{bx}-{by}", bx, by-40, "down", bx, by-80)
    cafe.obj("cafe_chair", bx, by+40)
    cafe.seat(f"c-d-{bx}-{by}", bx, by+40, "up", bx, by+80)

rooms["cafe"] = cafe.compile()

# ---------------------------------------------------------
# DINER
# ---------------------------------------------------------
diner = RoomBuilder("diner", "Neon Diner")
diner.fill_floor("floor_tile")
diner.draw_walls("wall_brick")

# Long counter at the top
for x in range(150, 850, 48):
    diner.obj("diner_counter", x, 250)
    diner.blk(x-24, 250-24, 48, 40)
    if x % 96 == 0:
        diner.obj("diner_stool", x, 290)
        diner.seat(f"d-s-{x}", x, 290, "up", x, 330)

diner.obj("diner_grill", 300, 150)
diner.blk(300-24, 150-24, 48, 40)
diner.obj("diner_grill", 600, 150)
diner.blk(600-24, 150-24, 48, 40)
diner.obj("diner_jukebox", 850, 150)
diner.blk(850-24, 150-24, 48, 48)

for y in [450]:
    for x in [200, 450, 700]:
        diner.obj("diner_booth", x, y)
        diner.blk(x-48, y-30, 96, 60)
        diner.seat(f"b-l-{x}", x-24, y, "right", x-60, y)
        diner.seat(f"b-r-{x}", x+24, y, "left", x+60, y)

rooms["diner"] = diner.compile()

# ---------------------------------------------------------
# BAKERY
# ---------------------------------------------------------
bak = RoomBuilder("bakery", "Bakery")
bak.fill_floor("floor_wood")
bak.draw_walls("wall_brick")

# Showcase counter at the top
for x in range(250, 750, 48):
    if x in [350, 600]:
        bak.obj("bakery_disp", x, 200)
    else:
        bak.obj("bakery_counter", x, 200)
    bak.blk(x-24, 200-24, 48, 40)

for x in [150, 810]:
    bak.obj("bakery_bread", x, 200)
    bak.blk(x-24, 200-24, 48, 48)

for bx, by in [(300, 400), (660, 400)]:
    bak.obj("bakery_table", bx, by)
    bak.blk(bx-20, by-20, 40, 40)
    bak.obj("bakery_chair", bx, by-40)
    bak.seat(f"b-t-u-{bx}", bx, by-40, "down", bx, by-80)
    bak.obj("bakery_chair", bx, by+40)
    bak.seat(f"b-t-d-{bx}", bx, by+40, "up", bx, by+80)

rooms["bakery"] = bak.compile()

# ---------------------------------------------------------
# SUSHI
# ---------------------------------------------------------
sushi = RoomBuilder("sushi", "Sakura Sushi")
sushi.fill_floor("floor_tatami")
sushi.draw_walls("wall_japanese")

for x in range(250, 750, 48):
    sushi.obj("sushi_counter", x, 200)
    sushi.blk(x-24, 200-24, 48, 40)
    if x % 96 == 0:
        sushi.obj("sushi_cushion", x, 240)
        sushi.seat(f"s-c-{x}", x, 240, "up", x, 280)

sushi.obj("sushi_lantern", 150, 150)
sushi.obj("sushi_lantern", 810, 150)
sushi.obj("sushi_bonsai", 480, 170)

for bx, by in [(300, 400), (660, 400)]:
    sushi.obj("sushi_table", bx, by)
    sushi.blk(bx-20, by-20, 40, 40)
    sushi.obj("sushi_cushion", bx, by-40)
    sushi.seat(f"s-t-u-{bx}", bx, by-40, "down", bx, by-80)
    sushi.obj("sushi_cushion", bx, by+40)
    sushi.seat(f"s-t-d-{bx}", bx, by+40, "up", bx, by+80)
    
sushi.obj("sushi_screen", 150, 450)
sushi.blk(150-24, 450-10, 48, 20)

rooms["sushi"] = sushi.compile()

# ---------------------------------------------------------
# FURNITURE SHOP
# ---------------------------------------------------------
fs = RoomBuilder("furniture-shop", "Furniture Shop")
fs.fill_floor("floor_wood")
fs.draw_walls("wall_wood")

# Living Room
fs.obj("furn_rug", 250, 250, depth=1)
fs.obj("furn_sofa", 250, 250)
fs.blk(250-48, 250-24, 96, 40)
fs.seat("f-sofa", 250, 250, "down", 250, 290)
fs.obj("furn_tv", 250, 150)
fs.blk(250-24, 150-24, 48, 40)

# Bedroom
fs.obj("furn_bed", 700, 250)
fs.blk(700-24, 250-48, 48, 96)
fs.seat("f-bed", 700, 250, "left", 660, 250)

# Displays
fs.obj("furn_shelf", 150, 150)
fs.blk(150-24, 150-24, 48, 40)
fs.obj("furn_shelf", 810, 150)
fs.blk(810-24, 150-24, 48, 40)

# Extra seating
fs.obj("furn_chair", 250, 450)
fs.blk(250-24, 450-24, 48, 40)
fs.seat("f-chair-1", 250, 450, "down", 250, 490)

fs.obj("furn_chair", 700, 450)
fs.blk(700-24, 450-24, 48, 40)
fs.seat("f-chair-2", 700, 450, "down", 700, 490)

rooms["furniture-shop"] = fs.compile()

# ---------------------------------------------------------
# GARDEN SHOP
# ---------------------------------------------------------
gs = RoomBuilder("garden-shop", "Garden Shop")
gs.fill_floor("floor_wood")
gs.draw_walls("wall_wood")

for x in range(150, 850, 150):
    gs.obj("garden_shelf", x, 150)
    gs.blk(x-24, 150-24, 48, 40)

for y in [300, 450]:
    for x in [250, 450, 700]:
        plant = "garden_tree" if (x+y)%3==0 else "garden_plant_1" if (x+y)%2==0 else "garden_plant_2"
        gs.obj(plant, x, y)
        gs.blk(x-24, y-24, 48, 48)

rooms["garden-shop"] = gs.compile()

# ---------------------------------------------------------
# DECOR SHOP
# ---------------------------------------------------------
ds = RoomBuilder("decor-shop", "Decor Shop")
ds.fill_floor("floor_wood")
ds.draw_walls("wall_wood")

for x in [250, 700]:
    ds.obj("decor_rug", x, 250, depth=1)
    ds.obj("furn_sofa", x, 250)
    ds.blk(x-48, 250-24, 96, 40)
    ds.seat(f"d-s-{x}", x, 250, "down", x, 290)
    ds.obj("decor_lamp", x-60, 250)
    ds.blk(x-60-12, 250-24, 24, 48)

for x in range(150, 850, 144):
    ds.obj("decor_mirror", x, 150)
    ds.blk(x-24, 150-24, 48, 40)
    
ds.obj("museum_plant_disp", 480, 450)
ds.blk(480-24, 450-24, 48, 48)

rooms["decor-shop"] = ds.compile()

manifest["rooms"] = rooms
with open("/home/runner/workspace/artifacts/jpo-huddle/public/commercial-layouts.json", "w") as f:
    json.dump(manifest, f, indent=2)

print("commercial-layouts.json generated with refined non-blocking layouts.")
