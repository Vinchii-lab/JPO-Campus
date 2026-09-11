// Authoritative neighborhood definitions.  These maps are intentionally
// compact, deterministic, and editable source data rather than flattened
// screenshots or a client-provided tilemap.
// A home cell is one supplied 16px art tile at the shared 3x presentation
// scale. Keep the authoritative room at least as large as the uploaded room
// builder samples: 24x18 cells = 1152x864px. Existing 12x9 furniture
// coordinates remain valid coordinates inside this larger floor.
export const HOME_GRID = { width: 24, height: 18, cell: 48 };
// The starter house is a real multi-room floor rather than one compact room.
// Room boundaries stay on whole 16px-art cells so the same geometry drives the
// server collider, browser collider, labels, and placement validation.
export const HOME_ROOM_GEOMETRY = Object.freeze({
  rooms: Object.freeze([
    Object.freeze({ id: "living-kitchen", label: "Living & kitchen", x: 11, y: 1, width: 12, height: 16 }),
    Object.freeze({ id: "bedroom", label: "Bedroom", x: 1, y: 1, width: 9, height: 8 }),
    Object.freeze({ id: "bath", label: "Bath", x: 1, y: 10, width: 9, height: 7 }),
  ]),
  // Doorways are the intentionally omitted cells in the solid interior
  // dividers. Two-cell openings are 96px on their travel axis, leaving ample
  // clearance for the authoritative 16px actor foot radius.
  doorways: Object.freeze([
    Object.freeze({ id: "living-bedroom-door", x: 10, y: 4, width: 1, height: 2 }),
    Object.freeze({ id: "living-bath-door", x: 10, y: 12, width: 1, height: 2 }),
    Object.freeze({ id: "bedroom-bath-hall", x: 4, y: 9, width: 2, height: 1 }),
  ]),
  walls: Object.freeze([
    // A vertical divider separates the large private wing from
    // living/kitchen, with generous bedroom and bath door openings.
    Object.freeze({ id: "living-private-divider", x: 10, y: 1, width: 1, height: 3 }),
    Object.freeze({ id: "living-private-divider", x: 10, y: 6, width: 1, height: 6 }),
    Object.freeze({ id: "living-private-divider", x: 10, y: 14, width: 1, height: 3 }),
    // A horizontal divider separates the bedroom and bath. The two-cell hall
    // is centered in the private wing and remains continuously traversable.
    Object.freeze({ id: "bedroom-bath-divider", x: 1, y: 9, width: 3, height: 1 }),
    Object.freeze({ id: "bedroom-bath-divider", x: 6, y: 9, width: 4, height: 1 }),
  ]),
});

// Presentation and collision both consume this derived list.  Keeping the
// coordinate conversion here avoids a client-only wall that the server would
// let players walk through (or a server-only wall that strands them).
export const HOME_INTERIOR_WALL_BLOCKERS = Object.freeze(
  HOME_ROOM_GEOMETRY.walls.map((wall) => ({
    x: wall.x * HOME_GRID.cell,
    y: wall.y * HOME_GRID.cell,
    width: wall.width * HOME_GRID.cell,
    height: wall.height * HOME_GRID.cell,
    roomWall: true,
  })),
);
// Homes contain architecture only. All furnishings must be bought and placed
// by players; empty fixture lists also release formerly reserved floor cells.
export const HOME_BUILTIN_FIXTURES = Object.freeze([]);
export const HOME_BUILTIN_FIXTURE_BLOCKERS = Object.freeze(
  HOME_BUILTIN_FIXTURES.map((fixture) => ({
    x: fixture.gridX * HOME_GRID.cell, y: fixture.gridY * HOME_GRID.cell,
    width: fixture.width * HOME_GRID.cell, height: fixture.height * HOME_GRID.cell,
    fixtureId: fixture.id, builtInFixture: true,
  })),
);
// The yard uses the same native 16px / 3x presentation cell as the room.  It
// is deliberately a small, fenced part of a residence lot, not a second map.
export const YARD_GRID = { width: 4, height: 3, cell: 48 };
// Exterior colors are identifiers rather than browser-provided hex values.
// They are persisted and projected to public home listings, so this small
// allowlist is the single safe contract for both the server and house art.
export const HOME_EXTERIOR_COLORS = Object.freeze({
  teal: { id: "teal", label: "Teal", hex: "#237c86" },
  terracotta: { id: "terracotta", label: "Terracotta", hex: "#b65b45" },
  plum: { id: "plum", label: "Plum", hex: "#76506f" },
  navy: { id: "navy", label: "Navy", hex: "#2f4f78" },
  sage: { id: "sage", label: "Sage", hex: "#70885f" },
});
export const DEFAULT_HOME_EXTERIOR_COLOR = "teal";

export function homeExteriorColor(value) {
  return typeof value === "string" && HOME_EXTERIOR_COLORS[value]
    ? value
    : DEFAULT_HOME_EXTERIOR_COLOR;
}

// Server-owned component definitions. Clients may render these values, but
// purchase requests carry only the component id and are always priced here.
export const HOME_CONSTRUCTION_COMPONENTS = Object.freeze({
  floor: { id: "floor", label: "Floor & foundation", price: 20000 },
  walls: { id: "walls", label: "Walls", price: 25000 },
  roof: { id: "roof", label: "Roof", price: 35000 },
});

export function homeConstructionStage(home = {}) {
  if (home.roof_built || home.roofBuilt) return "complete";
  if (home.walls_built || home.wallsBuilt) return "walls";
  if (home.floor_built || home.floorBuilt) return "floor";
  return "empty";
}

export function homeConstruction(home = {}) {
  const stage = homeConstructionStage(home);
  return {
    stage,
    complete: stage === "complete",
    floorBuilt: stage !== "empty",
    wallsBuilt: stage === "walls" || stage === "complete",
    roofBuilt: stage === "complete",
    components: Object.values(HOME_CONSTRUCTION_COMPONENTS),
  };
}
// Player positions are foot-centre coordinates. Both movement validation and
// the client Arcade collider use this radius, rather than separate magic
// margins that drift at facades and door thresholds.
export const ACTOR_FOOT_RADIUS = 16;
// Browser/e2e Huddle A/B accounts are deliberately session-only for the
// neighborhood world.  Keep this narrow: real coworkers whose names happen
// to contain "Huddle" remain normal residents.  The generated suffix is part
// of the test-account naming convention (for example huddle-a-qwc0xff@...).
export const HUDDLE_TEST_EMAIL_PATTERN = /^huddle-[ab](?:-[a-z0-9]+)?@justpressone\.com$/;

