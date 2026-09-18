const ASSET_ROOT = "assets/neighborhood/commercial";

const museumAssets = {
  "museum-collection-painting-portrait": "painting-portrait",
  "museum-collection-painting-map": "painting-map",
  "museum-collection-painting-wave-gold": "painting-wave-gold",
  "museum-collection-painting-wave-wood": "painting-wave-wood",
  "museum-collection-painting-landscape-blue": "painting-landscape-blue",
  "museum-collection-painting-landscape-wide": "painting-landscape-wide",
  "museum-collection-display-manuscript": "display-manuscript",
  "museum-collection-display-icon": "display-icon",
  "museum-collection-vase-blue": "vase-blue",
  "museum-collection-vase-rose": "vase-rose",
  "museum-collection-vase-ochre": "vase-ochre",
  "museum-collection-vase-green": "vase-green",
  "museum-collection-butterflies-wide": "butterflies-wide",
  "museum-collection-butterflies-blue": "butterflies-blue",
  "museum-collection-butterflies-red": "butterflies-red",
  "museum-collection-butterflies-tall": "butterflies-tall",
  "museum-collection-plant-palms": "plant-palms",
  "museum-collection-plant-canopy": "plant-canopy",
  "museum-collection-plant-fern": "plant-fern",
  "museum-collection-plant-window": "plant-window",
  "museum-collection-statue-scholar": "statue-scholar",
  "museum-collection-statue-figure-a": "statue-figure-a",
  "museum-collection-statue-figure-b": "statue-figure-b",
  "museum-collection-statue-figure-c": "statue-figure-c",
  "museum-collection-statue-figure-d": "statue-figure-d",
  "museum-collection-artifact-vases-a": "artifact-vases-a",
  "museum-collection-artifact-vases-b": "artifact-vases-b",
  "museum-collection-artifact-idol-a": "artifact-idol-a",
  "museum-collection-artifact-idol-b": "artifact-idol-b",
  "museum-collection-artifact-case-blue": "artifact-case-blue",
  "museum-collection-fossil-triceratops-left": "fossil-triceratops-left",
  "museum-collection-fossil-triceratops-right": "fossil-triceratops-right",
};

const object = (asset, x, y, depth = y, extra = {}) => ({
  asset: `museum-collection-${asset}`,
  x,
  y,
  depth,
  scale: 3,
  ...extra,
});

// A negative depth marks mounted art as a wall prop. Its y remains the bottom
// of the frame, so each complete sprite is hung rather than placed on the floor.
const wallArt = (asset, x, y = 156) => object(asset, x, y, -8500);
const blocker = (x, y, width, height) => ({ x, y, width, height });
const label = (text, x, y) => ({ text, x, y });

const room = (roomLabel, objects, blockers, labels) => ({
  label: roomLabel,
  width: 960,
  height: 720,
  objects,
  blockers,
  seats: [],
  labels,
});

