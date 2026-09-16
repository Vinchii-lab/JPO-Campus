// Bounded audit for the supported furniture paths not covered by the earlier
// chair/daybed/bath/showroom pass.  This stays database- and browser-free:
// shared geometry proves the approach/exit contract, while a small Phaser-like
// renderer double proves that authoritative activity packets drive real sheet
// animations and reset them on stop.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

import {
  FURNITURE_CATALOG,
  HOME_GRID,
  furnitureFootprint,
  layoutBlockers,
  parseLocation,
  pointHitsRect,
  validContinuousLocationMove,
  validLocationMove,
  validPlacement,
} from "../../neighborhood.mjs";
import {
  FURNITURE_ACTIONS,
  furnitureActionAnchor,
  furnitureActionDefinitions,
  furnitureActionPathClear,
  furnitureActionStandCandidates,
} from "../../furniture-actions.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererSource = fs.readFileSync(
  path.join(here, "../../public/furniture-renderer.js"), "utf8",
);
const rendererContext = {
  Phaser: { Textures: { FilterMode: { NEAREST: 1 } } },
  console,
};
rendererContext.globalThis = rendererContext;
vm.runInNewContext(rendererSource, rendererContext, {
  filename: "furniture-renderer.js",
});
const renderer = rendererContext.HomeFurnitureRenderer;
assert.ok(renderer, "furniture renderer installs its shared contract");

function opaquePngBounds(file) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a",
    "source art is a PNG");
  let offset = 8;
  let header = null;
  let palette = null;
  let transparency = null;
  const compressed = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") header = {
      width: data.readUInt32BE(0), height: data.readUInt32BE(4),
      bitDepth: data[8], colorType: data[9], interlace: data[12],
    };
    else if (type === "PLTE") palette = data;
    else if (type === "tRNS") transparency = data;
    else if (type === "IDAT") compressed.push(data);
    else if (type === "IEND") break;
  }
  assert.deepEqual(
    { width: header?.width, height: header?.height, bitDepth: header?.bitDepth,
      colorType: header?.colorType, interlace: header?.interlace },
    { width: 32, height: 32, bitDepth: 8, colorType: 3, interlace: 0 },
    "coffee-table source remains the authentic non-interlaced indexed 32×32 PNG",
  );
  assert.ok(palette?.length && transparency?.length, "coffee-table source retains palette alpha");
  const raw = inflateSync(Buffer.concat(compressed));
  const rows = [];
  let cursor = 0;
  let prior = new Uint8Array(header.width);
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[cursor++];
    const row = Uint8Array.from(raw.subarray(cursor, cursor + header.width));
    cursor += header.width;
    for (let x = 0; x < row.length; x += 1) {
      const left = x ? row[x - 1] : 0;
      const above = prior[x];
      const upperLeft = x ? prior[x - 1] : 0;
      if (filter === 1) row[x] = (row[x] + left) & 0xff;
      else if (filter === 2) row[x] = (row[x] + above) & 0xff;
      else if (filter === 3) row[x] = (row[x] + Math.floor((left + above) / 2)) & 0xff;
      else if (filter === 4) {
        const p = left + above - upperLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - above), pc = Math.abs(p - upperLeft);
        row[x] = (row[x] + (pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft)) & 0xff;
      } else assert.equal(filter, 0, "coffee-table PNG has a supported scanline filter");
    }
    rows.push(row);
    prior = row;
  }
  let minX = header.width, minY = header.height, maxX = -1, maxY = -1;
  rows.forEach((row, y) => row.forEach((index, x) => {
    if ((transparency[index] ?? 255) === 0) return;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }));
  return { minX, minY, maxX, maxY, width: header.width, height: header.height };
}

const coffeeTable = FURNITURE_CATALOG.coffee_table;
const coffeeTableArt = opaquePngBounds(path.join(
  here, "../../public/assets/neighborhood/furniture/coffee_table.png",
));
assert.deepEqual(coffeeTableArt, {
  minX: 1, minY: 8, maxX: 30, maxY: 25, width: 32, height: 32,
}, "Plum low table alpha bounds expose its six transparent bottom padding rows");
assert.deepEqual(coffeeTable.origin, { x: 0.5, y: 26 / 32 },
  "Plum low table anchors immediately below its last opaque source-art row");