export function isHuddleTestIdentity(value) {
  return HUDDLE_TEST_EMAIL_PATTERN.test(String(value || "").trim().toLowerCase());
}

// Willow Walk is the one shared residential world.  A lot is derived from its
// stable approved-account order, never from a paginated directory slot.
export const RESIDENTIAL_BLOCK_IDS = Object.freeze(["neighborhood"]);
export const LOCATIONS = Object.freeze({
  office: { id: "office", label: "JPO HQ", spawn: { x: 1272, y: 2253, dir: "down" }, bounds: null },
  neighborhood: { id: "neighborhood", label: "Willow Walk", spawn: { x: 144, y: 504, dir: "right" }, bounds: { width: 1440, height: 1056 } },
  city: { id: "city", label: "Huddle Plaza", spawn: { x: 144, y: 480, dir: "right" }, bounds: { width: 1152, height: 1600 } },
  cafe: { id: "cafe", label: "Cafe", spawn: { x: 480, y: 576, dir: "up" }, bounds: { width: 960, height: 720 } },
  diner: { id: "diner", label: "Diner", spawn: { x: 480, y: 576, dir: "up" }, bounds: { width: 960, height: 720 } },
  bakery: { id: "bakery", label: "Bakery", spawn: { x: 480, y: 576, dir: "up" }, bounds: { width: 960, height: 720 } },
  sushi: { id: "sushi", label: "Sushi", spawn: { x: 480, y: 576, dir: "up" }, bounds: { width: 960, height: 720 } },
  "furniture-shop": { id: "furniture-shop", label: "Huddle Home", spawn: { x: 480, y: 576, dir: "up" }, bounds: { width: 960, height: 720 } },
  "garden-shop": { id: "garden-shop", label: "Willow & Green", spawn: { x: 480, y: 576, dir: "up" }, bounds: { width: 960, height: 720 } },
  "decor-shop": { id: "decor-shop", label: "Plaza Decor", spawn: { x: 480, y: 576, dir: "up" }, bounds: { width: 960, height: 720 } },
});

// The three storefronts share the same durable furniture inventory and coin
// transaction. A themed shop only changes which existing catalog rows it
// exposes; it never creates a second pricing or furniture schema.
export const SHOP_DEFINITIONS = Object.freeze({
  "furniture-shop": Object.freeze({
    id: "furniture-shop", title: "Huddle Home", subtitle: "Furnishings",
    catalogIds: Object.freeze(["oak_chair", "fern", "reading_lamp", "coffee_table", "blue_sofa", "bookcase"]),
  }),
  "garden-shop": Object.freeze({
    id: "garden-shop", title: "Willow & Green", subtitle: "Garden goods",
    catalogIds: Object.freeze(["fern", "oak_chair", "reading_lamp"]),
  }),
  "decor-shop": Object.freeze({
    id: "decor-shop", title: "Plaza Decor", subtitle: "Living-room accents",
    catalogIds: Object.freeze(["coffee_table", "blue_sofa", "bookcase", "oak_chair", "reading_lamp"]),
  }),
});

export function isShopLocation(value) {
  return typeof value === "string" && !!SHOP_DEFINITIONS[value];
}

export function shopCatalog(location) {
  const id = typeof location === "string" ? location : location?.id;
  const definition = SHOP_DEFINITIONS[id];
  if (!definition) return {};
  return Object.fromEntries(definition.catalogIds
    .map((furnitureId) => [furnitureId, FURNITURE_CATALOG[furnitureId]])
    .filter(([, item]) => item));
}
const STREET_LOT_OFFSETS = Object.freeze([
  [180, 340], [420, 340], [732, 340], [972, 340],
  [180, 812], [420, 812], [732, 812], [972, 812],
]);
// The supplied house sprite's facade is 224px wide with a 72px centered
// doorway.  Keep this one source for every residential street: the visible
// footprint, server blocker, and walkable front path agree exactly.
const residenceBlockers = (lots = STREET_LOT_OFFSETS) => lots.flatMap(([centerX, bottomY]) => [
  { x: centerX - 112, y: bottomY - 234, width: 224, height: 145 },
  { x: centerX - 112, y: bottomY - 89, width: 76, height: 90 },
  { x: centerX + 36, y: bottomY - 89, width: 76, height: 90 },
]);
// A segment is a real stretch of the continuous street: four homes face the
// north pavement and four face the south pavement.  Extending the segment
// below keeps every account on one physical map while retaining the normal
// close camera inside a residence.  `ownerEmail` is the canonical address.
export function streetDefinition(entries = []) {
  // Retained Huddle A/B rows (including their possessions) are intentionally
  // not neighborhood residents.  Filtering here is the final presentation
  // guard in addition to homeDirectory's SQL filter, so stale snapshots can
  // never paint or address their old lots.
  const homes = Array.isArray(entries)
    ? entries.filter((home) => !isHuddleTestIdentity(home?.ownerEmail))
    : [];
  const slotFor = (home, index) => Number.isInteger(home?.lotIndex) && home.lotIndex > 0 ? home.lotIndex : index + 1;
  const segmentCount = Math.max(1, Math.ceil(Math.max(0, ...homes.map(slotFor)) / STREET_LOT_OFFSETS.length));
  const lots = homes.map((home, index) => {
    const slot = slotFor(home, index);
    const [x, localBottom] = STREET_LOT_OFFSETS[(slot - 1) % STREET_LOT_OFFSETS.length];
    const segment = Math.floor((slot - 1) / STREET_LOT_OFFSETS.length);
    const bottom = localBottom + segment * 960;
    const northSide = localBottom < 500;
    const door = {
      destination: "home", residence: true, lot: slot, ownerEmail: home.ownerEmail,
      x: x - 36, y: bottom - 90, width: 72, height: 100,
      label: `${home.name || home.ownerEmail}'s home`,
    };
    return {
      ...home, construction: home.construction || homeConstruction(home), lot: slot, x, bottom, northSide, door,
      // North facades end at `bottom`; south facades begin at
      // `bottom - 234`. Keep the return point on the street-facing side of
      // either facade, with a 32px foot-centre margin, never inside the
      // residence blocker itself.
      returnSpawn: { x, y: northSide ? bottom + 32 : bottom - 266, dir: northSide ? "down" : "up" },
      yard: Array.isArray(home.yard) ? home.yard : [],
    };
  });
  // A foundation is an outdoor lot and walls provide the first solid
  // obstruction. A completed roof is separately required before the doorway
  // exists, so nobody can transition into an unfinished saved interior.
  const blockers = residenceBlockers(lots.filter((lot) => lot.construction?.wallsBuilt)
    .map((lot) => [lot.x, lot.bottom]));
  const yardBlockers = lots.flatMap((lot) => (lot.yard || []).flatMap((placed) => {
    const item = FURNITURE_CATALOG[placed.furnitureId];
    if (!item) return [];
    const footprint = furnitureFootprint(item, placed.rotation);
    const originX = lot.x - 96;
    const originY = lot.northSide ? lot.bottom - 330 : lot.bottom - 66;
    return [{
      x: originX + placed.gridX * YARD_GRID.cell,
      y: originY + placed.gridY * YARD_GRID.cell,
      width: footprint.width * YARD_GRID.cell,
      height: footprint.height * YARD_GRID.cell,
      furnitureId: placed.furnitureId,
    }];
  }));
  const doors = lots.filter((lot) => lot.construction?.complete).map((lot) => lot.door);
  const height = segmentCount * 960 + 96;
  return { bounds: { width: 1440, height }, blockers: [...blockers, ...yardBlockers], doors, lots };
}

