// Shared native-3x equipment geometry. Cafe remains the stable destination ID.
export const GYM_DURATION_MS = 8000;
export const GYM_STATIONS = Object.freeze([
  ...[192, 432, 672].map((x, i) => ({
    id: `plaza-gym:bag${i + 1}`, kind: "punch", x, y: 120,
    anchor: { x: x + 24, y: 240 }, radius: 62,
    blocker: { x, y: 144, width: 45, height: 72 },
  })),
  ...[144, 384, 624].map((x, i) => ({
    id: `plaza-gym:treadmill${i + 1}`, kind: "run", x, y: 306,
    anchor: { x: x + 72, y: 486 }, radius: 62,
    // The reachable anchor is in the aisle below the collision footprint.
    // The presentation anchor matches HQ's treadmill geometry: its avatar
    // centre is 78 world pixels below the animated strip's top, putting the
    // avatar's feet on the belt without moving its authoritative physics body.
    poseAnchor: { x: x + 72, y: 384 }, poseDepth: 460,
    blocker: { x: x + 42, y: 351, width: 60, height: 108 },
  })),
]);

export function applyGymLayout(manifest) {
  manifest.rooms.cafe = {
    label: "Plaza Gym", type: "gym", width: 960, height: 720,
    objects: [], seats: [],
    blockers: GYM_STATIONS.map(station => ({ ...station.blocker })),
    gymStations: GYM_STATIONS,
  };
}