import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const window = {};
vm.runInNewContext(fs.readFileSync(new URL("../public/ice-motion.js", import.meta.url), "utf8"), { window });
const { step } = window.JpoIceMotion;
test("glide is capped, controllable and settles in under a second across frame rates", () => {
  for (const hz of [30, 60, 120, 144, 240]) {
    let v = { x: 0, y: 0 };
    for (let n = 0; n < hz; n++) {
      v = step(v, { x: 195, y: 195 }, 195, 1000 / hz);
      assert(Math.hypot(v.x, v.y) <= 195 + 1e-9);
    }
    assert(Math.hypot(v.x, v.y) > 190);
    let distance = 0;
    for (let n = 0; n < hz; n++) {
      v = step(v, { x: 0, y: 0 }, 195, 1000 / hz);
      distance += Math.hypot(v.x, v.y) / hz;
    }
    assert.equal(v.x, 0); assert.equal(v.y, 0);
    assert(distance < 44, "release glides less than one tile");
    v = { x: 195, y: 0 };
    for (let n = 0; n < Math.ceil(hz * .25); n++) v = step(v, { x: -195, y: 0 }, 195, 1000 / hz);
    assert(v.x < 0, "opposite input reverses within a quarter-second");
  }
});
test("corrections/collisions cannot leave hidden momentum, speed reductions clamp immediately", () => {
  const stopped = step({ x: 0, y: 0 }, { x: 0, y: 0 }, 195, 16);
  assert.equal(stopped.x, 0);
  assert.equal(stopped.y, 0);
  assert(Math.hypot(...Object.values(step({ x: 1000, y: 1000 }, { x: 1000, y: 1000 }, 195, 2000))) <= 195 + 1e-9);
});
test("live office movement applies skating only in rink and after diagonal normalization", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const a = html.indexOf("const previousIceVelocity"), b = html.indexOf("this._moving = moving", a);
  const source = html.slice(a, b);
  assert(source.includes("!_roundPhase && !_rlgl.running && !window._ph.phase"));
  assert(source.includes("this._christmasRink?.isSlippery(player.x, player.y)"));
  assert(source.indexOf("normalize().scale(spd)") < source.indexOf("JpoIceMotion.step"));
  assert(source.indexOf("JpoIceMotion.step") < source.indexOf("_voidClampVelocity"));
  assert(source.includes("Math.hypot(player.body.velocity.x, player.body.velocity.y) >= 6"));
});