export function streetLotForOwner(entries, ownerEmail) {
  const email = String(ownerEmail || "").trim().toLowerCase();
  if (isHuddleTestIdentity(email)) return null;
  return streetDefinition(entries).lots.find((lot) =>
    String(lot.ownerEmail || "").trim().toLowerCase() === email) || null;
}

export function streetReturnSpawnForOwner(entries, ownerEmail) {
  const lot = streetLotForOwner(entries, ownerEmail);
  return lot?.returnSpawn ? { ...lot.returnSpawn } : null;
}

export function streetPortalForTransition(destination, x, y, entries) {
  const target = parseLocation(destination);
  if (target?.kind !== "home") return null;
  return streetDefinition(entries).doors.find((portal) =>
    portal.ownerEmail === target.ownerEmail && pointHitsRect(x, y, portal, 0)) || null;
}
// This is the shared world contract for the client map and server validator.
// Every facade below has a matching explicit collider.  The narrow gaps are
// intentional paved doorways, never visual-only entrances.
export const LOCATION_GEOMETRY = Object.freeze({
  office: { blockers: [], doors: [] },
  neighborhood: {
    // Street houses, colliders, and front doors are generated from the
    // approved-account snapshot in streetDefinition(), not duplicated here.
    blockers: [], doors: [], seats: [],
  },
  city: {
    blockers: [
      // Closed Plaza Market facade. This used to be a second, color-mirrored
      // entrance to the authenticated player's Willow Walk home.
      { x: 178, y: 106, width: 224, height: 235 },
      { x: 760, y: 106, width: 224, height: 122 }, { x: 760, y: 228, width: 76, height: 100 }, { x: 908, y: 228, width: 76, height: 100 },
      // Two south-lane storefronts have the same open center threshold as the
      // supplied shop facade, so their visible doors and server portals agree.
      { x: 178, y: 622, width: 224, height: 122 }, { x: 178, y: 744, width: 76, height: 100 }, { x: 326, y: 744, width: 76, height: 100 },
      { x: 760, y: 622, width: 224, height: 122 }, { x: 760, y: 744, width: 76, height: 100 }, { x: 908, y: 744, width: 76, height: 100 },
      // Cafe
      { x: 178, y: 950, width: 224, height: 122 }, { x: 178, y: 1072, width: 76, height: 100 }, { x: 326, y: 1072, width: 76, height: 100 },
      // Diner
      { x: 760, y: 950, width: 224, height: 122 }, { x: 760, y: 1072, width: 76, height: 100 }, { x: 908, y: 1072, width: 76, height: 100 },
      // Bakery
      { x: 178, y: 1250, width: 224, height: 122 }, { x: 178, y: 1372, width: 76, height: 100 }, { x: 326, y: 1372, width: 76, height: 100 },
      // Sushi
      { x: 760, y: 1250, width: 224, height: 122 }, { x: 760, y: 1372, width: 76, height: 100 }, { x: 908, y: 1372, width: 76, height: 100 },
      { x: 95, y: 186, width: 50, height: 50 }, { x: 420, y: 160, width: 50, height: 50 },
      { x: 680, y: 156, width: 50, height: 50 }, { x: 1007, y: 174, width: 50, height: 50 },
      { x: 384, y: 354, width: 28, height: 30 }, { x: 730, y: 354, width: 28, height: 30 },
      { x: 40, y: 660, width: 96, height: 30 }, { x: 1016, y: 660, width: 96, height: 30 },
      { x: 324, y: 370, width: 96, height: 30 }, { x: 732, y: 370, width: 96, height: 30 },
    ],
    doors: [
      { destination: "furniture-shop", x: 836, y: 236, width: 72, height: 100, label: "Huddle Home" },
      { destination: "garden-shop", x: 254, y: 752, width: 72, height: 100, label: "Willow & Green" },
      { destination: "decor-shop", x: 836, y: 752, width: 72, height: 100, label: "Plaza Decor" },
      { destination: "cafe", x: 254, y: 1080, width: 72, height: 100, label: "Cafe" },
      { destination: "diner", x: 836, y: 1080, width: 72, height: 100, label: "Diner" },
      { destination: "bakery", x: 254, y: 1380, width: 72, height: 100, label: "Bakery" },
      { destination: "sushi", x: 836, y: 1380, width: 72, height: 100, label: "Sushi" },
    ],
    seats: [
      // Benches sit in grass pockets around the plaza rather than on either
      // the east/west road or its crossing sidewalks.
      { id: "plaza-bench-northwest", x: 372, y: 416, dir: "down",
        stands: [{ x: 372, y: 480, dir: "down" }, { x: 340, y: 416, dir: "down" }] },
      { id: "plaza-bench-northeast", x: 780, y: 416, dir: "down",
        stands: [{ x: 780, y: 480, dir: "down" }, { x: 716, y: 416, dir: "down" }] },
      { id: "plaza-bench-southwest", x: 88, y: 712, dir: "down",
        stands: [{ x: 88, y: 776, dir: "up" }, { x: 152, y: 712, dir: "up" }] },
      { id: "plaza-bench-southeast", x: 1064, y: 712, dir: "down",
        stands: [{ x: 1064, y: 776, dir: "up" }, { x: 1032, y: 740, dir: "up" }] },
    ],
  },
  "furniture-shop": {
    blockers: [
      { x: 0, y: 0, width: 960, height: 48 }, { x: 0, y: 0, width: 48, height: 720 }, { x: 912, y: 0, width: 48, height: 720 },
      { x: 0, y: 672, width: 408, height: 48 }, { x: 552, y: 672, width: 408, height: 48 },
      { x: 144, y: 154, width: 672, height: 74 }, { x: 140, y: 378, width: 156, height: 80 }, { x: 662, y: 378, width: 156, height: 80 },
    ],
    doors: [{ destination: "city", x: 408, y: 648, width: 144, height: 72, label: "Plaza exit" }],
  },
  "garden-shop": {
    blockers: [
      { x: 0, y: 0, width: 960, height: 48 }, { x: 0, y: 0, width: 48, height: 720 }, { x: 912, y: 0, width: 48, height: 720 },
      { x: 0, y: 672, width: 408, height: 48 }, { x: 552, y: 672, width: 408, height: 48 },
      { x: 144, y: 154, width: 672, height: 74 }, { x: 140, y: 378, width: 156, height: 80 }, { x: 662, y: 378, width: 156, height: 80 },
    ],
    doors: [{ destination: "city", x: 408, y: 648, width: 144, height: 72, label: "Plaza exit" }],
  },
  "decor-shop": {
    blockers: [
      { x: 0, y: 0, width: 960, height: 48 }, { x: 0, y: 0, width: 48, height: 720 }, { x: 912, y: 0, width: 48, height: 720 },
      { x: 0, y: 672, width: 408, height: 48 }, { x: 552, y: 672, width: 408, height: 48 },
      { x: 144, y: 154, width: 672, height: 74 }, { x: 140, y: 378, width: 156, height: 80 }, { x: 662, y: 378, width: 156, height: 80 },
    ],
    doors: [{ destination: "city", x: 408, y: 648, width: 144, height: 72, label: "Plaza exit" }],
  },

  cafe: {
    blockers: [
      { x: 0, y: 0, width: 960, height: 48 }, { x: 0, y: 0, width: 48, height: 720 }, { x: 912, y: 0, width: 48, height: 720 },
      { x: 0, y: 672, width: 408, height: 48 }, { x: 552, y: 672, width: 408, height: 48 },
      { x: 200, y: 150, width: 560, height: 80 }, { x: 200, y: 350, width: 100, height: 150 }, { x: 660, y: 350, width: 100, height: 150 }
    ],
    doors: [{ destination: "city", x: 408, y: 648, width: 144, height: 72, label: "Plaza exit" }],
    seats: [ { x: 250, y: 250, dir: "up" }, { x: 350, y: 250, dir: "up" }, { x: 450, y: 250, dir: "up" }, { x: 550, y: 250, dir: "up" } ]
  },
  diner: {
    blockers: [
      { x: 0, y: 0, width: 960, height: 48 }, { x: 0, y: 0, width: 48, height: 720 }, { x: 912, y: 0, width: 48, height: 720 },
      { x: 0, y: 672, width: 408, height: 48 }, { x: 552, y: 672, width: 408, height: 48 },
      { x: 100, y: 150, width: 760, height: 60 },
      { x: 100, y: 350, width: 200, height: 100 }, { x: 660, y: 350, width: 200, height: 100 },
      { x: 100, y: 500, width: 200, height: 100 }, { x: 660, y: 500, width: 200, height: 100 }
    ],
    doors: [{ destination: "city", x: 408, y: 648, width: 144, height: 72, label: "Plaza exit" }],
    seats: [ { x: 150, y: 460, dir: "left" }, { x: 710, y: 460, dir: "right" } ]
  },
  bakery: {
    blockers: [
      { x: 0, y: 0, width: 960, height: 48 }, { x: 0, y: 0, width: 48, height: 720 }, { x: 912, y: 0, width: 48, height: 720 },
      { x: 0, y: 672, width: 408, height: 48 }, { x: 552, y: 672, width: 408, height: 48 },
      { x: 250, y: 200, width: 460, height: 100 },
      { x: 250, y: 400, width: 150, height: 60 }, { x: 560, y: 400, width: 150, height: 60 }
    ],
    doors: [{ destination: "city", x: 408, y: 648, width: 144, height: 72, label: "Plaza exit" }],
    seats: []
  },
  sushi: {
    blockers: [
      { x: 0, y: 0, width: 960, height: 48 }, { x: 0, y: 0, width: 48, height: 720 }, { x: 912, y: 0, width: 48, height: 720 },
      { x: 0, y: 672, width: 408, height: 48 }, { x: 552, y: 672, width: 408, height: 48 },
      { x: 200, y: 200, width: 560, height: 120 }, { x: 200, y: 450, width: 120, height: 120 }, { x: 640, y: 450, width: 120, height: 120 }
    ],
    doors: [{ destination: "city", x: 408, y: 648, width: 144, height: 72, label: "Plaza exit" }],
    seats: [ { x: 250, y: 350, dir: "up" }, { x: 480, y: 350, dir: "up" }, { x: 710, y: 350, dir: "up" } ]
  },
  home: {
    blockers: [
      // 24x18 floor perimeter. The centered 96px exit is the only opening in
      // the bottom wall; all other edges remain solid.
      { x: 0, y: 0, width: 1152, height: 48 },
      { x: 0, y: 0, width: 48, height: 864 },
      { x: 1104, y: 0, width: 48, height: 864 },
      { x: 0, y: 816, width: 528, height: 48 },
      { x: 624, y: 816, width: 528, height: 48 },
      ...HOME_INTERIOR_WALL_BLOCKERS,
      ...HOME_BUILTIN_FIXTURE_BLOCKERS,
    ],
    // The room map is sent with the transition payload so the browser draws
    // and collides with the exact same supplied wall-tile cells as the server.
    roomDividers: HOME_INTERIOR_WALL_BLOCKERS,
    rooms: HOME_ROOM_GEOMETRY.rooms,
    doorways: HOME_ROOM_GEOMETRY.doorways,
    builtInFixtures: HOME_BUILTIN_FIXTURES,
    // Starts above the threshold, leaving a full floor-mat depth before the
    // map edge. This makes the automatic walking exit reachable without
    // pressing into an invisible boundary.
    doors: [{ destination: "neighborhood", x: 528, y: 768, width: 96, height: 96, label: "Willow Walk exit" }],
  },
});

