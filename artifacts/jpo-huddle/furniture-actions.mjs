// Shared, server-authoritative rules for actions on player-placed furniture.
// The browser receives the same metadata in FURNITURE_CATALOG, but all
// validation and occupancy decisions stay on the server.

export const FURNITURE_ACTIONS = Object.freeze({
  sit: Object.freeze({
    id: "sit", label: "Sit", anim: "sit", pose: "sit",
    occupancy: 1, duration: "until_exit", effect: "comfort",
  }),
  lie: Object.freeze({
    id: "lie", label: "Lie down", anim: "lie", pose: "lie",
    occupancy: 1, duration: "until_exit", effect: "sleep",
  }),
  sleep: Object.freeze({
    id: "sleep", label: "Sleep", anim: "sleep", pose: "lie",
    occupancy: 1, duration: "until_exit", effect: "sleep",
  }),
  shower: Object.freeze({
    id: "shower", label: "Shower", anim: "shower", pose: "shower",
    occupancy: 1, duration: "until_exit", effect: "water",
  }),
  bathe: Object.freeze({
    id: "bathe", label: "Bathe", anim: "bathe", pose: "bathe",
    occupancy: 1, duration: "until_exit", effect: "water",
  }),
  watch: Object.freeze({
    id: "watch", label: "Watch TV", anim: "watch", pose: "watch",
    occupancy: 1, duration: "until_exit", effect: "tv", anchor: "front",
  }),
  // Unlike a seat or a bath, a tap is a switch.  Starting the action turns
  // the water animation on and sending the same action again turns it off.
  // The server owns that toggle; clients only render the resulting activity
  // broadcast.
  toggle_water: Object.freeze({
    id: "toggle_water", label: "Tap water", anim: "water", pose: "use",
    occupancy: 1, duration: "toggle", effect: "water", toggle: true,
  }),
});

const DEFAULT_ACTION = Object.freeze({
  anchor: "center",
  facing: "down",
  radius: 86,
});
const ACTION_FACINGS = new Set(["up", "down", "left", "right", "approach"]);

function actionId(value) {
  return typeof value === "string" ? value : value?.id;
}

// Catalog rows are persisted data and a few older room manifests represented
// actions as `{ id }` objects. Normalize both forms at this seam so the server,
// renderer, and interaction prompt cannot silently disagree about whether a
// piece is usable.
export function furnitureActionIds(item) {
  if (!item || typeof item !== "object" || !Array.isArray(item.actions)) return [];
  return [...new Set(item.actions
    .map(actionId)
    .filter((id) => typeof id === "string" && FURNITURE_ACTIONS[id]))];
}

export function furnitureActionDefinitions(item) {
  if (!item || typeof item !== "object") return [];
  const ids = furnitureActionIds(item);
  return ids.map((id) => {
    const action = FURNITURE_ACTIONS[id];
    const actionInteraction = item.actionInteractions?.[id] || {};
    return Object.freeze({
      ...DEFAULT_ACTION,
      ...action,
      ...(item.interaction || {}),
      ...actionInteraction,
      id,
    });
  }).filter(Boolean);
}

export function furnitureActionDefinition(item, actionId) {
  const id = typeof actionId === "string" ? actionId : actionId?.id;
  return furnitureActionDefinitions(item).find((action) => action.id === id) || null;
}

export function furnitureActionAnim(action) {
  return FURNITURE_ACTIONS[actionId(action)]?.anim || null;
}

// Catalog actions are trusted project data, but this seam also prevents a
// malformed facing from becoming an invalid public player direction. `approach`
// deliberately resolves only when the authoritative server supplies the
// player's current cardinal direction; geometry-only callers retain `down`.
export function furnitureActionFacing(action, approachDirection = "down") {
  const configured = typeof action?.facing === "string" ? action.facing : "down";
  if (!ACTION_FACINGS.has(configured)) return "down";
  if (configured !== "approach") return configured;
  return ACTION_FACINGS.has(approachDirection) && approachDirection !== "approach"
    ? approachDirection : "down";
}