assert.equal(coffeeTable.origin.y * coffeeTableArt.height, coffeeTableArt.maxY + 1,
  "Plum low table's visual floor aligns to actual alpha, not transparent padding");
assert.equal(coffeeTable.depthOffset, -27,
  "Plum low table separates its visual floor anchor from its y-sort depth");
assert.deepEqual(furnitureFootprint(coffeeTable, 0), { width: 2, height: 1 },
  "Plum low table preserves its existing 2×1 collision/layout footprint");
assert.deepEqual(coffeeTable.movementBlockerOffset, { x: 0, y: -27 },
  "Plum low table shifts only its movement blocker to the actor-foot coordinate system");
assert.deepEqual(layoutBlockers([{
  furnitureId: "coffee_table", gridX: 14, gridY: 10, rotation: 0,
}])[0], {
  x: 672, y: 453, width: 96, height: 48, furnitureId: "coffee_table",
}, "Plum low table movement rectangle aligns its visual table top at y=453..501");
for (const [furnitureId, gridX, gridY] of [
  ["oak_chair", 13, 14],
  ["blue_sofa", 14, 8],
]) {
  const definition = FURNITURE_CATALOG[furnitureId];
  const footprint = furnitureFootprint(definition, 0);
  assert.equal(definition.movementBlockerOffset, undefined,
    `${furnitureId} retains its existing movement-blocker policy`);
  assert.deepEqual(layoutBlockers([{ furnitureId, gridX, gridY, rotation: 0 }])[0], {
    x: gridX * HOME_GRID.cell, y: gridY * HOME_GRID.cell,
    width: footprint.width * HOME_GRID.cell, height: footprint.height * HOME_GRID.cell,
    furnitureId,
  }, `${furnitureId} movement rectangle remains its unshifted footprint`);
}

const remainingActions = Object.freeze({
  kitchen_sink: ["toggle_water"],
  bathroom_sink: ["toggle_water"],
  bathroom_sink_tap: ["toggle_water"],
  shower: ["shower"],
  tv: ["watch"],
  television: ["watch"],
  bed: ["sleep"],
  plush_bed: ["sleep"],
  blue_sofa: ["lie"],
  lounge_sofa: ["lie"],
  floor_rug: ["sit"],
});

for (const [furnitureId, actionIds] of Object.entries(remainingActions)) {
  const definition = FURNITURE_CATALOG[furnitureId];
  assert.ok(definition, `${furnitureId} remains in the production catalog`);
  const actions = furnitureActionDefinitions(definition);
  assert.deepEqual(
    actions.map((action) => action.id),
    definition.actions,
    `${furnitureId} exposes normalized action metadata`,
  );
  for (const actionId of actionIds) {
    const action = actions.find((entry) => entry.id === actionId);
    assert.ok(action, `${furnitureId}/${actionId} has an allow-listed action`);
    assert.equal(action.id in FURNITURE_ACTIONS, true);
    assert.ok(Number(action.radius) > 0, `${furnitureId}/${actionId} has an interaction radius`);
  }
}

const home = parseLocation("home:remaining-actions@example.com");
const focusPlacements = [
  ["kitchen_sink", 13, 1, "toggle_water"],
  ["bathroom_sink", 1, 11, "toggle_water"],
  ["bathroom_sink_tap", 7, 11, "toggle_water"],
  ["shower", 8, 15, "shower"],
  ["tv", 13, 4, "watch"],
  ["television", 15, 4, "watch"],
  ["bed", 2, 1, "sleep"],
  ["plush_bed", 6, 2, "sleep"],
  ["blue_sofa", 14, 8, "lie"],
  ["lounge_sofa", 17, 8, "lie"],
  ["floor_rug", 14, 10, "sit"],
];