// The only allowed map links. `spawn` is selected by the server based on the
// source portal, not supplied by a browser.
export const LOCATION_PORTALS = Object.freeze({
  office: [{ destination: "neighborhood", x: 96, y: 3552, width: 96, height: 144, label: "Willow Walk", spawn: { x: 144, y: 504, dir: "right" } }],
  neighborhood: [
    // HQ Garden is the west end of Willow Walk's main horizontal road. It
    // mirrors the east city gate and stays west of the first residential lot.
    { destination: "office", x: 0, y: 432, width: 96, height: 144, label: "HQ Garden", spawn: { x: 216, y: 3624, dir: "right" } },
    { destination: "city", x: 1344, y: 432, width: 96, height: 144, spawn: { x: 144, y: 480, dir: "right" } },
  ],
  city: [
    { destination: "neighborhood", x: 0, y: 432, width: 96, height: 144, spawn: { x: 1248, y: 504, dir: "left" } },
    { destination: "furniture-shop", x: 836, y: 236, width: 72, height: 100, spawn: { x: 480, y: 576, dir: "up" } },
    { destination: "garden-shop", x: 254, y: 752, width: 72, height: 100, spawn: { x: 480, y: 576, dir: "up" } },
    { destination: "decor-shop", x: 836, y: 752, width: 72, height: 100, spawn: { x: 480, y: 576, dir: "up" } },
    { destination: "cafe", x: 254, y: 1080, width: 72, height: 100, spawn: { x: 480, y: 576, dir: "up" } },
    { destination: "diner", x: 836, y: 1080, width: 72, height: 100, spawn: { x: 480, y: 576, dir: "up" } },
    { destination: "bakery", x: 254, y: 1380, width: 72, height: 100, spawn: { x: 480, y: 576, dir: "up" } },
    { destination: "sushi", x: 836, y: 1380, width: 72, height: 100, spawn: { x: 480, y: 576, dir: "up" } },
  ],
  "furniture-shop": [{ destination: "city", x: 408, y: 648, width: 144, height: 72, spawn: { x: 852, y: 360, dir: "down" } }],
  "garden-shop": [{ destination: "city", x: 408, y: 648, width: 144, height: 72, spawn: { x: 290, y: 880, dir: "down" } }],
  "decor-shop": [{ destination: "city", x: 408, y: 648, width: 144, height: 72, spawn: { x: 872, y: 880, dir: "down" } }],
  cafe: [{ destination: "city", x: 408, y: 648, width: 144, height: 72, spawn: { x: 290, y: 1190, dir: "down" } }],
  diner: [{ destination: "city", x: 408, y: 648, width: 144, height: 72, spawn: { x: 872, y: 1190, dir: "down" } }],
  bakery: [{ destination: "city", x: 408, y: 648, width: 144, height: 72, spawn: { x: 290, y: 1490, dir: "down" } }],
  sushi: [{ destination: "city", x: 408, y: 648, width: 144, height: 72, spawn: { x: 872, y: 1490, dir: "down" } }],
  home: [{ destination: "neighborhood", x: 528, y: 768, width: 96, height: 96, label: "Willow Walk exit", spawn: { x: 144, y: 504, dir: "right" } }],
});