export function furnitureActionAnchor(item, gridX, gridY, cell = 48, actionId = "sit") {
  const width = Number(item?.width) > 0 ? Number(item.width) : 1;
  const height = Number(item?.height) > 0 ? Number(item.height) : 1;
  const itemRotation = Number(item?.rotation);
  const rotation = Number.isFinite(itemRotation) &&
    Array.isArray(item?.rotations) && item.rotations.includes(itemRotation)
    ? itemRotation : 0;
  const footprint = rotation % 180 === 90
    ? { width: height, height: width }
    : { width, height };
  const action = furnitureActionDefinition(item, actionId) || DEFAULT_ACTION;
  const originX = Number(gridX);
  const originY = Number(gridY);
  const unit = Number(cell) > 0 ? Number(cell) : 48;
  const x = (originX + footprint.width / 2) * unit;
  // Furniture sprites use their bottom edge as their world anchor.  Actors
  // sit/lie just below the visual pad, which keeps their feet/pivot stable.
  const centerY = (originY + footprint.height / 2) * unit;
  // Front-facing props (the TV is the current example) must leave the actor
  // outside the prop footprint. This keeps the avatar standing in front of,
  // and looking toward, the screen instead of being snapped into the TV tile.
  const baseY = action.anchor === "front"
    ? (originY + footprint.height) * unit + 18
    : centerY + (action.pose === "sit" ? 10 : 6);
  // Bitmap authors can place the interaction point on the actual cushion,
  // mattress, or water basin instead of forcing every piece through the
  // footprint centre.  Offsets are presentation pixels (the same world
  // units used by Phaser), and are rotated with the placed footprint so a
  // rotated item retains the same art-relative anchor.
  const offset = action.actorOffset && typeof action.actorOffset === "object"
    ? action.actorOffset : null;
  const offsetX = Number(offset?.x) || 0;
  const offsetY = Number(offset?.y) || 0;
  const radians = (rotation * Math.PI) / 180;
  const xOffset = offsetX * Math.cos(radians) - offsetY * Math.sin(radians);
  const yOffset = offsetX * Math.sin(radians) + offsetY * Math.cos(radians);
  return {
    x: x + xOffset,
    y: baseY + yOffset,
    dir: furnitureActionFacing(action),
  };
}

export function furnitureActionStandCandidates(item, gridX, gridY, cell = 48, actionId = "sit") {
  const width0 = Number(item?.width) > 0 ? Number(item.width) : 1;
  const height0 = Number(item?.height) > 0 ? Number(item.height) : 1;
  const itemRotation = Number(item?.rotation);
  const rotation = Number.isFinite(itemRotation) &&
    Array.isArray(item?.rotations) && item.rotations.includes(itemRotation)
    ? itemRotation : 0;
  const width = rotation % 180 === 90 ? height0 : width0;
  const height = rotation % 180 === 90 ? width0 : height0;
  const unit = Number(cell) > 0 ? Number(cell) : 48;
  const x = Number(gridX) * unit, y = Number(gridY) * unit;
  const w = width * unit, h = height * unit;
  const cx = x + w / 2, cy = y + h / 2;
  const action = furnitureActionDefinition(item, actionId) || DEFAULT_ACTION;
  const candidates = [
    { x: cx, y: y - 18, dir: "down" },
    { x: cx, y: y + h + 18, dir: "up" },
    { x: x - 18, y: cy, dir: "right" },
    { x: x + w + 18, y: cy, dir: "left" },
  ];
  // Prefer the same side from which the actor faces the furniture. Besides
  // making exits natural, this keeps TV viewers below the screen.
  const preferred = { up: 1, down: 0, left: 3, right: 2 }[action.facing];
  if (preferred === undefined) return candidates;
  return [candidates[preferred], ...candidates.filter((_candidate, index) => index !== preferred)];
}

export function actionEffectKind(action) {
  return ({
    sit: "comfort",
    lie: "sleep",
    sleep: "sleep",
    shower: "water",
    bathe: "water",
    watch: "tv",
    toggle_water: "water",
  })[action] || "comfort";
}

export function furnitureIsOccupied(players, locationId, instanceId, exceptId = null) {
  const wanted = String(instanceId);
  return Object.entries(players || {}).some(([id, player]) =>
    id !== exceptId &&
    (player?.locationId || player?.location) === locationId &&
    String(player?.activity?.instanceId || "") === wanted);
}

export function furnitureActionWithinRadius(player, anchor, radius) {
  if (!player || !anchor || !Number.isFinite(Number(radius))) return false;
  const distance = Math.hypot(
    Number(player.x) - Number(anchor.x),
    Number(player.y) - Number(anchor.y),
  );
  return Number.isFinite(distance) && distance <= Number(radius);
}

export function furnitureActionPathClear(from, to, isWalkable, maxStep = 8) {
  if (!from || !to || typeof isWalkable !== "function") return false;
  const distance = Math.hypot(Number(to.x) - Number(from.x), Number(to.y) - Number(from.y));
  if (!Number.isFinite(distance)) return false;
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, Number(maxStep) || 8)));
  for (let index = 0; index <= steps; index++) {
    const ratio = index / steps;
    const x = Number(from.x) + (Number(to.x) - Number(from.x)) * ratio;
    const y = Number(from.y) + (Number(to.y) - Number(from.y)) * ratio;
    if (!isWalkable(x, y)) return false;
  }
  return true;
}

export function furnitureActivityConflictsWithBlock(block, players, radius = 16) {
  if (!block) return false;
  const pointTouches = (point) => {
    if (!point) return false;
    const nearestX = Math.max(block.x, Math.min(Number(point.x), block.x + block.width));
    const nearestY = Math.max(block.y, Math.min(Number(point.y), block.y + block.height));
    return Math.hypot(Number(point.x) - nearestX, Number(point.y) - nearestY) <= radius;
  };
  return Object.values(players || {}).some((player) => {
    const activity = player?.activity;
    if (!activity) return false;
    if (String(activity.instanceId) === String(block.instanceId)) return true;
    return [
      { x: player.x, y: player.y },
      { x: activity.x, y: activity.y },
      activity.stand,
    ].some(pointTouches);
  });
}