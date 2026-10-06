import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
const start = html.indexOf("      _applyOfficeArrival(state) {");
const end = html.indexOf("\n      // Re-enter the seated pose", start);
let workChip;
const apply = vm.runInNewContext(`({${html.slice(start, end)}})._applyOfficeArrival`, {
  DIR_START: { down: 0, left: 6, right: 12, up: 18 },
  _setWorkChip: value => { workChip = value; },
});
const player = {
  x: 500, y: 500,
  body: { enable: false, reset(x, y) { player.x = x; player.y = y; this.velocity = { x: 0, y: 0 }; } },
  anims: { stop() {} },
  setTexture(key) { this.texture = key; },
  setFrame(frame) { this.frame = frame; },
};
const scene = {
  player, playerTexKey: "run", sitting: true, _deskPose: {}, _preSitPos: { x: 500, y: 600 },
  _seatOccluders: [{}], _clearOccluders(items) { this.cleared = items; },
  _restoreSeatedPose(x, y, dir) {
    this.restored = { x, y, dir }; this.sitting = true; player.body.enable = false;
  },
};
// The previous arrival path only moved coordinates: a surviving seated scene
// remained sitting with physics disabled at an authoritative IDLE lawn spawn.
player.body.reset(1272, 2253);
assert.equal(player.body.enable, false);
assert.equal(scene.sitting, true);

apply.call(scene, { x: 1272, y: 2253, dir: "down", anim: "idle" });
assert.equal(scene.sitting, false);
assert.equal(player.body.enable, true);
assert.equal(scene._preSitPos, null);
assert.equal(scene._deskPose, null);
assert.equal(scene._seatOccluders.length, 0);
assert.equal(workChip, false);
assert.equal(player.texture, "run");
assert.equal(player.frame, 0);
assert.equal(scene._lastPaintedPos.x, 1272);
apply.call(scene, { x: 700, y: 800, dir: "left", anim: "sit" });
assert.equal(scene.sitting, true);
assert.equal(player.body.enable, false);
assert.deepEqual(scene.restored, { x: 700, y: 800, dir: "left" });
apply.call(scene, { x: 1272, y: 2253, dir: "down" });
assert.equal(player.body.enable, true, "walking portal return also clears old seat");
assert.equal(scene.sitting, false);
apply.call(scene, { x: NaN, y: 0 });
assert.equal(player.x, 1272, "invalid arrival never relocates");
const neighborhood = fs.readFileSync(new URL("../../public/neighborhood.js", import.meta.url), "utf8");
assert(neighborhood.includes("target._applyOfficeArrival(spawn)"), "live office arrival reconciles pose");
console.log("PASS: idle lawn arrival enables physics and clears stale seating; genuine seated resume preserved");