export const FURNITURE_CATALOG = Object.freeze({
  // Each image is an unmodified individual 16px-grid PNG from the uploaded
  // pack. Art is rendered at native 3× and bottom-anchored. Occupancy remains
  // the original catalog contract: an upper frame (plant leaves, lamp shade)
  // is presentation, never extra blocked floor or changed saved layouts.
  // IDs/prices deliberately remain stable for existing inventory instances.
  oak_chair:   { id: "oak_chair",   name: "Gold armchair",    price: 90,  width: 1, height: 1, color: "#b98743", rotations: [0], actions: ["sit"], interaction: { facing: "down" } },
  fern:        { id: "fern",        name: "Potted fern",      price: 130, width: 1, height: 1, color: "#4f9253", rotations: [0] },
  reading_lamp:{ id: "reading_lamp",name: "Coral floor lamp", price: 160, width: 1, height: 1, color: "#d7634b", rotations: [0] },
  coffee_table:{ id: "coffee_table",name: "Plum low table",   price: 280, width: 2, height: 1, color: "#74637e", rotations: [0] },
  blue_sofa:   { id: "blue_sofa",   name: "Tan lounge sofa", price: 460, width: 2, height: 1, color: "#b77f45", rotations: [0], actions: ["sit", "lie"], interaction: { facing: "down", radius: 96 } },
  bookcase:    { id: "bookcase",    name: "Gold bookcase",   price: 520, width: 1, height: 2, color: "#a87542", rotations: [0] },
  bed:         { id: "bed",         name: "Bedroom bed",     price: 780, width: 1, height: 3, color: "#9d6d65", rotations: [0], asset: "bedroom_bed", actions: ["sleep"], interaction: { facing: "down", radius: 104, orientation: "lengthwise" } },
  bathtub:     { id: "bathtub",     name: "Claw-foot bath",  price: 640, width: 1, height: 4, color: "#b9d7dc", rotations: [0], asset: "animated_bathtub_with_duck", actions: ["shower", "bathe"], interaction: { facing: "down", radius: 104 } },
  television:  { id: "television",  name: "Television",      price: 540, width: 1, height: 1, color: "#4c536e", rotations: [0], asset: "TV_Studio_16x16", actions: ["watch"], interaction: { anchor: "front", facing: "up", radius: 96 } },
});

export function parseLocation(value) {
  if (["office", "neighborhood", "city", "cafe", "diner", "bakery", "sushi"].includes(value) || isShopLocation(value)) return { id: value, kind: value };
  if (typeof value === "string" && value.startsWith("home:")) {
    const ownerEmail = value.slice(5).trim().toLowerCase();
    // Canonicalize BOTH the owner and room id.  A case-variant client must not
    // be able to join a second room that permission revocation cannot find.
    if (/^[^\s@]{1,64}@[^\s@]{1,64}\.[^\s@]{2,63}$/.test(ownerEmail) && ownerEmail.length <= 80)
      return { id: `home:${ownerEmail}`, kind: "home", ownerEmail };
  }
  return null;
}

