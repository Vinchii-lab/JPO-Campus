// Cheap, dependency-free contracts for Willow Walk's shared portal and
// retained-test-account behavior.  Renderer layering is checked from source
// because Phaser is intentionally not loaded in this unit test.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTOR_FOOT_RADIUS,
  LOCATION_PORTALS,
  LOCATIONS,
  isHuddleTestIdentity,
  homeAccess,
  locationSpawn,
  parseLocation,
  pointHitsRect,
  portalForTransition,
  streetDefinition,
  streetLotForOwner,
  validStreetWorldMove,
} from "../../neighborhood.mjs";

const officeLink = LOCATION_PORTALS.neighborhood.find((portal) => portal.destination === "office");
assert.deepEqual(
  { x: officeLink.x, y: officeLink.y, width: officeLink.width, height: officeLink.height },
  { x: 552, y: 864, width: 48, height: 96 },
  "HQ return portal must remain on the central north/south path",
);
assert.deepEqual(LOCATIONS.neighborhood.spawn, { x: 576, y: 912, dir: "up" });
assert.equal(portalForTransition("neighborhood", "office", 576, 912), officeLink);
assert.equal(locationSpawn(parseLocation("neighborhood"), "office").x, 576);
assert.equal(locationSpawn(parseLocation("neighborhood"), "office").y, 912);
assert(pointHitsRect(576, 912, officeLink, ACTOR_FOOT_RADIUS), "arrival point must be inside a foot-safe trigger");
assert(validStreetWorldMove(streetDefinition([]), 576, 912), "arrival point must be walkable");

assert(isHuddleTestIdentity("huddle-a-qwc0xff@justpressone.com"));
assert(isHuddleTestIdentity("HUDDLE-B-7f3a9c1@justpressone.com"));
assert(!isHuddleTestIdentity("huddle-team@justpressone.com"));
assert(!isHuddleTestIdentity("huddle-a-qwc0xff@example.com"));
assert(!isHuddleTestIdentity("HuddleA Tester <huddle-a-qwc0xff@justpressone.com>"));

const retained = [
  { ownerEmail: "huddle-a-qwc0xff@justpressone.com", lotIndex: 1, name: "HuddleA Tester" },
  { ownerEmail: "vince@example.com", lotIndex: 2, name: "Vince" },
  { ownerEmail: "huddle-b-7f3a9c1@justpressone.com", lotIndex: 3, name: "HuddleB Tester" },
];
const street = streetDefinition(retained);
assert.deepEqual(street.lots.map((lot) => lot.ownerEmail), ["vince@example.com"]);
assert.equal(streetLotForOwner(retained, "huddle-a-qwc0xff@justpressone.com"), null);
assert.equal(street.doors.length, 0, "retained test homes must not expose a door");

const here = path.dirname(fileURLToPath(import.meta.url));
const publicHomePool = { query: async () => ({ rows: [{
  owner_email: 'resident@example.com', access_mode: 'public', roof_built: true,
}] }) };
assert.equal((await homeAccess(publicHomePool, 'resident@example.com', 'huddle-a@justpressone.com')).ok, true,
  'test accounts may visit public homes without owning one');
assert.equal((await homeAccess(publicHomePool, 'huddle-a@justpressone.com', 'resident@example.com')).ok, false,
  'test-owned homes remain unavailable');
const clientSource = fs.readFileSync(path.join(here, "../../public/neighborhood.js"), "utf8");
assert.match(clientSource, /const LOT_GROUND_DEPTH = 2/);
assert.match(clientSource, /\.setDepth\(LOT_GROUND_DEPTH\)/, "foundation and yard planes share a low depth");
assert.match(clientSource, /\.setDepth\(top \+ 48 \* \(row \+ 1\)\)/, "wall tiles must y-sort by their bottom edge");
assert.match(clientSource, /if \(portal\.residence\) \{\s*this\.portalCues\?\.push\(cue\);\s*continue;/s,
  "residence doors keep a cue but do not add a duplicate owner label");
assert.doesNotMatch(clientSource, /setDepth\(Math\.max\(2, originY - 1\)\)/,
  "yard ground must not be y-sorted over actors");

console.log("PASS: central HQ portal, hidden Huddle A/B homes, and outdoor layering contracts");