// Prove both sides of each interaction: a valid stand is reachable from an
// authored walkable point, and the direct approach cannot tunnel through a
// divider.  The target footprint is excluded exactly as server admission does.
for (const [furnitureId, gridX, gridY, actionId] of focusPlacements) {
  const definition = FURNITURE_CATALOG[furnitureId];
  const placed = { ...definition, rotation: 0 };
  assert.equal(
    validPlacement(definition, gridX, gridY, 0, []),
    true,
    `${furnitureId}/${actionId} focus placement is legal in an empty home`,
  );
  const targetBlock = layoutBlockers([{
    furnitureId, gridX, gridY, rotation: 0, id: `${furnitureId}-focus`,
  }])[0];
  assert.ok(targetBlock, `${furnitureId}/${actionId} has a collision footprint`);
  const anchor = furnitureActionAnchor(placed, gridX, gridY, HOME_GRID.cell, actionId);
  const stands = furnitureActionStandCandidates(
    placed, gridX, gridY, HOME_GRID.cell, actionId,
  );
  const otherBlocks = [];
  assert.equal(
    validLocationMove(home, anchor.x, anchor.y, otherBlocks),
    true,
    `${furnitureId}/${actionId} anchor is walkable once its own body is excluded`,
  );
  const validStands = stands.filter((stand) =>
    validLocationMove(home, stand.x, stand.y, otherBlocks) &&
    furnitureActionPathClear(
      stand, anchor,
      (x, y) => validLocationMove(home, x, y, otherBlocks),
    ),
  );
  assert.ok(validStands.length, `${furnitureId}/${actionId} has a clear approach and exit`);
  const stand = validStands[0];
  assert.equal(
    validContinuousLocationMove(home, stand.x, stand.y, anchor.x, anchor.y, otherBlocks),
    true,
    `${furnitureId}/${actionId} stand-to-anchor segment is continuous`,
  );
  assert.equal(
    validLocationMove(home, stand.x, stand.y, [targetBlock]),
    true,
    `${furnitureId}/${actionId} exit stand remains outside its target body`,
  );
  if (pointHitsRect(anchor.x, anchor.y, targetBlock)) {
    assert.equal(
      validLocationMove(home, anchor.x, anchor.y, [targetBlock]),
      false,
      `${furnitureId}/${actionId} retains actor-radius exclusion at its target anchor`,
    );
  }
}

const tvDefinition = { ...FURNITURE_CATALOG.television, rotation: 0 };
const tvAnchor = furnitureActionAnchor(tvDefinition, 13, 5, HOME_GRID.cell, "watch");
assert.equal(tvAnchor.dir, "up", "TV viewer faces the screen");
assert.ok(
  tvAnchor.y > (5 + FURNITURE_CATALOG.television.height) * HOME_GRID.cell,
  "TV watch anchor remains outside the TV body",
);
assert.equal(
  furnitureActionPathClear(
    { x: 464, y: tvAnchor.y }, tvAnchor,
    (x, y) => validLocationMove(home, x, y),
  ),
  false,
  "a TV approach through the room divider is rejected despite distance",
);

class FakeDisplayObject {
  constructor(x, y, textureKey, frameIndex = 0, animated = false) {
    this.x = x;
    this.y = y;
    this.texture = { key: textureKey };
    this.frame = { index: frameIndex };
    this.scaleX = this.scaleY = 1;
    this.angle = 0;
    this.depth = 0;
    this.visible = true;
    this.data = new Map();
    this.destroyed = false;
    this.anims = animated ? {
      isPlaying: false,
      currentAnim: null,
      play: (key) => {
        this.anims.currentAnim = { key };
        this.anims.isPlaying = true;
        return this;
      },
      stop: () => {
        this.anims.isPlaying = false;
        return this;
      },
    } : null;
  }
  setData(key, value) { this.data.set(key, value); return this; }
  getData(key) { return this.data.get(key); }
  setOrigin(x, y) { this.originX = x; this.originY = y; return this; }
  setScale(x, y = x) { this.scaleX = x; this.scaleY = y; return this; }
  setAngle(value) { this.angle = value; return this; }
  setFlipX(value) { this.flipX = value; return this; }
  setFlipY(value) { this.flipY = value; return this; }
  setCrop(...args) { this.crop = args; return this; }
  setDepth(value) { this.depth = value; return this; }
  setFrame(value) { this.frame = { index: value }; return this; }
  play(key) { this.anims?.play?.(key); return this; }
  stop() { this.anims?.stop?.(); return this; }
  once(_event, handler) { this.destroyHandler = handler; return this; }
  destroy() {
    this.destroyed = true;
    this.destroyHandler?.();
  }
}

