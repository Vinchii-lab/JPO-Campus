import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { LOCATION_PORTALS } from "../../neighborhood.mjs";

const client = fs.readFileSync(new URL("../../public/neighborhood.js", import.meta.url), "utf8");
const office = fs.readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
const start = client.indexOf("window.jpoTryOfficePortal = function");
const end = client.indexOf("\n  };", start) + 5;
assert(start >= 0 && end > start);
assert.match(office, /jpoTryOfficePortal\?\.\(player, this\.lastDir, this\._gardenExit\)/);
const packets = [];
const context = {
  window: { jpoBeginMapFade() {} }, currentLocation: "office",
  officePortalRelease: true, officePortalTransition: false,
  movement: { sendReliable: (...args) => packets.push(args) },
  travel: (destination) => packets.push(["travel", destination]),
};
vm.runInNewContext(client.slice(start, end), context);
const gate = LOCATION_PORTALS.office[0];
const attempt = context.window.jpoTryOfficePortal;
assert.equal(attempt({ x: 144, y: 3624 }, "left", gate), false, "old gate cannot activate");
assert.equal(attempt({ x: 336, y: 2280 }, "left", gate), false, "approach remains outside");
assert.equal(attempt({ x: 240, y: 2280 }, "left", gate), true, "new gate must actually send travel");
assert.equal(packets[0][0], "office");
assert.deepEqual(packets[1], ["travel", "neighborhood"]);
assert.equal(attempt({ x: 240, y: 2280 }, "left", gate), false, "no repeated travel while fading");
console.log("PASS: live office trigger uses visible gate geometry and sends travel exactly once");