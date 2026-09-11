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
});

const DEFAULT_ACTION = Object.freeze({
  anchor: "center",
  facing: "down",
  radius: 86,
});

export function furnitureActionDefinitions(item) {
  if (!item || typeof item !== "object") return [];
  const ids = Array.isArray(item.actions) ? item.actions : [];
  return ids.map((id) => {
    const action = FURNITURE_ACTIONS[id];
    if (!action) return null;
    return Object.freeze({
      ...DEFAULT_ACTION,
      ...action,
      ...(item.interaction || {}),
      id,
    });
  }).filter(Boolean);
}

export function furnitureActionDefinition(item, actionId) {
  return furnitureActionDefinitions(item).find((action) => action.id === actionId) || null;
}

export function furnitureActionAnim(action) {
  return FURNITURE_ACTIONS[action]?.anim || null;
}

export function furnitureActionAnchor(item, gridX, gridY, cell = 48, actionId = "sit") {
  const width = Number(item?.width) > 0 ? Number(item.width) : 1;
  const height = Number(item?.height) > 0 ? Number(item.height) : 1;
  const rotation = Number(item?.rotations?.includes(Number(item.rotation))
    ? item.rotation : 0);
  const footprint = rotation % 180 === 90
    ? { width: height, height: width }
    : { width, height };
  const action = furnitureActionDefinition(item, actionId) || DEFAULT_ACTION;
  const x = (Number(gridX) + footprint.width / 2) * cell;
  // Furniture sprites use their bottom edge as their world anchor.  Actors
  // sit/lie just below the visual pad, which keeps their feet/pivot stable.
  const centerY = (Number(gridY) + footprint.height / 2) * cell;
  // Front-facing props (the TV is the current example) must leave the actor
  // outside the prop footprint. This keeps the avatar standing in front of,
  // and looking toward, the screen instead of being snapped into the TV tile.
  const y = action.anchor === "front"
    ? (Number(gridY) + footprint.height) * cell + 18
    : centerY + (action.pose === "sit" ? 10 : 6);
  return { x, y, dir: action.facing || "down" };
}

export function furnitureActionStandCandidates(item, gridX, gridY, cell = 48, actionId = "sit") {
  const width0 = Number(item?.width) > 0 ? Number(item.width) : 1;
  const height0 = Number(item?.height) > 0 ? Number(item.height) : 1;
  const rotation = Number(item?.rotation) || 0;
  const width = rotation % 180 === 90 ? height0 : width0;
  const height = rotation % 180 === 90 ? width0 : height0;
  const x = Number(gridX) * cell, y = Number(gridY) * cell;
  const w = width * cell, h = height * cell;
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