function makeScene() {
  const animations = new Map();
  const textures = new Map();
  const scene = {
    textures: {
      get: (key) => textures.get(key) || {
        setFilter() {},
        getSourceImage: () => ({ width: 256, height: 256 }),
      },
      exists: (key) => textures.has(key),
    },
    anims: {
      exists: (key) => animations.has(key),
      generateFrameNumbers: (key, range) =>
        Array.from({ length: range.end - range.start + 1 }, (_, index) => ({
          key, index: range.start + index,
        })),
      create: (config) => {
        animations.set(config.key, config);
        return config;
      },
    },
    add: {
      image: (x, y, key) => new FakeDisplayObject(x, y, key),
      sprite: (x, y, key, frame) => new FakeDisplayObject(x, y, key, frame, true),
    },
  };
  return { scene, animations };
}

{
  const { scene } = makeScene();
  const object = renderer.draw(scene, coffeeTable, 720, 528, {
    instanceId: "coffee-table-alpha-floor",
  });
  assert.equal(object.originX, 0.5, "renderer preserves coffee-table horizontal origin");
  assert.equal(object.originY, 26 / 32,
    "renderer honors coffee-table alpha-aligned vertical origin");
  assert.equal(object.y, 528, "renderer keeps the persisted coffee-table floor coordinate");
  assert.equal(object.getData("floorAnchor"), 528,
    "renderer preserves coffee-table physical floor anchor despite depth adjustment");
  assert.equal(object.depth, 501,
    "renderer applies coffee-table depth offset without moving its source art");
  const ghost = renderer.draw(scene, coffeeTable, 720, 528, {
    instanceId: "coffee-table-placement-preview", depth: 25, applyDepthOffset: false,
  });
  assert.equal(ghost.depth, 25,
    "explicit placement-preview depth bypasses coffee-table y-sort offset");
}

const animatedIds = [
  ["kitchen_sink", "toggle_water"],
  ["bathroom_sink", "toggle_water"],
  ["bathroom_sink_tap", "toggle_water"],
  ["shower", "shower"],
  ["tv", "watch"],
  ["television", "watch"],
  ["bathtub", "shower"],
];
for (const [furnitureId, action] of animatedIds) {
  const definition = FURNITURE_CATALOG[furnitureId];
  const { scene, animations } = makeScene();
  const object = renderer.draw(scene, definition, 120, 240, {
    instanceId: `${furnitureId}-animation`,
  });
  assert.ok(object, `${furnitureId} renderer creates a display object`);
  renderer.updateActivity(scene, object, definition, {
    action, effectState: "on",
  });
  assert.equal(object.getData("effectActive"), true, `${furnitureId}/${action} effect is active`);
  assert.equal(object.getData("effect"), action === "watch" ? "tv" : "water");
  assert.equal(object.anims?.isPlaying, true, `${furnitureId}/${action} uses the sheet animation`);
  assert.equal(animations.size, 1, `${furnitureId}/${action} creates one authoritative animation`);
  renderer.updateActivity(scene, object, definition, {
    action, effectState: "off",
  });
  assert.equal(object.getData("effectActive"), false, `${furnitureId}/${action} effect stops`);
  assert.equal(object.anims?.isPlaying, false, `${furnitureId}/${action} animation stops`);
  assert.equal(object.frame.index, definition.frames.initialFrame || 0,
    `${furnitureId}/${action} resets to its inactive frame`);
}

for (const furnitureId of ["bed", "plush_bed", "blue_sofa", "lounge_sofa", "floor_rug"]) {
  const definition = FURNITURE_CATALOG[furnitureId];
  const { scene } = makeScene();
  const object = renderer.draw(scene, definition, 120, 240, {
    instanceId: `${furnitureId}-static`,
  });
  const action = furnitureId.includes("sofa") ? "lie" :
    furnitureId.includes("bed") ? "sleep" : "sit";
  renderer.updateActivity(scene, object, definition, { action, effectState: "on" });
  assert.equal(object.getData("effectActive"), true, `${furnitureId}/${action} activity is presented`);
  assert.equal(object.anims, null, `${furnitureId}/${action} does not invent a furniture animation`);
  renderer.clearEffect(scene, object);
  assert.equal(object.getData("effectActive"), false, `${furnitureId}/${action} clears cleanly`);
}

console.log(
  `PASS: remaining furniture actions (${Object.keys(remainingActions).length} rows), ` +
  `${focusPlacements.length} collision approaches, and ${animatedIds.length} sheet animations`,
);