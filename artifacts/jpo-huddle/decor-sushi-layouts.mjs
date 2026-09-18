const ASSET_ROOT = "assets/neighborhood/commercial";

const assets = {
  "ds-fixed-decor-bookshelf": `${ASSET_ROOT}/ds-fixed-decor-bookshelf.png`,
  "ds-fixed-decor-sofa": `${ASSET_ROOT}/ds-fixed-decor-sofa.png`,
  "ds-fixed-decor-lamp": `${ASSET_ROOT}/ds-fixed-decor-lamp.png`,
  "ds-fixed-decor-mirror": `${ASSET_ROOT}/ds-fixed-decor-mirror.png`,
  "ds-fixed-decor-plant": `${ASSET_ROOT}/ds-fixed-decor-plant.png`,
  "ds-fixed-sushi-counter-table": `${ASSET_ROOT}/ds-fixed-sushi-counter-table.png`,
  "ds-fixed-sushi-low-table": `${ASSET_ROOT}/ds-fixed-sushi-low-table.png`,
  "ds-fixed-sushi-single-cushion": `${ASSET_ROOT}/ds-fixed-sushi-single-cushion.png`,
  "ds-fixed-sushi-plant": `${ASSET_ROOT}/ds-fixed-sushi-plant.png`,
};

const object = (asset, x, y, depth) => ({ asset, x, y, depth, scale: 3 });
const blocker = (x, y, width, height) => ({ x, y, width, height });

function seat(id, x, padY, chairFloorY, dir, standX, standFootY, standDir) {
  return {
    id: `ds-fixed-seat-${id}`,
    x,
    y: padY - 27,
    depthAnchor: chairFloorY,
    dir,
    stands: [{ x: standX, y: standFootY - 27, dir: standDir }],
  };
}

export function applyDecorSushiLayouts(manifest) {
  Object.assign(manifest.assets, assets);

  const decorObjects = [
    object("ds-fixed-decor-bookshelf", 160, 160, 232),
    object("ds-fixed-decor-bookshelf", 280, 160, 232),
    object("ds-fixed-decor-bookshelf", 400, 160, 232),
    object("ds-fixed-decor-sofa", 290, 400, 448),
    object("ds-fixed-decor-lamp", 150, 360, 432),
    object("ds-fixed-decor-mirror", 525, 315, 339),
    object("ds-fixed-decor-plant", 735, 380, 428),
  ];
  const decorBlockers = [
    blocker(114, 188, 92, 44),
    blocker(234, 188, 92, 44),
    blocker(354, 188, 92, 44),
    // A usable seat must not collide with its own sofa footprint.
    blocker(130, 398, 40, 34),
    blocker(503, 303, 44, 36),
    blocker(687, 350, 96, 78),
  ];
  const decorSeats = [
    seat("decor-sofa", 290, 420, 448, "down", 290, 500, "up"),
  ];

  manifest.rooms["decor-shop"] = {
    label: "Plaza Decor",
    width: 960,
    height: 720,
    objects: decorObjects,
    blockers: decorBlockers,
    seats: decorSeats,
  };

  const sushiObjects = [];
  const sushiBlockers = [];
  const sushiSeats = [];

  // Three complete wooden tables form a continuous service counter.
  [312, 408, 504].forEach((x, index) => {
    sushiObjects.push(object("ds-fixed-sushi-counter-table", x, 210, 258));
    sushiObjects.push(object("ds-fixed-sushi-single-cushion", x, 305, 329));
    sushiSeats.push(
      seat(`sushi-counter-${index}`, x, 319, 329, "up", x, 375, "up"),
    );
  });
  sushiBlockers.push(blocker(264, 174, 288, 84));

  [
    [260, 455],
    [700, 455],
  ].forEach(([tableX, tableY], tableIndex) => {
    sushiObjects.push(
      object("ds-fixed-sushi-low-table", tableX, tableY, tableY + 48),
      object("ds-fixed-sushi-single-cushion", tableX - 78, tableY, tableY + 24),
      object("ds-fixed-sushi-single-cushion", tableX + 78, tableY, tableY + 24),
    );
    sushiBlockers.push(blocker(tableX - 46, tableY - 38, 92, 76));
    sushiSeats.push(
      seat(
        `sushi-table-${tableIndex}-left`,
        tableX - 78,
        tableY + 15,
        tableY + 24,
        "right",
        tableX - 156,
        tableY + 18,
        "right",
      ),
      seat(
        `sushi-table-${tableIndex}-right`,
        tableX + 78,
        tableY + 15,
        tableY + 24,
        "left",
        tableX + 156,
        tableY + 18,
        "left",
      ),
    );
  });

  sushiObjects.push(
    object("ds-fixed-sushi-plant", 780, 185, 233),
    object("ds-fixed-sushi-plant", 165, 185, 233),
  );
  sushiBlockers.push(
    blocker(758, 196, 44, 37),
    blocker(143, 196, 44, 37),
  );

  manifest.rooms.sushi = {
    label: "Sushi",
    width: 960,
    height: 720,
    objects: sushiObjects,
    blockers: sushiBlockers,
    seats: sushiSeats,
  };
}