export function locationSpawn(location, fromLocation = null) {
  if (fromLocation) {
    const from = parseLocation(fromLocation);
    const fromKind = from?.kind === "home" ? "home" : from?.id;
    const destination = location.kind === "home" ? "home" : location.id;
    const link = (LOCATION_PORTALS[fromKind] || []).find((portal) => portal.destination === destination);
    if (link?.spawn) return { ...link.spawn };
  }
  if (location.kind === "home") return { x: 12 * HOME_GRID.cell, y: 720, dir: "down" };
  return { ...LOCATIONS[location.id].spawn };
}

export function portalForTransition(fromLocation, destination, x, y, actorEmail = "") {
  const from = parseLocation(fromLocation), target = parseLocation(destination);
  if (!from || !target || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const fromKind = from.kind === "home" ? "home" : from.id;
  const targetKind = target.kind === "home" ? "home" : target.id;
  if (targetKind === "home" && isHuddleTestIdentity(target.ownerEmail)) return null;
  // Coworker visits are permission-gated by homeAccess in server.js and may
  // only be entered through that account's marked Willow Walk front door.
  if (targetKind === "home" && target.ownerEmail !== String(actorEmail).trim().toLowerCase() && !RESIDENTIAL_BLOCK_IDS.includes(fromKind)) return null;
  return (LOCATION_PORTALS[fromKind] || []).find((portal) =>
    portal.destination === targetKind && pointHitsRect(x, y, portal, 0)) || null;
}

export function locationBounds(location) {
  if (location.kind === "home") return { width: HOME_GRID.width * HOME_GRID.cell, height: HOME_GRID.height * HOME_GRID.cell };
  return LOCATIONS[location.id].bounds;
}

export function pointHitsRect(x, y, rect, radius = ACTOR_FOOT_RADIUS) {
  return x + radius > rect.x && x - radius < rect.x + rect.width &&
    y + radius > rect.y && y - radius < rect.y + rect.height;
}

export function staticSeatForPoint(location, x, y, radius = 24) {
  const geometry = LOCATION_GEOMETRY[location?.kind === "home" ? "home" : location?.id];
  const seats = geometry?.seats || [];
  return seats.find((seat) =>
    Math.abs(Number(seat.x) - Number(x)) <= radius &&
    Math.abs(Number(seat.y) - Number(y)) <= radius) || null;
}

export function staticSeatStandCandidates(location, seat) {
  if (!seat || !Number.isFinite(Number(seat.x)) || !Number.isFinite(Number(seat.y))) return [];
  const authored = Array.isArray(seat.stands) ? seat.stands
    : Array.isArray(seat.stand) ? seat.stand : seat.stand ? [seat.stand] : [];
  const candidates = authored
    .filter((point) => Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y)))
    .map((point) => ({ x: Number(point.x), y: Number(point.y), dir: point.dir || seat.dir || "down" }));
  if (!candidates.length) {
    const pivot = location?.id === "city" ? 576 : (Number(locationBounds(location)?.height) || 0) / 2;
    const northPocket = Number(seat.y) < pivot;
    candidates.push(
      { x: Number(seat.x), y: Number(seat.y) + (northPocket ? -64 : 64), dir: northPocket ? "down" : "up" },
      { x: Number(seat.x), y: Number(seat.y) + (northPocket ? 64 : -64), dir: northPocket ? "up" : "down" },
      { x: Number(seat.x) - 64, y: Number(seat.y), dir: "right" },
      { x: Number(seat.x) + 64, y: Number(seat.y), dir: "left" },
    );
  }
  const unique = [];
  const seen = new Set();
  for (const point of candidates) {
    const key = `${point.x}:${point.y}:${point.dir}`;
    if (!seen.has(key) && validLocationMove(location, point.x, point.y)) {
      seen.add(key); unique.push(point);
    }
  }
  return unique;
}

export function validLocationMove(location, x, y, dynamicBlockers = []) {
  const b = locationBounds(location);
  if (b && (x < ACTOR_FOOT_RADIUS || y < ACTOR_FOOT_RADIUS || x > b.width - ACTOR_FOOT_RADIUS || y > b.height - ACTOR_FOOT_RADIUS)) return false;
  const geometry = LOCATION_GEOMETRY[location.kind === "home" ? "home" : location.id];
  return ![...(geometry?.blockers || []), ...dynamicBlockers].some((rect) => pointHitsRect(x, y, rect));
}

export function validStreetMove(entries, x, y, dynamicBlockers = []) {
  return validStreetWorldMove(streetDefinition(entries), x, y, dynamicBlockers);
}