export function applyMuseumLayout(manifest) {
  if (!manifest?.assets || !manifest?.rooms) {
    throw new Error("applyMuseumLayout requires a manifest with assets and rooms");
  }

  for (const [key, file] of Object.entries(museumAssets)) {
    manifest.assets[key] = `${ASSET_ROOT}/museum-collection-${file}.png`;
  }

  manifest.rooms.museum = room(
    "Museum Foyer",
    [
      wallArt("painting-map", 276),
      wallArt("painting-wave-gold", 684),
      object("display-manuscript", 150, 300),
      object("display-icon", 810, 300),
      object("artifact-vases-a", 270, 468),
      object("artifact-case-blue", 690, 468),
      object("statue-scholar", 138, 570),
      object("plant-palms", 822, 570),
    ],
    [
      blocker(102, 258, 96, 42),
      blocker(762, 258, 96, 42),
      blocker(222, 432, 96, 36),
      blocker(642, 432, 96, 36),
      blocker(102, 528, 72, 42),
      blocker(786, 528, 72, 42),
    ],
    [
      label("INFORMATION", 480, 184),
      label("GALLERIES 1–4", 480, 222),
      label("PLAZA EXIT", 480, 630),
    ],
  );

  manifest.rooms["museum-room-1"] = room(
    "Gallery 1 · Art Through Time",
    [
      wallArt("painting-portrait", 108),
      wallArt("painting-map", 252),
      wallArt("painting-wave-gold", 396),
      wallArt("painting-wave-wood", 564),
      wallArt("painting-landscape-blue", 708),
      wallArt("painting-landscape-wide", 852),
      object("display-manuscript", 156, 378),
      object("display-icon", 804, 378),
      object("statue-scholar", 252, 552),
      object("artifact-case-blue", 708, 552),
    ],
    [
      blocker(108, 336, 96, 42),
      blocker(756, 336, 96, 42),
      blocker(216, 510, 72, 42),
      blocker(660, 510, 96, 42),
    ],
    [
      label("PORTRAIT & MAPS", 216, 204),
      label("SEASCAPES", 720, 204),
      label("WORKS ON PAPER", 480, 414),
    ],
  );

  manifest.rooms["museum-room-2"] = room(
    "Gallery 2 · Prehistory",
    [
      object("fossil-triceratops-left", 240, 342),
      object("fossil-triceratops-right", 720, 342),
      object("display-manuscript", 120, 540),
      object("display-icon", 300, 540),
      object("artifact-vases-a", 660, 540),
      object("artifact-case-blue", 840, 540),
    ],
    [
      blocker(120, 300, 240, 42),
      blocker(600, 300, 240, 42),
      blocker(72, 498, 96, 42),
      blocker(252, 498, 96, 42),
      blocker(612, 498, 96, 42),
      blocker(792, 498, 96, 42),
    ],
    [
      label("FOSSIL EXHIBITS", 480, 168),
      label("DISCOVERY CASES", 480, 450),
    ],
  );

  manifest.rooms["museum-room-3"] = room(
    "Gallery 3 · Antiquities",
    [
      object("statue-scholar", 132, 270),
      object("statue-figure-a", 276, 270),
      object("statue-figure-b", 684, 270),
      object("statue-figure-c", 828, 270),
      object("artifact-vases-a", 132, 492),
      object("artifact-vases-b", 276, 492),
      object("vase-blue", 660, 474),
      object("vase-rose", 720, 474),
      object("vase-ochre", 792, 474),
      object("vase-green", 852, 474),
    ],
    [
      blocker(96, 228, 72, 42),
      blocker(240, 228, 72, 42),
      blocker(648, 228, 72, 42),
      blocker(792, 228, 72, 42),
      blocker(96, 450, 72, 42),
      blocker(240, 450, 72, 42),
      blocker(636, 450, 48, 24),
      blocker(696, 450, 48, 24),
      blocker(768, 450, 48, 24),
      blocker(828, 450, 48, 24),
    ],
    [
      label("STONE FIGURES", 480, 156),
      label("VESSELS & IDOLS", 480, 384),
    ],
  );

  manifest.rooms["museum-room-4"] = room(
    "Gallery 4 · Living Collections",
    [
      wallArt("butterflies-wide", 132),
      wallArt("butterflies-blue", 300),
      wallArt("butterflies-red", 480),
      wallArt("butterflies-tall", 660),
      wallArt("butterflies-wide", 828, 156),
      object("plant-palms", 132, 420),
      object("plant-window", 300, 540),
      object("plant-canopy", 660, 540),
      object("plant-fern", 828, 420),
    ],
    [
      blocker(96, 372, 72, 48),
      blocker(270, 504, 60, 36),
      blocker(624, 498, 72, 42),
      blocker(792, 378, 72, 42),
    ],
    [
      label("BUTTERFLIES", 480, 204),
      label("BOTANICAL COLLECTION", 480, 348),
    ],
  );

  return manifest;
}