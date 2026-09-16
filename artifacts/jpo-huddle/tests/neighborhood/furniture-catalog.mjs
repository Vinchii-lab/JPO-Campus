import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FURNITURE_CATALOG, furnitureFootprint } from "../../neighborhood.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const artifactRoot = path.resolve(here, "../..");
const requiredCategories = ["Kitchen", "Living", "Bedroom", "Bathroom", "Miscellaneous"];
const approvedPriceTiers = new Set([2000, 5000, 8000, 12000, 18000, 25000, 35000, 50000]);
const catalog = Object.values(FURNITURE_CATALOG);

assert.ok(catalog.length >= 25, "the approved home catalog has at least 25 pieces");
for (const category of requiredCategories) {
  assert.ok(catalog.some((item) => item.category === category),
    `catalog has a ${category} section`);
}

const publicFileFor = (assetPath) => {
  const decoded = decodeURIComponent(assetPath);
  if (decoded.startsWith("/assets/room-furniture/")) {
    return path.join(artifactRoot, "../api-server/spritesheets", decoded.slice("/assets/room-furniture/".length));
  }
  return path.join(artifactRoot, "public", decoded.replace(/^\/+/, ""));
};

for (const item of catalog) {
  assert.match(item.path, /^\/assets\//, `${item.id} has a public asset path`);
  const sourceFile = publicFileFor(item.path);
  assert.ok(fs.existsSync(sourceFile), `${item.id} points at a real asset`);
  const sourcePng = fs.readFileSync(sourceFile);
  assert.equal(sourcePng.toString("ascii", 1, 4), "PNG", `${item.id} uses PNG art`);
  const sourceWidth = sourcePng.readUInt32BE(16);
  const sourceHeight = sourcePng.readUInt32BE(20);
  assert.ok(item.frames && item.frames.frameWidth > 0 && item.frames.frameHeight > 0,
    `${item.id} has frame metadata`);
  assert.ok(item.frames.initialFrame >= 0 && item.frames.initialFrame < item.frames.frameCount,
    `${item.id} has an in-range preview frame`);
  assert.ok(item.frames.frameWidth * item.frames.frameCount <= sourceWidth &&
    item.frames.frameHeight <= sourceHeight,
  `${item.id} frame metadata stays within the supplied sheet bounds`);
  assert.ok(item.footprint && item.footprint.width === item.width &&
    item.footprint.height === item.height, `${item.id} has a consistent footprint`);
  assert.equal(item.anchor, "bottom-center", `${item.id} uses the shared floor anchor`);
  assert.ok(requiredCategories.includes(item.category), `${item.id} has an approved category`);
  assert.ok(Number.isInteger(item.price) && approvedPriceTiers.has(item.price),
    `${item.id} is priced in an approved tier`);
  assert.ok(Array.isArray(item.rotations) && item.rotations.length > 0,
    `${item.id} declares supported rotations`);
  for (const rotation of item.rotations) {
    const footprint = furnitureFootprint(item, rotation);
    assert.ok(footprint.width > 0 && footprint.height > 0,
      `${item.id} rotation ${rotation} has a valid footprint`);
  }
}

assert.equal(FURNITURE_CATALOG.oak_chair.id, "oak_chair");
assert.equal(FURNITURE_CATALOG.oak_chair.name, "HQ gold stool",
  "persisted oak_chair identity presents the exact HQ stool");
assert.equal(FURNITURE_CATALOG.oak_chair.path, "/assets/neighborhood/furniture/hq_gold_stool.png",
  "persisted oak_chair identity uses the fresh HQ GID 2231 crop");
assert.deepEqual(
  [FURNITURE_CATALOG.oak_chair.frames.frameWidth, FURNITURE_CATALOG.oak_chair.frames.frameHeight,
    FURNITURE_CATALOG.oak_chair.scale],
  [16, 16, 3],
  "HQ stool preserves its native 16px tile at the HQ 3× scale",
);
assert.equal(FURNITURE_CATALOG.blue_sofa.id, "blue_sofa");
assert.equal(FURNITURE_CATALOG.bed.id, "bed");
assert.equal(FURNITURE_CATALOG.bathtub.id, "bathtub");
assert.equal(FURNITURE_CATALOG.television.id, "television");
assert.equal(FURNITURE_CATALOG.bed.asset, "bedroom_bed",
  "legacy bed asset key remains stable for owned instances");
assert.equal(FURNITURE_CATALOG.bathtub.asset, "animated_bathtub_with_duck",
  "legacy bath asset key remains stable for owned instances");
assert.equal(FURNITURE_CATALOG.television.asset, "TV_Studio_16x16",
  "legacy TV asset key remains stable for owned instances");
assert.equal(FURNITURE_CATALOG.blue_sofa.path, "/assets/neighborhood/furniture/blue_sofa_full.png",
  "legacy sofa id now points at a verified complete sofa silhouette");
assert.equal(FURNITURE_CATALOG.lounge_sofa.path, "/assets/neighborhood/furniture/lounge_sofa.png",
  "second sofa id is not an upright chair masquerading as a sofa");
assert.equal(FURNITURE_CATALOG.kitchen_counter.path, "/assets/neighborhood/furniture/kitchen_counter_full.png");
assert.equal(FURNITURE_CATALOG.kitchen_fridge.frames.frameWidth, 32,
  "fridge animation crops one real 32px frame instead of two appliances");
assert.equal(FURNITURE_CATALOG.bathroom_sink.frames.frameWidth, 32,
  "bathroom sink uses the complete animated sink frame");
assert.equal(FURNITURE_CATALOG.shower.frames.initialFrame, 0,
  "inactive shower must not show running water");
assert.equal(FURNITURE_CATALOG.kitchen_sink.frames.frameWidth, 32,
  "kitchen basin and faucet occupy one complete 32px frame");
for (const id of ["kitchen_oven", "bedroom_dresser", "bathroom_cabinet"]) {
  assert.equal(FURNITURE_CATALOG[id].frames.frameWidth, 16,
    `${id} shows one appliance, not adjacent animation states`);
}

const renderer = fs.readFileSync(path.join(artifactRoot, "public/furniture-renderer.js"), "utf8");
for (const contract of ["HomeFurnitureRenderer", "preload", "draw", "applyEffect", "updateActivity", "clearEffect", "effects"]) {
  assert.match(renderer, new RegExp(`\\b${contract}\\b`), `renderer exposes ${contract}`);
}
assert.doesNotMatch(renderer, /wall_brick|cafe_table/,
  "renderer does not revive the previously misidentified rocket/chair art");

console.log(`PASS: ${catalog.length} verified furniture rows, five categories, and renderer contract`);