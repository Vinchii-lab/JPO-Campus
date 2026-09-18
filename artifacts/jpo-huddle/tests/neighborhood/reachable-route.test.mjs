import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { collisionRegions, reachableRoute } from "./reachable-route.mjs";
import { FURNITURE_CATALOG, layoutBlockers, validLocationMove, parseLocation, pointHitsRect } from "../../neighborhood.mjs";
import { furnitureActionAnchor, furnitureActionDefinition, furnitureActionWithinRadius } from "../../furniture-actions.mjs";

const body = { offsetX: 0, offsetY: 27, halfWidth: 18, halfHeight: 15 };
// Actual _addBlock uses half extents, measured offset, and .5px safety.
const clientBlocks = blocks => blocks.map(r => ({
  x: r.x + 1.5, y: r.y + 25.5, width: r.width - 3, height: r.height + 3,
}));
function prove(snapshot, start, goal, label) {
  const dynamic = snapshot.home ? layoutBlockers(snapshot.home.layout) : [];
  const blocks = [...snapshot.map.geometry.blockers, ...dynamic];
  const regions = collisionRegions({ serverBlocks: blocks, clientBlocks: clientBlocks(blocks), body });
  const route = reachableRoute({ start, goal: { ...goal, radius: goal.radius - 24 },
    bounds: snapshot.map.bounds, regions, clearance: 12, step: 16 });
  const location = parseLocation(snapshot.location);
  let previous = start;
  for (const p of route.waypoints) {
    assert(p.x === previous.x || p.y === previous.y, "no implicit diagonal corners");
    const n = Math.ceil(Math.hypot(p.x - previous.x, p.y - previous.y));
    for (let i = 1; i <= n; i++) {
      const x = previous.x + (p.x - previous.x) * i / n;
      const y = previous.y + (p.y - previous.y) * i / n;
      assert(validLocationMove(location, x, y, dynamic), `${label}: server movement`);
      assert(!blocks.some(r => pointHitsRect(x, y, r)), `${label}: snapshot server movement including showroom`);
      assert(!regions.some(r => x > r.x && x < r.x + r.width && y > r.y && y < r.y + r.height),
        `${label}: full Arcade footprint`);
    }
    previous = p;
  }
  assert(furnitureActionWithinRadius(previous, goal, goal.radius), `${label}: server interaction range`);
  console.log(label, JSON.stringify({ start, goal, waypoints: route.waypoints }));
  return previous;
}
for (const tag of ["4joba9a", "s9tgn16", "o13f83m"]) {
  const evidence = JSON.parse(fs.readFileSync(new URL(`../evidence/real-game-furniture-${tag}/fatal-evidence.json`, import.meta.url)));
  const page = evidence.pages.find(p => p.label === "owner").state;
  const snapshot = [...page.importantEvents].reverse().find(e => e.payload?.map?.geometry).payload;
  const start = { x: page.scene.x, y: page.scene.y };
  if (snapshot.home) {
    let from = start;
    for (const [id, action] of [["plush_bed", "lie"], ["bathtub", "bathe"]]) {
      const item = snapshot.home.layout.find(p => p.furnitureId === id);
      const def = FURNITURE_CATALOG[id];
      const anchor = furnitureActionAnchor(def, item.gridX, item.gridY, 48, action);
      const radius = furnitureActionDefinition(def, action).radius;
      from = prove(snapshot, from, { ...anchor, radius }, `${tag} ${id}`);
    }
  } else {
    const cashier = snapshot.map.cashiers[0];
    prove(snapshot, start, cashier, `${tag} cashier`);
    // Old x=571 crosses the showroom stool's server-inflated x range 560..640.
    assert(snapshot.map.geometry.blockers.some(r => pointHitsRect(571, 530, r)));
    assert(!snapshot.map.geometry.blockers.some(r => pointHitsRect(520, 530, r)));
  }
}
// Old circular tests admitted the corner of this axis-aligned server blocker.
const corner = collisionRegions({ serverBlocks: [{ x: 100, y: 100, width: 48, height: 48 }], body });
assert(corner.some(r => 85 > r.x && 85 < r.x + r.width && 85 > r.y && 85 < r.y + r.height));
console.log("Evidence routes: continuous server + full Arcade body + authoritative action ranges PASS");

// Execute the harness's actual frame-release helper without launching a
// browser. A deliberately delayed controller must not keep a key held after
// the simulation crosses its waypoint.
const harness = fs.readFileSync(new URL("./real-game-furniture.mjs", import.meta.url), "utf8");
const routeAxisSource = harness.slice(harness.indexOf("async function routeAxis("),
  harness.indexOf("async function walkReachable("));
for (const tickDistance of [4.5, 18]) {
  let held = null, listener = null;
  const player = { x: 560.5, y: 722 };
  const scene = { player, events: {
    on(_name, fn) { listener = fn; },
    off(_name, fn) { if (listener === fn) listener = null; },
  } };
  const window = { _neighborhoodScene: scene, dispatchEvent() { held = null; } };
  const context = vm.createContext({
    window, KeyboardEvent: class { constructor(type, values) { Object.assign(this, { type }, values); } },
    sceneState: async () => ({ ...player }),
    requireOk: (ok, message) => assert(ok, message), boundedTimeout: x => x,
  });
  vm.runInContext(routeAxisSource, context);
  const page = {
    evaluate: async (fn, arg) => {
      context.argument = arg;
      return vm.runInContext(`(${fn.toString()})(argument)`, context);
    },
    keyboard: { down: async key => { held = key; }, up: async () => { held = null; } },
    waitForFunction: async () => {
      for (let i = 0; i < 1000 && !window.__qaRouteStop.done; i++) {
        if (held) player.y += held === "ArrowUp" ? -tickDistance : tickDistance;
        listener?.(i * 16.67, 16.67);
      }
      assert(window.__qaRouteStop.done);
      // Simulate a long protocol response after the arrival frame.
      for (let i = 0; i < 50; i++) {
        if (held) player.y += held === "ArrowUp" ? -tickDistance : tickDistance;
      }
    },
  };
  await context.routeAxis(page, "y", 258, `tick=${tickDistance}`);
  assert(Math.abs(player.y - 258) <= 10);
  assert.equal(held, null);
}
console.log("Held-key arrival: actual helper passes 4.5px/18px simulation ticks with delayed polling");