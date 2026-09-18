const ASSET_ROOT = "assets/neighborhood/commercial/";

const foodAssets = {
  food_fixed_diner_counter: `${ASSET_ROOT}food-fixed-diner-counter.png`,
  food_fixed_diner_food_display: `${ASSET_ROOT}food-fixed-diner-food-display.png`,
  food_fixed_diner_table: `${ASSET_ROOT}food-fixed-diner-table.png`,
  food_fixed_diner_chair: `${ASSET_ROOT}food-fixed-diner-chair.png`,
  food_fixed_bakery_bread_rack: `${ASSET_ROOT}food-fixed-bakery-bread-rack.png`,
  food_fixed_bakery_pastry_case: `${ASSET_ROOT}food-fixed-bakery-pastry-case.png`,
  food_fixed_bakery_cake: `${ASSET_ROOT}food-fixed-bakery-cake.png`,
  food_fixed_bakery_table: `${ASSET_ROOT}food-fixed-bakery-table.png`,
  food_fixed_bakery_chair: `${ASSET_ROOT}food-fixed-bakery-chair.png`,
};

const object = (asset, x, y, depth = y) => ({ asset, x, y, depth, scale: 3 });
const blocker = (x, y, width, height) => ({ x, y, width, height });

function seat(id, asset, x, chairFloorY, padY, dir, standX, standY) {
  return {
    object: object(asset, x, chairFloorY, chairFloorY),
    pad: {
      id,
      x,
      y: padY - 27,
      dir,
      depthAnchor: chairFloorY,
      stands: [{ x: standX, y: standY, dir }],
    },
  };
}

export function applyFoodVenueLayouts(manifest) {
  Object.assign(manifest.assets, foodAssets);

  const dinerSeats = [
    seat("food-fixed:diner:table-west", "food_fixed_diner_chair", 270, 492, 465, "up", 270, 540),
    seat("food-fixed:diner:table-east", "food_fixed_diner_chair", 690, 492, 465, "up", 690, 540),
  ];
  manifest.rooms.diner = {
    label: "Diner",
    width: 960,
    height: 720,
    objects: [
      object("food_fixed_diner_counter", 250, 180),
      object("food_fixed_diner_counter", 346, 180),
      object("food_fixed_diner_counter", 442, 180),
      object("food_fixed_diner_food_display", 565, 180),
      // Move the tables north, preserving the chairs' real cushion anchors.
      object("food_fixed_diner_table", 270, 388),
      object("food_fixed_diner_table", 690, 388),
      ...dinerSeats.map(({ object: chair }) => chair),
    ],
    blockers: [
      blocker(202, 158, 288, 52),
      blocker(541, 156, 48, 54),
      blocker(235, 366, 70, 46),
      blocker(655, 366, 70, 46),
    ],
    seats: dinerSeats.map(({ pad }) => pad),
  };

  const bakerySeats = [
    seat("food-fixed:bakery:table-west", "food_fixed_bakery_chair", 270, 492, 465, "up", 270, 548),
    seat("food-fixed:bakery:table-east", "food_fixed_bakery_chair", 690, 492, 465, "up", 690, 548),
  ];
  manifest.rooms.bakery = {
    label: "Bakery",
    width: 960,
    height: 720,
    objects: [
      object("food_fixed_bakery_bread_rack", 160, 190),
      object("food_fixed_bakery_bread_rack", 224, 190),
      object("food_fixed_bakery_pastry_case", 370, 190),
      object("food_fixed_bakery_pastry_case", 466, 190),
      object("food_fixed_bakery_cake", 750, 190),
      object("food_fixed_bakery_table", 270, 388),
      object("food_fixed_bakery_table", 690, 388),
      ...bakerySeats.map(({ object: chair }) => chair),
    ],
    blockers: [
      blocker(136, 166, 112, 48),
      blocker(322, 166, 192, 48),
      blocker(716, 166, 68, 48),
      blocker(235, 366, 70, 46),
      blocker(655, 366, 70, 46),
    ],
    seats: bakerySeats.map(({ pad }) => pad),
  };
}