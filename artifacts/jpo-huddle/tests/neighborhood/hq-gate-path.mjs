// Offline, full-footprint regression for the actual authored HQ garden.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const root = new URL("../../", import.meta.url);
const html = fs.readFileSync(new URL("public/index.html", root), "utf8");
const client = fs.readFileSync(new URL("public/neighborhood.js", root), "utf8");
const map = JSON.parse(fs.readFileSync(new URL("public/assets/JPO_HQ.tmj", root), "utf8"));
const layers = Object.fromEntries(map.layers.map(layer => [layer.name, layer]));
const open = new Set();
// Execute the live targeted opening, rather than duplicating its coordinates.
const approach = html.slice(html.indexOf("const GARDEN_APPROACH_CELLS ="), html.indexOf("//", html.indexOf("const GARDEN_APPROACH_CELLS =") + 1));
const opening = approach.slice(0, approach.lastIndexOf("}") + 1);
const layer = { getTileAt(c, r) { return { index: 1, setCollision() { open.add(`${c},${r}`); } }; } };
vm.runInNewContext(opening, { wallLayer: layer, furnitureLayer: layer });
assert.match(html, /setSize\(12, 10\)\.setOffset\(2, 20\)/);
// 16x32 frame, origin .5, scale 3: body x±18, y+12..42 (feet center y+27).
// Conservatively retain every other Wall/Furniture cell, including seats.
function walkable(x, y) {
  if (x < 18 || x > 1600 || y < 2000 || y > 2800) return false;
  for (let r = Math.floor((y + 12) / 48); r <= Math.floor((y + 42 - 1e-6) / 48); r++)
    for (let c = Math.floor((x - 18) / 48); c <= Math.floor((x + 18 - 1e-6) / 48); c++) {
      const i = r * map.width + c;
      if (!open.has(`${c},${r}`) && (layers.Wall.data[i] || layers.Furniture.data[i])) return false;
      if ((layers.Floor.data[i] & 0x1fffffff) === 1237) return false;
    }
  return true;
}
const gate = vm.runInNewContext(`(${html.match(/this\._gardenExit = (\{[^;]+\});/)[1]})`);
const context = {
  window: {}, currentLocation: "office", officePortalRelease: true,
  officePortalTransition: false, movement: { sendReliable() {} },
  travel(destination) { assert.equal(destination, "neighborhood"); },
};
vm.runInNewContext(client.match(/window\.jpoTryOfficePortal = function[\s\S]*?\n  };/)[0], context);
function inGate(x, y) {
  context.officePortalTransition = false;
  return context.window.jpoTryOfficePortal({ x, y }, "left", gate);
}
for (const start of [[236, 2484], [1272, 2253]]) {
  const queue = [start], seen = new Set([start.join()]);
  let found = false;
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i];
    if (inGate(x, y)) { found = true; break; }
    for (const [dx, dy] of [[4, 0], [-4, 0], [0, 4], [0, -4]]) {
      const p = [x + dx, y + dy], key = p.join();
      if (!seen.has(key) && walkable(...p)) { seen.add(key); queue.push(p); }
    }
  }
  assert(found, `Full-body route from ${start} to live gate predicate`);
}
const route = [[236, 2484], [620, 2484], [620, 2380], [420, 2380], [420, 2280], [240, 2280]];
for (let i = 1; i < route.length; i++) {
  const [x, y] = route[i - 1], [ex, ey] = route[i];
  const steps = Math.max(Math.abs(ex - x), Math.abs(ey - y));
  for (let s = 0; s <= steps; s++)
    assert(walkable(x + (ex - x) * s / steps, y + (ey - y) * s / steps), `Route segment ${i}, pixel ${s}`);
}
assert(inGate(...route.at(-1)));
console.log("HQ gate: full-body BFS from tester/spawn and every route pixel pass.");