// The server retains one immutable streetDefinition snapshot between actual
// residence changes. Accepting that snapshot here avoids re-creating every
// facade and yard blocker for each 20 Hz movement packet while preserving the
// exact same bounds and collision test as validStreetMove().
export function validStreetWorldMove(street, x, y, dynamicBlockers = []) {
  if (!street?.bounds || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  const b = street.bounds;
  if (x < ACTOR_FOOT_RADIUS || y < ACTOR_FOOT_RADIUS ||
      x > b.width - ACTOR_FOOT_RADIUS || y > b.height - ACTOR_FOOT_RADIUS) return false;
  return !(street.blockers || []).some((rect) => pointHitsRect(x, y, rect)) &&
    !(dynamicBlockers || []).some((rect) => pointHitsRect(x, y, rect));
}

// Persisted layouts predate the upright-art policy. This is the one canonical
// interpretation used by snapshots, collision, and placement validation.
export function effectiveRotation(item, rotation) {
  const value = Number(rotation);
  return item?.rotations?.includes(value) ? value : 0;
}

export function furnitureFootprint(item, rotation) {
  const quarter = effectiveRotation(item, rotation) % 180;
  return quarter === 90 ? { width: item.height, height: item.width } : { width: item.width, height: item.height };
}

export function validPlacement(item, x, y, rotation, otherItems = []) {
  if (!item || !item.rotations.includes(rotation) || !Number.isInteger(x) || !Number.isInteger(y)) return false;
  const f = furnitureFootprint(item, rotation);
  // The spawn-to-door entry strip is permanently clear, so furniture can never
  // trap a visitor at arrival or block the front door.
  if (x < 1 || y < 1 || x + f.width > HOME_GRID.width - 1 || y + f.height > HOME_GRID.height - 1 ||
      // Preserve the central spawn and its two-cell route to the front door.
      // Existing 12x9 placements remain untouched unless they intersect a
      // newly authoritative wall/divider, in which case repairLegacyLayout
      // returns only that placement to the owner's inventory.
      (x < 13 && x + f.width > 11 && y < HOME_GRID.height && y + f.height > 14) ||
      // Room-divider cells are real walls, not decorative overlays. Rejecting
      // them here keeps a saved item from occupying a cell the movement
      // validator and client Arcade collider consider solid.
      HOME_ROOM_GEOMETRY.walls.some((wall) =>
        x < wall.x + wall.width && x + f.width > wall.x &&
        y < wall.y + wall.height && y + f.height > wall.y)) return false;
  if (HOME_BUILTIN_FIXTURES.some((fixture) =>
    x < fixture.gridX + fixture.width && x + f.width > fixture.gridX &&
    y < fixture.gridY + fixture.height && y + f.height > fixture.gridY)) return false;
  // A clear cell is still a doorway: furniture there can block the only
  // route between rooms even though it does not overlap a wall tile.
  if (HOME_ROOM_GEOMETRY.doorways.some((doorway) =>
    x < doorway.x + doorway.width && x + f.width > doorway.x &&
    y < doorway.y + doorway.height && y + f.height > doorway.y)) return false;
  return !otherItems.some((placed) => {
    const of = furnitureFootprint(placed.item, placed.rotation);
    return x < placed.gridX + of.width && x + f.width > placed.gridX &&
      y < placed.gridY + of.height && y + f.height > placed.gridY;
  });
}

export function validYardPlacement(item, x, y, rotation, otherItems) {
  if (!item || !item.rotations.includes(rotation) || !Number.isInteger(x) || !Number.isInteger(y)) return false;
  const f = furnitureFootprint(item, rotation);
  // Keep the gate-facing row clear so an owner or visitor cannot be fenced in.
  if (x < 0 || y < 0 || x + f.width > YARD_GRID.width || y + f.height > YARD_GRID.height ||
      (x < 2 && x + f.width > 1 && y === YARD_GRID.height - 1)) return false;
  return !otherItems.some((placed) => {
    const of = furnitureFootprint(placed.item, placed.rotation);
    return x < placed.gridX + of.width && x + f.width > placed.gridX &&
      y < placed.gridY + of.height && y + f.height > placed.gridY;
  });
}

export function layoutBlockers(layout) {
  return (layout || []).flatMap((placed) => {
    const item = FURNITURE_CATALOG[placed.furnitureId];
    if (!item) return [];
    const footprint = furnitureFootprint(item, placed.rotation);
    return [{ x: placed.gridX * HOME_GRID.cell, y: placed.gridY * HOME_GRID.cell,
      width: footprint.width * HOME_GRID.cell, height: footprint.height * HOME_GRID.cell, furnitureId: placed.furnitureId }];
  });
}

export async function ensureHome(pool, email) {
  if (isHuddleTestIdentity(email)) return null;
  await pool.query(
    // `ON CONFLICT DO NOTHING` alone still evaluates the lot identity before
    // discovering an existing owner, burning a durable street slot on every
    // snapshot/access read. Avoid proposing an insert unless the row is absent;
    // keep the conflict clause for the legitimate first-home race.
    `INSERT INTO jpo_homes (owner_email)
       SELECT $1
       WHERE NOT EXISTS (SELECT 1 FROM jpo_homes WHERE owner_email=$1)
       ON CONFLICT (owner_email) DO NOTHING`,
    [email],
  );
  const { rows } = await pool.query(
    `SELECT owner_email, lot_index, access_mode, layout_revision, exterior_color,
            floor_built, walls_built, roof_built, construction_updated_at
       FROM jpo_homes WHERE owner_email=$1`,
    [email],
  );
  return rows[0] || null;
}

export async function homeAccess(pool, ownerEmail, visitorEmail) {
  if (isHuddleTestIdentity(ownerEmail)) {
    return { ok: false, code: "not_found" };
  }
  const home = await ensureHome(pool, ownerEmail);
  if (!home) return { ok: false, code: "not_found" };
  if (!homeConstruction(home).complete) return { ok: false, code: "unfinished", home };
  if (ownerEmail === visitorEmail || home.access_mode === "public") return { ok: true, home };
  if (home.access_mode !== "invite_only") return { ok: false, code: "denied", home };
  const { rows } = await pool.query(
    `SELECT 1 FROM jpo_home_invitations WHERE owner_email=$1 AND invitee_email=$2 AND active=true`,
    [ownerEmail, visitorEmail],
  );
  return { ok: !!rows[0], code: rows[0] ? null : "denied", home };
}

// A legacy 90°/270° record was made when the UI rotated a bitmap even though
// no matching directional art existed. Normalize it under the home row lock.
// This also repairs layouts that predate the room-divider geometry. If an
// upright footprint conflicts with a wall or another earlier item, remove only
// the layout row: the furniture row remains in inventory, so no purchased item
// is lost while the new rooms become traversable.
export async function repairLegacyLayout(pool, ownerEmail) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureHome(client, ownerEmail);
    await client.query(`SELECT owner_email FROM jpo_homes WHERE owner_email=$1 FOR UPDATE`, [ownerEmail]);
    const { rows } = await client.query(
      `SELECT l.furniture_instance_id, l.grid_x, l.grid_y, l.rotation, l.placement_zone, f.furniture_id
         FROM jpo_home_layout_items l
         JOIN jpo_home_furniture f ON f.id=l.furniture_instance_id
        WHERE l.home_owner_email=$1
        ORDER BY l.updated_at, l.furniture_instance_id
        FOR UPDATE OF l`,
      [ownerEmail],
    );
    const canonical = new Map([["indoor", []], ["yard", []]]);
    let changed = false;
    for (const row of rows) {
      const item = FURNITURE_CATALOG[row.furniture_id];
      if (!item) continue;
      const zone = row.placement_zone === "yard" ? "yard" : "indoor";
      const zoneItems = canonical.get(zone);
      const rotation = effectiveRotation(item, row.rotation);
      const fits = zone === "yard"
        ? validYardPlacement(item, row.grid_x, row.grid_y, rotation, zoneItems)
        : validPlacement(item, row.grid_x, row.grid_y, rotation, zoneItems);
      if (fits) {
        if (Number(row.rotation) !== rotation) {
          await client.query(`UPDATE jpo_home_layout_items SET rotation=$2, updated_at=now() WHERE furniture_instance_id=$1`, [row.furniture_instance_id, rotation]);
          changed = true;
        }
        zoneItems.push({ gridX: row.grid_x, gridY: row.grid_y, rotation, item });
      } else {
        // Deleting only the placement row is the normal "store" flow at the
        // persistence layer: the owned furniture instance stays inventory.
        await client.query(`DELETE FROM jpo_home_layout_items WHERE furniture_instance_id=$1`, [row.furniture_instance_id]);
        changed = true;
      }
    }
    if (changed) await client.query(`UPDATE jpo_homes SET layout_revision=layout_revision+1, updated_at=now() WHERE owner_email=$1`, [ownerEmail]);
    await client.query("COMMIT");
    return changed;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function homeSnapshot(pool, ownerEmail, viewerEmail) {
  if (isHuddleTestIdentity(ownerEmail)) return null;
  await repairLegacyLayout(pool, ownerEmail);
  const home = await ensureHome(pool, ownerEmail);
  const { rows } = await pool.query(
    `SELECT f.id, f.furniture_id, l.grid_x, l.grid_y, l.rotation, l.placement_zone
       FROM jpo_home_furniture f
       LEFT JOIN jpo_home_layout_items l ON l.furniture_instance_id=f.id
      WHERE f.owner_email=$1 ORDER BY f.acquired_at, f.id`,
    [ownerEmail],
  );
  const inventory = [], layout = [], yard = [];
  for (const row of rows) {
    const catalog = FURNITURE_CATALOG[row.furniture_id];
    if (!catalog) continue;
    const view = { id: row.id, furnitureId: row.furniture_id };
    if (row.grid_x == null) inventory.push(view);
    else (row.placement_zone === "yard" ? yard : layout).push({
      ...view, gridX: row.grid_x, gridY: row.grid_y, rotation: effectiveRotation(catalog, row.rotation),
    });
  }
  const invitations = ownerEmail === viewerEmail
    ? (await pool.query(
      `SELECT i.invitee_email, coalesce(nullif(p.nickname,''), p.first_name, p.name, i.invitee_email) AS name
         FROM jpo_home_invitations i LEFT JOIN jpo_players p ON p.email=i.invitee_email
        WHERE i.owner_email=$1 AND i.active=true ORDER BY name, i.invitee_email`,
      [ownerEmail],
    )).rows.map((row) => ({ email: row.invitee_email, name: row.name }))
    : undefined;
  return {
    ownerEmail, accessMode: home.access_mode, revision: home.layout_revision,
    // Old home rows created before this optional column's default is applied
    // remain visually teal without needing a backfill.
    exteriorColor: homeExteriorColor(home.exterior_color),
    construction: homeConstruction(home),
    // Saved furniture is never discarded during construction. This count makes
    // its dormant status explicit on the outdoor construction panel without
    // exposing a visitor's private inventory.
    archivedFurnitureCount: homeConstruction(home).complete || ownerEmail === viewerEmail
      ? inventory.length + layout.length + yard.length
      : undefined,
    canEdit: ownerEmail === viewerEmail, inventory, layout, yard, invitations,
  };
}

// Safe street projection: all approved resident accounts have a visible
// exterior lot, while access is still enforced at the actual front door.
// Session-only Huddle A/B identities are intentionally omitted even when a
// retained database row exists. The projection deliberately omits indoor
// layout, inventory, and account data beyond name/email; the small outdoor
// yard projection is required to render the shared street.
export async function homeDirectory(pool, viewerEmail) {
  // Materialise a row for every approved account while processing an explicit
  // street request. This is not startup DDL and gives each actual resident a
  // durable address before their first visit.
  await pool.query(`INSERT INTO jpo_homes (owner_email)
                    SELECT p.email
                      FROM jpo_players p
                     WHERE p.approved=true
                        AND lower(p.email) !~ '^huddle-[ab](-[a-z0-9]+)?@justpressone[.]com$'
                       AND NOT EXISTS (
                         SELECT 1 FROM jpo_homes h WHERE h.owner_email=p.email
                       )
                    ON CONFLICT (owner_email) DO NOTHING`);
  const { rows } = await pool.query(
    `SELECT h.owner_email, h.lot_index, h.access_mode, h.exterior_color,
            h.floor_built, h.walls_built, h.roof_built,
            coalesce(nullif(p.nickname,''), p.first_name, p.name, h.owner_email) AS name
       FROM jpo_homes h JOIN jpo_players p ON p.email=h.owner_email
        WHERE p.approved=true
          AND lower(p.email) !~ '^huddle-[ab](-[a-z0-9]+)?@justpressone[.]com$'
       ORDER BY h.lot_index ASC
    `,
    [],
  );
  const owners = rows.map((row) => row.owner_email);
  const yardRows = owners.length ? (await pool.query(
    `SELECT f.owner_email, f.id, f.furniture_id, l.grid_x, l.grid_y, l.rotation
       FROM jpo_home_layout_items l JOIN jpo_home_furniture f ON f.id=l.furniture_instance_id
      WHERE l.placement_zone='yard' AND f.owner_email=ANY($1::text[])
      ORDER BY f.acquired_at, f.id`,
    [owners],
  )).rows : [];
  const yards = new Map();
  for (const row of yardRows) {
    const item = FURNITURE_CATALOG[row.furniture_id];
    if (!item) continue;
    const list = yards.get(row.owner_email) || [];
    list.push({ id: row.id, furnitureId: row.furniture_id, gridX: row.grid_x, gridY: row.grid_y,
      rotation: effectiveRotation(item, row.rotation) });
    yards.set(row.owner_email, list);
  }
  const total = rows.length;
  return {
    homes: rows.map((row) => ({
      ownerEmail: row.owner_email, lotIndex: Number(row.lot_index), name: row.name, accessMode: row.access_mode,
      exteriorColor: homeExteriorColor(row.exterior_color),
      construction: homeConstruction(row),
      yard: yards.get(row.owner_email) || [],
    })),
    page: 0, pageSize: total, total, pageCount: 1,
  };
}
