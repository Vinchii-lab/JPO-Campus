import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const window = {};
vm.runInNewContext(fs.readFileSync(new URL("../public/ice-motion.js", import.meta.url), "utf8"), { window });
const { step } = window.JpoIceMotion;
test("ice momentum carries over the edge without activating on ordinary floor", () => {
  const { active } = window.JpoIceMotion;
  assert.equal(active(true, false, false, { x: 195, y: 0 }), false);
  assert.equal(active(true, true, false, { x: 0, y: 0 }), true);
  let v = { x: 195, y: 0 }, sliding = true, distance = 0;
  for (let n = 0; n < 660; n++) {
    sliding = active(true, false, sliding, v);
    v = sliding ? step(v, { x: 0, y: 0 }, 195, 1000 / 60) : { x: 0, y: 0 };
    distance += v.x / 60;
  }
  assert(distance > 550, "crossing the boundary must not cut the coast short");
  assert.equal(sliding, false);
  assert.equal(active(true, false, true, { x: 0, y: 0 }), false, "collision or pause clears residual slide");
  assert.equal(active(false, true, true, { x: 195, y: 0 }), false, "game/season/disconnect gates win");
});
test("exaggerated glide remains capped and coasts roughly twelve tiles across frame rates", () => {
  for (const hz of [30, 60, 120, 144, 240]) {
    let v = { x: 0, y: 0 };
    for (let n = 0; n < hz * 2; n++) {
      v = step(v, { x: 195, y: 195 }, 195, 1000 / hz);
      assert(Math.hypot(v.x, v.y) <= 195 + 1e-9);
    }
    assert(Math.hypot(v.x, v.y) > 190);
    let distance = 0;
    for (let n = 0; n < hz * 11; n++) {
      v = step(v, { x: 0, y: 0 }, 195, 1000 / hz);
      distance += Math.hypot(v.x, v.y) / hz;
    }
    assert.equal(v.x, 0); assert.equal(v.y, 0);
    assert(distance > 555 && distance < 575, "release coasts roughly twelve tiles on uninterrupted ice");
    v = { x: 195, y: 0 };
    for (let n = 0; n < Math.ceil(hz * .25); n++) v = step(v, { x: -195, y: 0 }, 195, 1000 / hz);
    assert(v.x > 0, "opposite input initially skids instead of instantly reversing");
    for (let n = 0; n < Math.ceil(hz * .4); n++) v = step(v, { x: -195, y: 0 }, 195, 1000 / hz);
    assert(v.x < 0, "opposite input can still reverse within two-thirds of a second");
  }
});
test("corrections/collisions cannot leave hidden momentum, speed reductions clamp immediately", () => {
  const stopped = step({ x: 0, y: 0 }, { x: 0, y: 0 }, 195, 16);
  assert.equal(stopped.x, 0);
  assert.equal(stopped.y, 0);
  assert(Math.hypot(...Object.values(step({ x: 1000, y: 1000 }, { x: 1000, y: 1000 }, 195, 2000))) <= 195 + 1e-9);
});
test("live office movement gates skating and applies it after diagonal normalization", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const a = html.indexOf("const previousIceVelocity"), b = html.indexOf("this._moving = moving", a);
  const source = html.slice(a, b);
  assert(source.includes("!_roundPhase && !_rlgl.running && !window._ph.phase"));
  assert(source.includes("this._christmasRink?.isSlippery(player.x, player.y)"));
  assert(source.includes("this._iceCoasting, previousIceVelocity"));
  assert(source.indexOf("normalize().scale(spd)") < source.indexOf("JpoIceMotion.step"));
  assert(source.indexOf("JpoIceMotion.step") < source.indexOf("_voidClampVelocity"));
  assert(source.includes("Math.hypot(player.body.velocity.x, player.body.velocity.y) >= 6"));
});
