import commercialLayouts from "./public/commercial-layouts.json" with { type: "json" };

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
// Willow Walk is made from repeating 960px blocks.  Keep the road/end
// coordinates in the shared contract so a sparse lot directory can still
// produce a complete, continuous set of east-side city gates.
export const STREET_BLOCK_LAYOUT = Object.freeze({
  width: 1440,
  segmentHeight: 960,
  height: 960,
  road: Object.freeze({ x: 0, y: 432, width: 1440, height: 144 }),
  // The landscape renderer uses this clear north/south lane to join the
  // horizontal road in this block to the same lane in the block above/below.
  // It is deliberately a local coordinate: each block is translated by its
  // grid column/row when the street is painted.
  verticalRoad: Object.freeze({ x: 552, centerX: 576, y: 0, width: 48, height: 960 }),
  eastPortal: Object.freeze({ x: 1344, width: 96, height: 144 }),
  westPortal: Object.freeze({ x: 0, width: 96, height: 144 }),
});
// Huddle Plaza is a landscape map. Keep the direct arrival just inside the
// west gate so the same point is useful for direct joins and Willow Walk
// returns without immediately re-triggering the portal.
const CITY_PLAZA_BOUNDS = Object.freeze({ width: 3600, height: 1920 });
export const CITY_DIRECT_JOIN_SPAWN = Object.freeze({ x: 144, y: 960, dir: "right" });
export const LOCATIONS = Object.freeze({
  office: { id: "office", label: "JPO HQ", spawn: { x: 1272, y: 2253, dir: "down" }, bounds: null },
  neighborhood: { id: "neighborhood", label: "Willow Walk", spawn: { x: 144, y: 504, dir: "right" }, bounds: { width: 1440, height: 1056 } },
  city: { id: "city", label: "Huddle Plaza", spawn: CITY_DIRECT_JOIN_SPAWN, bounds: CITY_PLAZA_BOUNDS },
  cafe: { id: "cafe", label: "Cafe", spawn: { x: 480, y: 576, dir: "up" }, bounds: { width: 960, height: 720 } },
  diner: { id: "diner", label: "Diner", spawn: { x: 480, y: 576, dir: "up" }, bounds: { width: 960, height: 720 } },
  bakery: { id: "bakery", label: "Bakery", spawn: { x: 480, y: 576, dir: "up" }, bounds: { width: 960, height: 720 } },
  sushi: { id: "sushi", label: "Sushi", spawn: { x: 480, y: 576, dir: "up" }, bounds: { width: 960, height: 720 } },
  "furniture-shop": { id: "furniture-shop", label: "Huddle Home", spawn: { x: 480, y: 576, dir: "up" }, bounds: { width: 960, height: 720 } },
  "garden-shop": { id: "garden-shop", label: "Willow & Green", spawn: { x: 480, y: 576, dir: "up" }, bounds: { width: 960, height: 720 } },
  "decor-shop": { id: "decor-shop", label: "Plaza Decor", spawn: { x: 480, y: 576, dir: "up" }, bounds: { width: 960, height: 720 } },
  museum: { id: "museum", label: "Huddle Museum", spawn: { x: 480, y: 576, dir: "up" }, bounds: { width: 960, height: 720 } },
  "museum-room-1": { id: "museum-room-1", label: "Museum Gallery 1", spawn: { x: 480, y: 576, dir: "up" }, bounds: { width: 960, height: 720 } },
  "museum-room-2": { id: "museum-room-2", label: "Museum Gallery 2", spawn: { x: 480, y: 576, dir: "up" }, bounds: { width: 960, height: 720 } },
  "museum-room-3": { id: "museum-room-3", label: "Museum Gallery 3", spawn: { x: 480, y: 576, dir: "up" }, bounds: { width: 960, height: 720 } },
  "museum-room-4": { id: "museum-room-4", label: "Museum Gallery 4", spawn: { x: 480, y: 576, dir: "up" }, bounds: { width: 960, height: 720 } },
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
// A block is a real stretch of the continuous street: four homes face the
// north pavement and four face the south pavement.  Blocks are laid out as a
// compact rectangular grid, while each home's durable `lotIndex` remains its
// address. `displayIndex` is intentionally separate from that address: a
// deleted/sparse lot must not leave an empty house-sized hole in the drawing.
export function streetDefinition(entries = []) {
  // Retained Huddle A/B rows (including their possessions) are intentionally
  // not neighborhood residents.  Filtering here is the final presentation
  // guard in addition to homeDirectory's SQL filter, so stale snapshots can
  // never paint or address their old lots.
  const homes = Array.isArray(entries)
    ? entries
      .filter((home) => !isHuddleTestIdentity(home?.ownerEmail))
      // homeDirectory() already orders this snapshot by lot_index. Keep that
      // contract explicit here as well so direct/unit callers cannot make a
      // sparse durable address become a visual position.
      .map((home, sourceIndex) => ({ home, sourceIndex }))
      .sort((a, b) => {
        const aLot = Number(a.home?.lotIndex), bLot = Number(b.home?.lotIndex);
        const aValid = Number.isFinite(aLot) && aLot > 0;
        const bValid = Number.isFinite(bLot) && bLot > 0;
        if (aValid !== bValid) return aValid ? -1 : 1;
        if (aValid && aLot !== bLot) return aLot - bLot;
        return a.sourceIndex - b.sourceIndex;
      })
      .map(({ home }) => home)
    : [];
  const occupiedBlockCount = Math.max(1, Math.ceil(homes.length / STREET_LOT_OFFSETS.length));
  // Keep the east-side plaza within four blocks of the west entrance.
  // Additional homes extend rows rather than widening that walk.
  const columns = Math.min(occupiedBlockCount, 4);
  const rows = Math.ceil(occupiedBlockCount / columns);
  const blocks = Array.from({ length: rows * columns }, (_, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    return {
      index, row, column,
      x: column * STREET_BLOCK_LAYOUT.width,
      y: row * STREET_BLOCK_LAYOUT.height,
      width: STREET_BLOCK_LAYOUT.width,
      height: STREET_BLOCK_LAYOUT.height,
    };
  });
  const lots = homes.map((home, index) => {
    const displayIndex = index + 1;
    const permanentLot = Number.isFinite(Number(home?.lotIndex)) && Number(home.lotIndex) > 0
      ? Number(home.lotIndex) : displayIndex;
    const displaySlot = displayIndex - 1;
    const blockIndex = Math.floor(displaySlot / STREET_LOT_OFFSETS.length);
    const block = blocks[blockIndex];
    const [localX, localBottom] = STREET_LOT_OFFSETS[displaySlot % STREET_LOT_OFFSETS.length];
    const x = block.x + localX;
    const bottom = block.y + localBottom;
    const northSide = localBottom < 500;
    const door = {
      destination: "home", residence: true, lot: permanentLot, ownerEmail: home.ownerEmail,
      x: x - 36, y: bottom - 90, width: 72, height: 100,
      label: `${home.name || home.ownerEmail}'s home`,
    };
    return {
      ...home,
      construction: home.construction || homeConstruction(home),
      // `lot` is the durable address used by doorway authorization. Never
      // replace it with the dense display slot when old addresses have gaps.
      lot: permanentLot,
      displayIndex,
      blockIndex: block.index,
      row: block.row,
      column: block.column,
      x, bottom, northSide, door,
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
    const movementOffset = item.movementBlockerOffset || {};
    const offsetX = Number.isFinite(Number(movementOffset.x)) ? Number(movementOffset.x) : 0;
    const offsetY = Number.isFinite(Number(movementOffset.y)) ? Number(movementOffset.y) : 0;
    return [{
      x: originX + placed.gridX * YARD_GRID.cell + offsetX,
      y: originY + placed.gridY * YARD_GRID.cell + offsetY,
      width: footprint.width * YARD_GRID.cell,
      height: footprint.height * YARD_GRID.cell,
      furnitureId: placed.furnitureId,
    }];
  }));
  const doors = lots.filter((lot) => lot.construction?.complete).map((lot) => lot.door);
  const bounds = { width: columns * STREET_BLOCK_LAYOUT.width, height: rows * STREET_BLOCK_LAYOUT.height + 96 };
  // City gates are only at the east OUTER edge. There is one per row, rather
  // than one per block column; an interior-column gate would strand the
  // compact landscape behind a visual road seam.
  const roadPortals = Array.from({ length: rows }, (_, row) => {
    const y = row * STREET_BLOCK_LAYOUT.segmentHeight + STREET_BLOCK_LAYOUT.road.y;
    const neighborhoodSpawn = {
      // Stop 192px west of the gate.  This is outside the trigger even with
      // the 16px foot radius, so a city return cannot immediately bounce back.
      x: bounds.width - 192,
      y: y + STREET_BLOCK_LAYOUT.road.height / 2,
      dir: "left",
    };
    // Every east road end opens onto the same west plaza arrival. The
    // block is remembered server-side; Plaza itself has one west gate.
    const citySpawn = { ...CITY_DIRECT_JOIN_SPAWN };
    return {
      // `segment` remains the metadata field used by connected clients and
      // reconnect snapshots. In the landscape layout it is the row number.
      segment: row,
      row,
      destination: "city",
      x: bounds.width - STREET_BLOCK_LAYOUT.eastPortal.width,
      y,
      width: STREET_BLOCK_LAYOUT.eastPortal.width,
      height: STREET_BLOCK_LAYOUT.eastPortal.height,
      label: "Huddle Plaza",
      spawn: citySpawn,
      returnPoint: neighborhoodSpawn,
    };
  });
  // Plaza intentionally has one west gate. Do not mirror sparse residential
  // road rows into the city; the player's remembered segment selects the
  // return point when they leave this gate.
  const cityPortals = [{
    destination: "neighborhood",
    x: STREET_BLOCK_LAYOUT.westPortal.x,
    y: STREET_BLOCK_LAYOUT.road.y,
    width: STREET_BLOCK_LAYOUT.westPortal.width,
    height: STREET_BLOCK_LAYOUT.westPortal.height,
    label: "Willow Walk",
    segment: 0,
    row: 0,
    spawn: { x: 1248, y: 504, dir: "left" },
  }];
  return {
    bounds,
    blockers: [...blockers, ...yardBlockers],
    doors,
    lots,
    blocks,
    occupiedBlockCount,
    columns,
    rows,
    // Existing renderers use segmentCount to decide how much road scenery to
    // prepare. It now means row count; blocks is the authoritative grid.
    segmentCount: rows,
    roadPortals,
    cityPortals,
  };
}

export function streetLotForOwner(entries, ownerEmail) {
  const email = String(ownerEmail || "").trim().toLowerCase();
  if (isHuddleTestIdentity(email)) return null;
  return streetDefinition(entries).lots.find((lot) =>
    String(lot.ownerEmail || "").trim().toLowerCase() === email) || null;
}

export function streetReturnSpawnForOwner(entries, ownerEmail) {
  const street = streetDefinition(entries);
  const email = String(ownerEmail || "").trim().toLowerCase();
  if (isHuddleTestIdentity(email)) return null;
  const lot = street.lots.find((entry) =>
    String(entry.ownerEmail || "").trim().toLowerCase() === email);
  return lot?.returnSpawn &&
    validStreetWorldMove(street, lot.returnSpawn.x, lot.returnSpawn.y)
    ? { ...lot.returnSpawn } : null;
}

export function streetPortalForTransition(destination, x, y, entries) {
  const target = parseLocation(destination);
  const street = streetDefinition(entries);
  if (target?.kind === "home") {
    return street.doors.find((portal) =>
      portal.ownerEmail === target.ownerEmail && pointHitsRect(x, y, portal, ACTOR_FOOT_RADIUS)) || null;
  }
  if (target?.id === "city") {
    return street.roadPortals.find((portal) => pointHitsRect(x, y, portal, ACTOR_FOOT_RADIUS)) || null;
  }
  return null;
}

// City has one west-side return gate. A remembered row is an additional
// server-side guard: a player who entered from row 3 cannot be redirected to
// row 0 by a stale client destination. With no remembered row (a direct city
// join), the physical top gate remains an explicit, valid fallback.
export function streetCityPortalForTransition(x, y, entries, preferredSegment = null) {
  const street = streetDefinition(entries);
  const gate = street.cityPortals[0];
  if (!gate || !pointHitsRect(x, y, gate, ACTOR_FOOT_RADIUS)) return null;
  // Accept either the old numeric segment or the remembered metadata object.
  // The field names remain `segment`, `roadY`, and `returnPoint`; only the
  // meaning of segment changes from a vertical segment to a compact-grid row.
  const metadata = preferredSegment && typeof preferredSegment === "object" ? preferredSegment : null;
  const requestedSegment = metadata ? metadata.segment ?? metadata.row : preferredSegment;
  const segment = Number(requestedSegment);
  const roadY = Number(metadata?.roadY);
  const selected = Number.isInteger(segment) && segment >= 0
    ? street.roadPortals.find((portal) => portal.segment === segment)
    : null;
  const byRoadY = Number.isFinite(roadY)
    ? street.roadPortals.find((portal) => portal.y === roadY)
    : null;
  const current = selected || byRoadY || street.roadPortals[0];
  return {
    ...gate,
    segment: current?.segment ?? 0,
    row: current?.row ?? current?.segment ?? 0,
    roadY: current?.y ?? street.roadPortals[0]?.y ?? STREET_BLOCK_LAYOUT.road.y,
    spawn: current?.returnPoint ? { ...current.returnPoint } : { ...gate.spawn },
  };
}

// Commercial interiors are authored in a shared manifest so the renderer and
// server never disagree about display/seat occupancy. The manifest owns props;
// the perimeter and threshold walls below remain this module's architecture
// contract.
const COMMERCIAL_ROOMS = commercialLayouts?.rooms || commercialLayouts || {};
const COMMERCIAL_ROOM_IDS = Object.freeze([
  "furniture-shop", "garden-shop", "decor-shop", "cafe", "diner", "bakery",
  "sushi", "museum", "museum-room-1", "museum-room-2", "museum-room-3",
  "museum-room-4",
]);
function commercialRoomManifest(id) {
  const room = COMMERCIAL_ROOMS?.[id];
  return room && Number(room.width) === 960 && Number(room.height) === 720 ? room : null;
}
function isInteriorBoundary(rect) {
  return rect?.x === 0 || rect?.y === 0 ||
    Number(rect.x) + Number(rect.width) === 960 ||
    Number(rect.y) + Number(rect.height) === 720;
}
function commercialRoomGeometry(id, architecture) {
  const room = commercialRoomManifest(id);
  if (!room) return architecture;
  const walls = (architecture.blockers || []).filter(isInteriorBoundary);
  // The furniture shop replaces its legacy decorative props with the
  // server-projected real catalog showroom. Those manifest rectangles belong
  // to the removed props (the renderer explicitly destroys them), so retaining
  // them would create invisible blockers over sofa/TV activity anchors.
  const propBlockers = id === "furniture-shop" ? [] : room.blockers;
  return {
    ...architecture,
    blockers: [...walls, ...(Array.isArray(propBlockers) ? propBlockers : [])],
    // Furniture-shop display seats are legacy props. The client removes those
    // props and replaces them with the server-projected catalog demos, so
    // retaining their park-seat metadata would expose invisible [E] Sit
    // targets below the showroom. Other commercial rooms keep their authored
    // benches/chairs unchanged.
    seats: id === "furniture-shop" ? [] :
      (Array.isArray(room.seats) ? room.seats : (architecture.seats || [])),
    commercialLayout: room,
  };
}

// Huddle Plaza is a fixed 3600x1920 authored world. The venue footprints keep
// their native visual sizes while using four north and four south positions
// across a broad, connected landscape instead of a narrow vertical strip.
const CITY_GATHERING_SQUARE = Object.freeze({
  x: 192, y: 448, width: 3216, height: 640,
});

function cityShopLayout({ id, label, x, y }) {
  const footprint = Object.freeze({ x, y, width: 224, height: 222 });
  // The supplied facade has a 72px opening in its 224px front.  The visual
  // door is centered at x+112 and its bottom edge is the facade bottom.
  const door = Object.freeze({
    x: x + 76, y: y + 122, width: 72, height: 100,
  });
  const topRow = y < CITY_GATHERING_SQUARE.y;
  return Object.freeze({
    id, label, footprint, door,
    citySpawn: Object.freeze({
      x: x + footprint.width / 2,
      // Supplied facades open along their south edge. Return below the
      // facade for both rows; the lower row reaches the square via its
      // authored side walk rather than spawning inside a roof.
      y: y + footprint.height + 42,
      dir: topRow ? "down" : "up",
    }),
    blockers: Object.freeze([
      Object.freeze({ x, y, width: 224, height: 122 }),
      Object.freeze({ x, y: y + 122, width: 76, height: 100 }),
      Object.freeze({ x: x + 148, y: y + 122, width: 76, height: 100 }),
    ]),
  });
}

const CITY_PLAZA_SHOPS = Object.freeze([
  cityShopLayout({ id: "furniture-shop", label: "Huddle Home", x: 368, y: 160 }),
  cityShopLayout({ id: "garden-shop", label: "Willow & Green", x: 1248, y: 160 }),
  cityShopLayout({ id: "decor-shop", label: "Plaza Decor", x: 2128, y: 160 }),
  cityShopLayout({ id: "cafe", label: "Cafe", x: 3008, y: 160 }),
  cityShopLayout({ id: "diner", label: "Diner", x: 368, y: 1120 }),
  cityShopLayout({ id: "bakery", label: "Sweet Crust Bakery", x: 1248, y: 1120 }),
  cityShopLayout({ id: "sushi", label: "Sakura Sushi", x: 2128, y: 1120 }),
]);
const CITY_PLAZA_SHOP_BY_ID = Object.freeze(Object.fromEntries(
  CITY_PLAZA_SHOPS.map((shop) => [shop.id, shop]),
));

const CITY_MUSEUM_LAYOUT = Object.freeze({
  id: "museum",
  label: "Huddle Museum",
  footprint: Object.freeze({ x: 3000, y: 1120, width: 240, height: 350 }),
  door: Object.freeze({ x: 3072, y: 1370, width: 96, height: 100 }),
  citySpawn: Object.freeze({ x: 3120, y: 1512, dir: "up" }),
  museumSpawn: Object.freeze({ x: 480, y: 576, dir: "up" }),
  blockers: Object.freeze([
    Object.freeze({ x: 3000, y: 1120, width: 240, height: 250 }),
    Object.freeze({ x: 3000, y: 1370, width: 72, height: 100 }),
    Object.freeze({ x: 3168, y: 1370, width: 72, height: 100 }),
  ]),
});

export const CITY_COMMERCIAL_LAYOUT = Object.freeze({
  cityBounds: CITY_PLAZA_BOUNDS,
  gatheringSquare: CITY_GATHERING_SQUARE,
  shops: CITY_PLAZA_SHOPS,
  venues: Object.freeze([...CITY_PLAZA_SHOPS, CITY_MUSEUM_LAYOUT]),
  museum: CITY_MUSEUM_LAYOUT,
});
// Keep the plaza name explicit for renderer and geometry consumers while
// retaining the existing museum-facing export used by older clients.
export const CITY_PLAZA_LAYOUT = CITY_COMMERCIAL_LAYOUT;
// Renderer-facing aliases keep the imported design manifest and the city
// exterior contract discoverable from one shared module.
export const COMMERCIAL_LAYOUTS = commercialLayouts;
export const COMMERCIAL_INTERIOR_LAYOUT = COMMERCIAL_LAYOUTS;
export const CITY_LAYOUT = CITY_COMMERCIAL_LAYOUT;

const MUSEUM_FOYER_DOORS = Object.freeze([
  Object.freeze({ destination: "museum-room-1", x: 144, y: 0, width: 96, height: 72, label: "Gallery 1", spawn: { x: 480, y: 576, dir: "up" } }),
  Object.freeze({ destination: "museum-room-2", x: 336, y: 0, width: 96, height: 72, label: "Gallery 2", spawn: { x: 480, y: 576, dir: "up" } }),
  Object.freeze({ destination: "museum-room-3", x: 528, y: 0, width: 96, height: 72, label: "Gallery 3", spawn: { x: 480, y: 576, dir: "up" } }),
  Object.freeze({ destination: "museum-room-4", x: 720, y: 0, width: 96, height: 72, label: "Gallery 4", spawn: { x: 480, y: 576, dir: "up" } }),
]);
const MUSEUM_FOYER_WALLS = Object.freeze([
  { x: 0, y: 0, width: 144, height: 48 },
  { x: 240, y: 0, width: 96, height: 48 },
  { x: 432, y: 0, width: 96, height: 48 },
  { x: 624, y: 0, width: 96, height: 48 },
  { x: 816, y: 0, width: 144, height: 48 },
  { x: 0, y: 0, width: 48, height: 720 },
  { x: 912, y: 0, width: 48, height: 720 },
  { x: 0, y: 672, width: 408, height: 48 },
  { x: 552, y: 672, width: 408, height: 48 },
]);
const MUSEUM_GALLERY_WALLS = Object.freeze([
  { x: 0, y: 0, width: 960, height: 48 },
  { x: 0, y: 0, width: 48, height: 720 },
  { x: 912, y: 0, width: 48, height: 720 },
  { x: 0, y: 672, width: 408, height: 48 },
  { x: 552, y: 672, width: 408, height: 48 },
]);
const museumGalleryGeometry = (id) => commercialRoomGeometry(id, {
  blockers: [...MUSEUM_GALLERY_WALLS, { x: 384, y: 286, width: 192, height: 96 }],
  doors: [{
    destination: "museum", x: 408, y: 648, width: 144, height: 72, label: "Foyer",
    spawn: { x: ({ "museum-room-1": 192, "museum-room-2": 384, "museum-room-3": 576, "museum-room-4": 768 })[id], y: 96, dir: "down" },
  }],
  seats: [],
});

// This is the shared world contract for the client map and server validator.
// Every facade below has a matching explicit collider.  The narrow gaps are
// intentional paved doorways, never visual-only entrances.
const BASE_LOCATION_GEOMETRY = Object.freeze({
  office: { blockers: [], doors: [] },
  neighborhood: {
    // Street houses, colliders, and front doors are generated from the
    // approved-account snapshot in streetDefinition(), not duplicated here.
    blockers: [], doors: [], seats: [],
  },
  city: {
    blockers: [
      // Every visible facade is generated from the same venue contract used by
      // the city renderer.  Each 72px opening is left clear for its threshold.
      ...CITY_PLAZA_LAYOUT.shops.flatMap((shop) => shop.blockers),
      ...CITY_PLAZA_LAYOUT.museum.blockers,
    ],
    doors: [
      ...CITY_PLAZA_LAYOUT.shops.map((shop) => ({
        destination: shop.id, ...shop.door, label: shop.label,
      })),
      { destination: "museum", ...CITY_PLAZA_LAYOUT.museum.door, label: "Huddle Museum",
        spawn: CITY_COMMERCIAL_LAYOUT.museum.museumSpawn },
    ],
    seats: [
      // Benches repeat across the paved gathering square. Their authored
      // stands remain on open paving, not in a facade or a path edge.
      { id: "plaza-bench-northwest", x: 720, y: 640, dir: "down",
        stands: [{ x: 720, y: 704, dir: "down" }, { x: 656, y: 640, dir: "down" }] },
      { id: "plaza-bench-north", x: 1520, y: 640, dir: "down",
        stands: [{ x: 1520, y: 704, dir: "down" }, { x: 1456, y: 640, dir: "down" }] },
      { id: "plaza-bench-south", x: 2320, y: 640, dir: "down",
        stands: [{ x: 2320, y: 704, dir: "down" }, { x: 2256, y: 640, dir: "down" }] },
      { id: "plaza-bench-northeast", x: 3120, y: 640, dir: "down",
        stands: [{ x: 3120, y: 704, dir: "down" }, { x: 3056, y: 640, dir: "down" }] },
      { id: "plaza-bench-southwest", x: 720, y: 896, dir: "up",
        stands: [{ x: 720, y: 832, dir: "up" }, { x: 656, y: 896, dir: "up" }] },
      { id: "plaza-bench-south-center", x: 1520, y: 896, dir: "up",
        stands: [{ x: 1520, y: 832, dir: "up" }, { x: 1456, y: 896, dir: "up" }] },
      { id: "plaza-bench-east", x: 2320, y: 896, dir: "up",
        stands: [{ x: 2320, y: 832, dir: "up" }, { x: 2256, y: 896, dir: "up" }] },
      { id: "plaza-bench-southeast", x: 3120, y: 896, dir: "up",
        stands: [{ x: 3120, y: 832, dir: "up" }, { x: 3056, y: 896, dir: "up" }] },
    ],
    // The renderer consumes these same footprints, keeping museum and shop
    // facades discoverable in the serialized transition payload.
    commercialExteriors: {
      gatheringSquare: CITY_PLAZA_LAYOUT.gatheringSquare,
      venues: CITY_PLAZA_LAYOUT.venues,
    },
  },
  museum: commercialRoomGeometry("museum", {
    blockers: [...MUSEUM_FOYER_WALLS],
    doors: [
      ...MUSEUM_FOYER_DOORS,
      { destination: "city", x: 408, y: 648, width: 144, height: 72, label: "Plaza exit",
        spawn: CITY_COMMERCIAL_LAYOUT.museum.citySpawn },
    ],
    seats: [],
    rooms: [
      { id: "museum", label: "Foyer", x: 48, y: 48, width: 864, height: 624 },
      { id: "museum-room-1", label: "Gallery 1", x: 144, y: 0, width: 96, height: 72 },
      { id: "museum-room-2", label: "Gallery 2", x: 336, y: 0, width: 96, height: 72 },
      { id: "museum-room-3", label: "Gallery 3", x: 528, y: 0, width: 96, height: 72 },
      { id: "museum-room-4", label: "Gallery 4", x: 720, y: 0, width: 96, height: 72 },
    ],
  }),
  "museum-room-1": museumGalleryGeometry("museum-room-1"),
  "museum-room-2": museumGalleryGeometry("museum-room-2"),
  "museum-room-3": museumGalleryGeometry("museum-room-3"),
  "museum-room-4": museumGalleryGeometry("museum-room-4"),
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

// Keep the existing architecture walls above, but source every commercial
// venue's movable blockers/seats from the shared design manifest.
const COMMERCIAL_VENUE_IDS = Object.freeze([
  "furniture-shop", "garden-shop", "decor-shop", "cafe", "diner", "bakery", "sushi",
]);
export const LOCATION_GEOMETRY = Object.freeze({
  ...BASE_LOCATION_GEOMETRY,
  ...Object.fromEntries(COMMERCIAL_VENUE_IDS.map((id) => [
    id, commercialRoomGeometry(id, BASE_LOCATION_GEOMETRY[id]),
  ])),
});

// Fixed, authored cashiers for the seven commercial rooms. These are map
// actors, not player accounts: their identity, appearance, and stand point are
// part of the shared room contract consumed by both the server and renderer.
// Keep the points in the open floor in front of the existing displays.
export const COMMERCIAL_CASHIERS = Object.freeze({
  "furniture-shop": Object.freeze({
    id: "cashier:furniture-shop", location: "furniture-shop",
    name: "Mara", character: "amelia", x: 480, y: 340, radius: 116,
    greeting: "Welcome to Huddle Home! Take a look around.",
    info: "Furniture for making your home feel like yours.",
    kind: "furniture",
  }),
  "garden-shop": Object.freeze({
    id: "cashier:garden-shop", location: "garden-shop",
    name: "Willow", character: "alex", x: 480, y: 580, radius: 116,
    greeting: "Hi there! Looking to bring a little green home?",
    info: "Plants and calm corners for your home.",
    kind: "furniture",
  }),
  "decor-shop": Object.freeze({
    id: "cashier:decor-shop", location: "decor-shop",
    name: "Pip", character: "bob", x: 480, y: 580, radius: 116,
    greeting: "Welcome in! Find something that brightens your space.",
    info: "Decorative pieces and cozy finishing touches.",
    kind: "furniture",
  }),
  cafe: Object.freeze({
    id: "cashier:cafe", location: "cafe",
    name: "Nia", character: "amelia", x: 760, y: 180, radius: 116,
    greeting: "Welcome to the cafe! What can I get started for you?",
    info: "Fresh drinks and small treats, served all day.",
    kind: "food", menuKey: "cafe",
  }),
  diner: Object.freeze({
    id: "cashier:diner", location: "diner",
    name: "Jo", character: "adam", x: 800, y: 450, radius: 116,
    greeting: "Hey! Pull up a chair and check out today's specials.",
    info: "Classic diner favorites, made for a quick bite.",
    kind: "food", menuKey: "diner",
  }),
  bakery: Object.freeze({
    id: "cashier:bakery", location: "bakery",
    name: "Crumb", character: "alex", x: 800, y: 400, radius: 116,
    greeting: "Hello! Something warm from the oven sounds good, right?",
    info: "Breads, pastries, and sweet things to share.",
    kind: "food", menuKey: "bakery",
  }),
  sushi: Object.freeze({
    id: "cashier:sushi", location: "sushi",
    name: "Sora", character: "bob", x: 800, y: 400, radius: 116,
    greeting: "Irasshaimase! Welcome to Sakura Sushi.",
    info: "Fresh rolls and bowls prepared with care.",
    kind: "food", menuKey: "sushi",
  }),
});

export function commercialCashier(locationId, cashierId) {
  const cashier = COMMERCIAL_CASHIERS[locationId];
  return cashier && typeof cashierId === "string" && cashier.id === cashierId ? cashier : null;
}

// The only allowed map links. `spawn` is selected by the server based on the
// source portal, not supplied by a browser.
export const LOCATION_PORTALS = Object.freeze({
  // The Willow Walk gate sits in the west garden's highlighted orange
  // clearing (map tiles c4-c5 / r46-r48), not at the old south-west edge.
  // Keep the trigger centered in the clearing; the client opens the matching
  // narrow c4-c7 / r46-r48 approach after its map-wide Wall collision pass.
  office: [{ destination: "neighborhood", x: 192, y: 2208, width: 96, height: 144, label: "Willow Walk", spawn: { x: 144, y: 504, dir: "right" } }],
  neighborhood: [
    // HQ Garden is the west end of Willow Walk's main horizontal road. It
    // stays west of the first residential lot. City gates are generated from
    // the current rectangular street grid below, never from this fixed list.
    // Enter just east of the new clearing gate; the point is outside the
    // trigger until the player walks west into the doorway.
    { destination: "office", x: 0, y: 432, width: 96, height: 144, label: "HQ Garden", spawn: { x: 312, y: 2280, dir: "right" } },
  ],
  city: [
    { destination: "neighborhood", x: 0, y: 888, width: 96, height: 144, spawn: { x: 1248, y: 504, dir: "left" } },
    ...CITY_PLAZA_LAYOUT.shops.map((shop) => ({
      destination: shop.id, ...shop.door,
      spawn: { x: 480, y: 576, dir: "up" },
    })),
    { destination: "museum", ...CITY_COMMERCIAL_LAYOUT.museum.door, spawn: CITY_COMMERCIAL_LAYOUT.museum.museumSpawn },
  ],
  "furniture-shop": [{ destination: "city", x: 408, y: 648, width: 144, height: 72, spawn: CITY_PLAZA_SHOP_BY_ID["furniture-shop"].citySpawn }],
  "garden-shop": [{ destination: "city", x: 408, y: 648, width: 144, height: 72, spawn: CITY_PLAZA_SHOP_BY_ID["garden-shop"].citySpawn }],
  "decor-shop": [{ destination: "city", x: 408, y: 648, width: 144, height: 72, spawn: CITY_PLAZA_SHOP_BY_ID["decor-shop"].citySpawn }],
  cafe: [{ destination: "city", x: 408, y: 648, width: 144, height: 72, spawn: CITY_PLAZA_SHOP_BY_ID.cafe.citySpawn }],
  diner: [{ destination: "city", x: 408, y: 648, width: 144, height: 72, spawn: CITY_PLAZA_SHOP_BY_ID.diner.citySpawn }],
  bakery: [{ destination: "city", x: 408, y: 648, width: 144, height: 72, spawn: CITY_PLAZA_SHOP_BY_ID.bakery.citySpawn }],
  sushi: [{ destination: "city", x: 408, y: 648, width: 144, height: 72, spawn: CITY_PLAZA_SHOP_BY_ID.sushi.citySpawn }],
  museum: [
    ...MUSEUM_FOYER_DOORS,
    { destination: "city", x: 408, y: 648, width: 144, height: 72, label: "Plaza exit", spawn: CITY_COMMERCIAL_LAYOUT.museum.citySpawn },
  ],
  "museum-room-1": [{ destination: "museum", x: 408, y: 648, width: 144, height: 72, label: "Foyer", spawn: { x: 192, y: 96, dir: "down" } }],
  "museum-room-2": [{ destination: "museum", x: 408, y: 648, width: 144, height: 72, label: "Foyer", spawn: { x: 384, y: 96, dir: "down" } }],
  "museum-room-3": [{ destination: "museum", x: 408, y: 648, width: 144, height: 72, label: "Foyer", spawn: { x: 576, y: 96, dir: "down" } }],
  "museum-room-4": [{ destination: "museum", x: 408, y: 648, width: 144, height: 72, label: "Foyer", spawn: { x: 768, y: 96, dir: "down" } }],
  home: [{ destination: "neighborhood", x: 528, y: 768, width: 96, height: 96, label: "Willow Walk exit", spawn: { x: 144, y: 504, dir: "right" } }],
});

// Catalog art is authored in a 16px grid, then presented at an integer scale.
// `path` is the public URL consumed by furniture-renderer.js. `asset` remains
// the legacy logical key so old saved instances and older clients keep working.
// The six original living-room ids are intentionally retained verbatim; rows
// in jpo_home_furniture refer to those ids and must never be renamed.
const furniture = ({
  id, name, price, category, path, width = 1, height = 1,
  frameWidth = 16, frameHeight = 16, frameCount = 1, frameRate = 0,
  initialFrame = 0, scale = 3, rotations = [0], actions = [], interaction, actionInteractions,
  activityPose, occluder, origin, movementBlockerOffset, depthOffset, asset = id, anchor = "bottom-center", color = "#8d6e52",
}) => ({
  id, name, price, category, path, publicPath: path, assetPath: path, asset, scale, rotations,
  width, height, footprint: { width, height }, anchor, color,
  frames: { frameWidth, frameHeight, frameCount, frameRate, initialFrame, loop: frameCount > 1 },
  ...(actions.length ? { actions } : {}),
  ...(interaction ? { interaction } : {}),
  ...(actionInteractions ? { actionInteractions } : {}),
  ...(activityPose ? { activityPose } : {}),
  ...(occluder ? { occluder } : {}),
  ...(origin ? { origin } : {}),
  ...(movementBlockerOffset ? { movementBlockerOffset } : {}),
  ...(depthOffset !== undefined ? { depthOffset } : {}),
});

export const FURNITURE_CATALOG = Object.freeze({
  // Living — supplied individual silhouettes (not recoloured substitutes).
  oak_chair: furniture({
    id: "oak_chair", name: "Gold armchair", price: 5000, category: "Living",
    // A fresh immutable URL is deliberate: the prior oak_chair.png points at
    // a firewood rack and is cached by production clients for 24 hours.
    path: "/assets/neighborhood/furniture/gold_armchair.png", frameWidth: 16, frameHeight: 32,
    asset: "oak_chair", actions: ["sit"], interaction: { facing: "down" }, color: "#b98743",
    actionInteractions: {
      // Use the shared sit pivot; the cushion must remain behind the actor.
      sit: { actorOffset: { x: 0, y: -26 } },
    },
    activityPose: {
      sit: { angle: 0, scale: 3, wearableOffset: { x: 0, y: -10 } },
    },
    // Source rows 19–31 are the real front cushion/legs, so they occlude
    // only the lower sitter rather than putting the entire avatar behind it.
    occluder: { default: { fromPx: 28, depthBias: 0.01 } },
  }),
  fern: furniture({
    id: "fern", name: "Potted fern", price: 5000, category: "Living",
    path: "/assets/neighborhood/furniture/fern.png", frameWidth: 16, frameHeight: 48,
    color: "#4f9253",
  }),
  reading_lamp: furniture({
    id: "reading_lamp", name: "Coral floor lamp", price: 8000, category: "Living",
    path: "/assets/neighborhood/furniture/reading_lamp.png", frameWidth: 16, frameHeight: 48,
    color: "#d7634b",
  }),
  coffee_table: furniture({
    id: "coffee_table", name: "Plum low table", price: 12000, category: "Living",
    path: "/assets/neighborhood/furniture/coffee_table.png", width: 2, frameWidth: 32,
    // Six transparent bottom rows are padding, not part of the table's floor.
    // Align its visible feet to the existing floor/collision anchor.
    frameHeight: 32, origin: { x: 0.5, y: 26 / 32 },
    // Arcade collision is anchored at the actor's feet, 27px below player.y.
    // Keep its visual tabletop outside that body without changing placement.
    // Draw sorting must use the same player-pivot coordinates as movement;
    // otherwise a player at the south edge still sorts behind the table.
    movementBlockerOffset: { x: 0, y: -27 }, depthOffset: -27, color: "#74637e",
  }),
  blue_sofa: furniture({
    id: "blue_sofa", name: "Cream lounge sofa", price: 18000, category: "Living",
    path: "/assets/neighborhood/furniture/blue_sofa_full.png", width: 2, frameWidth: 32,
    frameHeight: 32, actions: ["sit", "lie"],
    interaction: { facing: "down", radius: 96 }, color: "#e4c8a1",
    actionInteractions: {
      sit: { actorOffset: { x: 0, y: -34 } },
    },
    activityPose: {
      sit: { angle: 0, scale: 3, wearableOffset: { x: 0, y: -10 } },
      lie: { angle: -90, scale: 2.7, wearableOffset: { x: -30, y: 0 } },
      sleep: { angle: -90, scale: 2.7, wearableOffset: { x: -30, y: 0 } },
    },
    occluder: {
      default: { fromPx: 24, depthBias: 0.01 },
      actions: {
        sit: { fromPx: 24, depthBias: 0.01 },
        lie: { fromPx: 24, depthBias: 0.01 },
      },
    },
  }),
  bookcase: furniture({
    id: "bookcase", name: "Gold bookcase", price: 18000, category: "Living",
    path: "/assets/neighborhood/furniture/bookcase.png", height: 2, frameWidth: 16,
    frameHeight: 32, color: "#a87542",
  }),
  lounge_sofa: furniture({
    id: "lounge_sofa", name: "Ivory reading sofa", price: 25000, category: "Living",
    path: "/assets/neighborhood/furniture/lounge_sofa.png", width: 2, frameWidth: 32,
    frameHeight: 32, actions: ["sit", "lie"], interaction: { facing: "down", radius: 96 },
    actionInteractions: {
      sit: { actorOffset: { x: 0, y: -34 } },
    },
    color: "#f2e0c8",
    activityPose: {
      sit: { angle: 0, scale: 3, wearableOffset: { x: 0, y: -10 } },
      lie: { angle: -90, scale: 2.7, wearableOffset: { x: -30, y: 0 } },
      sleep: { angle: -90, scale: 2.7, wearableOffset: { x: -30, y: 0 } },
    },
    occluder: {
      default: { fromPx: 24, depthBias: 0.01 },
      actions: {
        sit: { fromPx: 24, depthBias: 0.01 },
        lie: { fromPx: 24, depthBias: 0.01 },
      },
    },
  }),
  living_shelf: furniture({
    id: "living_shelf", name: "Tall bookcase", price: 18000, category: "Living",
    path: "/assets/neighborhood/furniture/bookcase.png", height: 2, frameWidth: 16,
    frameHeight: 32, color: "#9a623f",
  }),
  living_lamp: furniture({
    id: "living_lamp", name: "Brass arc lamp", price: 12000, category: "Living",
    path: "/assets/neighborhood/commercial/shop_lamp.png", frameWidth: 16,
    frameHeight: 48, color: "#d7a34c",
  }),
  living_mirror: furniture({
    id: "living_mirror", name: "Tall wall mirror", price: 18000, category: "Living",
    path: "/assets/neighborhood/commercial/shop_mirror.png", frameWidth: 16,
    frameHeight: 48, color: "#8eabc0",
  }),

  // Kitchen — the room-builder's verified appliance tiles plus real animated
  // oven art from the same sprite pack.
  kitchen_counter: furniture({
    id: "kitchen_counter", name: "Oak kitchen counter", price: 12000, category: "Kitchen",
    path: "/assets/neighborhood/furniture/kitchen_counter_full.png", width: 2,
    frameWidth: 32, frameHeight: 32,
  }),
  kitchen_fridge: furniture({
    id: "kitchen_fridge", name: "Grey refrigerator", price: 25000, category: "Kitchen",
    path: "/assets/room-furniture/animated_fridge_grey.png", frameWidth: 32,
    frameHeight: 48, frameCount: 6, frameRate: 2, scale: 3, color: "#8bb8c5",
  }),
  kitchen_sink: furniture({
    id: "kitchen_sink", name: "Porcelain kitchen sink", price: 18000, category: "Kitchen",
    path: "/assets/room-furniture/animated_kitchen_sink_1.png", width: 2, frameWidth: 32,
    frameHeight: 16, frameCount: 3, frameRate: 8,
    actions: ["toggle_water"], interaction: { facing: "down", radius: 88 }, color: "#b9d7dc",
  }),
  kitchen_stove: furniture({
    id: "kitchen_stove", name: "Kitchen range", price: 25000, category: "Kitchen",
    path: "/assets/room-furniture/animated_kitchen_oven.png", frameWidth: 16,
    frameHeight: 32, frameCount: 6,
  }),
  kitchen_oven: furniture({
    id: "kitchen_oven", name: "Open-door oven", price: 35000, category: "Kitchen",
    path: "/assets/room-furniture/animated_kitchen_oven.png", frameWidth: 16,
    frameHeight: 32, frameCount: 6, initialFrame: 3, scale: 3, color: "#b6774c",
  }),
  coffee_machine: furniture({
    id: "coffee_machine", name: "Front-load washer", price: 12000, category: "Bathroom",
    path: "/assets/neighborhood/commercial/cafe_coffee_machine.png", frameWidth: 16,
    frameHeight: 32, color: "#77818f",
  }),
  chef_fridge: furniture({
    id: "chef_fridge", name: "Chef's steel fridge", price: 50000, category: "Kitchen",
    path: "/assets/room-furniture/animated_fridge_grey.png", frameWidth: 32,
    frameHeight: 48, frameCount: 6, frameRate: 2, scale: 3, color: "#a6adb8",
  }),

  // Bedroom — portrait bed art is kept lengthwise so sleep anchors remain
  // compatible with the original one-by-three saved footprint.
  bed: furniture({
    id: "bed", name: "Bedroom bed", price: 35000, category: "Bedroom",
    path: "/assets/neighborhood/interiors/bedroom_bed.png", height: 3,
    frameWidth: 16, frameHeight: 48, asset: "bedroom_bed", actions: ["lie", "sleep"],
    interaction: { facing: "down", radius: 104, orientation: "lengthwise" },
    activityPose: {
      lie: { angle: 0, scale: 2.7, wearableOffset: { x: 0, y: -42 } },
      sleep: { angle: 0, scale: 2.7, wearableOffset: { x: 0, y: -42 } },
    },
    occluder: {
      default: { fromPx: 31, depthBias: 0.01 },
      actions: {
        lie: { fromPx: 31, depthBias: 0.01 },
        sleep: { fromPx: 31, depthBias: 0.01 },
      },
    },
    color: "#9d6d65",
  }),
  plush_bed: furniture({
    id: "plush_bed", name: "Walnut daybed", price: 50000, category: "Bedroom",
    path: "/assets/neighborhood/commercial/furn_bed.png", width: 3, height: 2,
    frameWidth: 144, frameHeight: 144, scale: 1, actions: ["lie", "sleep"],
    // Phaser's positive rotation turns the avatar's head toward the RIGHT,
    // onto the source art's pillow; the art-relative y nudge keeps
    // the body on the mattress instead of the front rail.
    interaction: { facing: "down", radius: 104, actorOffset: { x: 40, y: -20 } },
    activityPose: {
      lie: { angle: 90, scale: 2.7, wearableOffset: { x: 15, y: 0 } },
      sleep: { angle: 90, scale: 2.7, wearableOffset: { x: 15, y: 0 } },
    },
    // Only the authored lower rail is in front of a reclining actor.  The
    // previous generic 62% crop covered the head and most of the body.
    occluder: {
      default: { fromPx: 108, depthBias: 0.01 },
      actions: {
        lie: { fromPx: 108, depthBias: 0.01 },
        sleep: { fromPx: 108, depthBias: 0.01 },
      },
    },
    color: "#8697b5",
  }),
  bedroom_shelf: furniture({
    id: "bedroom_shelf", name: "Gold bedroom bookcase", price: 18000, category: "Bedroom",
    path: "/assets/neighborhood/furniture/bookcase.png", height: 2,
    frameWidth: 16, frameHeight: 32, color: "#8f6245",
  }),
  bedroom_lamp: furniture({
    id: "bedroom_lamp", name: "Bedside lamp", price: 8000, category: "Bedroom",
    path: "/assets/neighborhood/commercial/shop_lamp.png", frameWidth: 16,
    frameHeight: 48, color: "#d7a34c",
  }),
  bedroom_mirror: furniture({
    id: "bedroom_mirror", name: "Dressing mirror", price: 18000, category: "Bedroom",
    path: "/assets/neighborhood/commercial/shop_mirror.png", frameWidth: 16,
    frameHeight: 48, color: "#8eabc0",
  }),
  bedroom_dresser: furniture({
    id: "bedroom_dresser", name: "Blue linen dresser", price: 25000, category: "Bedroom",
    path: "/assets/room-furniture/animated_bathroom_cabinet_blue_empty.png",
    frameWidth: 16, frameHeight: 32, frameCount: 10, frameRate: 0, scale: 3, color: "#7595ae",
  }),

  // Bathroom — all water-capable pieces use actual bath/sink/shower frames.
  bathtub: furniture({
    id: "bathtub", name: "Claw-foot bath", price: 35000, category: "Bathroom",
    path: "/assets/room-furniture/animated_bathtub_2.png", width: 2,
    frameWidth: 32, frameHeight: 48, frameCount: 4, frameRate: 2, scale: 3,
    asset: "animated_bathtub_with_duck", actions: ["shower", "bathe"],
    // The basin sits above the authored front wall.  Keep the avatar's head
    // above that wall while the lower body is cropped by the rim.
    interaction: { facing: "down", radius: 104, actorOffset: { x: 0, y: -70 } },
    activityPose: {
      shower: { angle: 0, scale: 2.4, wearableOffset: { x: 0, y: -4 } },
      bathe: { angle: 0, scale: 2.4, wearableOffset: { x: 0, y: -4 } },
    },
    occluder: {
      default: { fromPx: 24, depthBias: 0.01 },
      actions: {
        shower: { fromPx: 24, depthBias: 0.01 },
        bathe: { fromPx: 24, depthBias: 0.01 },
      },
    },
    color: "#b9d7dc",
  }),
  bathroom_sink: furniture({
    id: "bathroom_sink", name: "Bathroom sink", price: 12000, category: "Bathroom",
    path: "/assets/room-furniture/animated_bathroom_sink_new_3-10%20loop.png", width: 2,
    frameWidth: 32, frameHeight: 32, frameCount: 14, frameRate: 8, scale: 3,
    actions: ["toggle_water"], interaction: { facing: "down", radius: 88 },
    color: "#b9d7dc",
  }),
  bathroom_sink_tap: furniture({
    id: "bathroom_sink_tap", name: "Animated tap sink", price: 25000, category: "Bathroom",
    path: "/assets/room-furniture/animated_bathroom_sink_new_3-10%20loop.png", width: 2,
    frameWidth: 32, frameHeight: 32, frameCount: 14, frameRate: 8, scale: 3,
    actions: ["toggle_water"], interaction: { facing: "down", radius: 88 }, color: "#c2d5dd",
  }),
  bathroom_toilet: furniture({
    id: "bathroom_toilet", name: "Porcelain toilet", price: 12000, category: "Bathroom",
    path: "/assets/neighborhood/interiors/bathroom_toilet.png", height: 3,
    frameWidth: 16, frameHeight: 48, color: "#d5dce1",
  }),
  bathroom_cabinet: furniture({
    id: "bathroom_cabinet", name: "White bathroom cabinet", price: 18000, category: "Bathroom",
    path: "/assets/room-furniture/animated_bathroom_cabinet_white_empty.png",
    frameWidth: 16, frameHeight: 32, frameCount: 10, scale: 3, color: "#e6e8e9",
  }),
  shower: furniture({
    id: "shower", name: "Rain shower", price: 35000, category: "Bathroom",
    path: "/assets/room-furniture/animated_jail_shower_4-8%20loop.png",
    frameWidth: 16, frameHeight: 48, frameCount: 11, frameRate: 8, scale: 3,
    actions: ["shower"], interaction: { facing: "down", radius: 96 },
    activityPose: { shower: { angle: 0, scale: 2.7 } },
    occluder: { default: { fromPx: 20, depthBias: 0.01 } },
    color: "#76acd1",
  }),

  // Miscellaneous — accents are still floor-anchored real silhouettes, not
  // generated rectangles. They can be placed indoors or in the yard.
  floor_rug: furniture({
    id: "floor_rug", name: "Lavender ottoman", price: 12000, category: "Living",
    path: "/assets/neighborhood/commercial/shop_rug.png", width: 2, height: 2,
    frameWidth: 32, frameHeight: 32, scale: 3, color: "#9a8fc0",
    actions: ["sit"], interaction: { facing: "down", radius: 96 },
    occluder: { default: { fromPx: 27, depthBias: 0.01 } },
  }),
  plant_palm: furniture({
    id: "plant_palm", name: "Garden topiary", price: 18000, category: "Miscellaneous",
    path: "/assets/neighborhood/commercial/garden_tree.png", width: 2, height: 2,
    frameWidth: 96, frameHeight: 96, scale: 1, color: "#579b68",
  }),
  plant_small: furniture({
    id: "plant_small", name: "Window pot", price: 8000, category: "Miscellaneous",
    path: "/assets/neighborhood/commercial/shop_plant_small.png", frameWidth: 16,
    frameHeight: 32, color: "#579b68",
  }),
  wall_art: furniture({
    id: "wall_art", name: "Framed print", price: 25000, category: "Miscellaneous",
    path: "/assets/neighborhood/commercial/decor_art.png", width: 2, height: 2,
    frameWidth: 96, frameHeight: 96, scale: 1, color: "#c29d63",
  }),
  planter: furniture({
    id: "planter", name: "Potted plant", price: 8000, category: "Miscellaneous",
    path: "/assets/neighborhood/commercial/garden_pot.png", height: 2,
    frameWidth: 16, frameHeight: 32, color: "#c27550",
  }),
  tv: furniture({
    id: "tv", name: "Animated television", price: 35000, category: "Miscellaneous",
    path: "/assets/room-furniture/animated_old_tv.png", frameWidth: 32,
    frameHeight: 32, frameCount: 6, frameRate: 6, scale: 3, actions: ["watch"],
    interaction: { anchor: "front", facing: "up", radius: 96 }, color: "#4c536e",
  }),
  television: furniture({
    id: "television", name: "Television", price: 35000, category: "Miscellaneous",
    // The former 256x224 packed sheet began with a rocket fragment. Use the
    // verified six-frame CRT instead while retaining the legacy id/asset.
    path: "/assets/room-furniture/animated_old_tv.png", frameWidth: 32,
    frameHeight: 32, frameCount: 6, frameRate: 6, scale: 3, asset: "TV_Studio_16x16",
    actions: ["watch"], interaction: { anchor: "front", facing: "up", radius: 96 },
    color: "#4c536e",
  }),
});

export function parseLocation(value) {
  if (["office", "neighborhood", "city", "cafe", "diner", "bakery", "sushi",
    "museum", "museum-room-1", "museum-room-2", "museum-room-3", "museum-room-4"].includes(value)
      || isShopLocation(value)) return { id: value, kind: value };
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
    portal.destination === targetKind && pointHitsRect(x, y, portal, ACTOR_FOOT_RADIUS)) || null;
}

export function locationBounds(location) {
  if (location.kind === "home") return { width: HOME_GRID.width * HOME_GRID.cell, height: HOME_GRID.height * HOME_GRID.cell };
  // Huddle Plaza is intentionally the fixed 3600x1920 plaza. Residential
  // sparse blocks return through its single west gate rather than extending
  // this map or reusing the street field.
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
    const pivot = location?.id === "city"
      ? CITY_GATHERING_SQUARE.y + CITY_GATHERING_SQUARE.height / 2
      : (Number(locationBounds(location)?.height) || 0) / 2;
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

// Movement packets are normally only a few pixels apart, but checking the
// complete segment prevents a forged frame (or a lag catch-up) from tunnelling
// through a 30px prop or a doorway wall.
function continuousSamples(x0, y0, x1, y1, isValid) {
  if (![x0, y0, x1, y1].every(Number.isFinite)) return false;
  const distance = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(distance / 8));
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    if (!isValid(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
  }
  return true;
}
export function validContinuousStreetWorldMove(street, x0, y0, x1, y1, dynamicBlockers = []) {
  return continuousSamples(x0, y0, x1, y1,
    (x, y) => validStreetWorldMove(street, x, y, dynamicBlockers));
}
export function validContinuousLocationMove(location, x0, y0, x1, y1, dynamicBlockers = []) {
  return continuousSamples(x0, y0, x1, y1,
    (x, y) => validLocationMove(location, x, y, dynamicBlockers));
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
    const movementOffset = item.movementBlockerOffset || {};
    const offsetX = Number.isFinite(Number(movementOffset.x)) ? Number(movementOffset.x) : 0;
    const offsetY = Number.isFinite(Number(movementOffset.y)) ? Number(movementOffset.y) : 0;
    return [{ x: placed.gridX * HOME_GRID.cell + offsetX, y: placed.gridY * HOME_GRID.cell + offsetY,
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
  // Snapshot reads must be side-effect free. In particular, a Store request
  // may be accompanied by an older/partially migrated layout; repairing every
  // row while reading one item can make an unrelated placement disappear.
  // Callers that explicitly run a migration can still invoke
  // repairLegacyLayout() before requesting a snapshot.
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
