// Focused source contracts for the frontend's furniture/activity rebuild and
// placement teardown paths. These checks stay browser-free: Phaser behavior is
// covered by the renderer contract, while this guards the lifecycle glue that
// can otherwise regress silently.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.resolve(here, "../../public");
const sceneSource = fs.readFileSync(path.join(publicRoot, "neighborhood.js"), "utf8");
const uiSource = fs.readFileSync(path.join(publicRoot, "neighborhood-ui.js"), "utf8");

new vm.Script(sceneSource, { filename: "neighborhood.js" });
new vm.Script(uiSource, { filename: "neighborhood-ui.js" });

const renderStart = sceneSource.indexOf("renderFurniture(state) {");
const renderEnd = sceneSource.indexOf("\n    _removeRemote(", renderStart);
assert.ok(renderStart >= 0 && renderEnd > renderStart, "renderFurniture remains a bounded scene method");
const renderFurniture = sceneSource.slice(renderStart, renderEnd);
assert.ok(renderFurniture.indexOf("this._clearActivityEffect(this)") <
  renderFurniture.indexOf("object.destroy()"),
  "rebuilding furniture clears the local activity's old renderer target first");
assert.match(renderFurniture, /Object\.values\(this\.remotes \|\| \{\}\)\.forEach\(\(entry\) => this\._clearActivityEffect\(entry\)\)/,
  "rebuilding furniture clears every remote activity target");
assert.match(renderFurniture, /this\._rebindFurnitureActivities\(\);/,
  "rebuilding furniture reapplies current local and remote activities");
assert.match(sceneSource, /entry\._activityAction = null;[\s\S]{0,180}this\._applyActivityPose\(entry, activity, dir\);/,
  "activity rebinding forces pose/effect resolution against the replacement sprite");

assert.match(sceneSource, /const teardownPlacement = \(\) => \{[\s\S]{0,240}selectedInstance = null;[\s\S]{0,240}hidePlacementControls\(\);/,
  "placement teardown resets selection and hides the controls centrally");
assert.match(sceneSource, /socket\.on\('homeActionResult', \(result\) => \{[\s\S]{0,180}teardownPlacement\(\);/,
  "server action completion tears down placement");
assert.match(sceneSource, /shutdown\(\) \{[\s\S]{0,520}teardownPlacement\(\);/,
  "scene shutdown tears down placement");
assert.match(uiSource, /if \(!ctx\.active\) \{[\s\S]{0,100}container\.hidden = true;[\s\S]{0,100}container\.innerHTML = '';/,
  "inactive placement controls remove stale actionable markup");
assert.match(sceneSource, /socket\.on\('furnitureShowroom',[\s\S]{0,520}setFurnitureShowroomDemos/,
  "furniture-shop consumes the server showroom projection");
assert.match(sceneSource, /socket\.emit\('furnitureDemoInteract', \{ phase: 'start', instanceId, action \}\)/,
  "showroom E interactions use the server demo channel");
assert.match(sceneSource, /socket\.on\('furnitureDemoInteractionResult',[\s\S]{0,420}_setLocalActivity/,
  "showroom acknowledgements enter the normal local activity lifecycle");
assert.match(sceneSource, /_hideLegacyFurnitureShopObjects\(\)[\s\S]{0,900}this\._drawFurniture\(definition/,
  "real catalog art replaces the old furniture-shop display props");
assert.match(uiSource, /ctx\.showroom/,
  "furniture-shop UI consumes the server showroom projection");
assert.match(uiSource, /Try before you buy/,
  "furniture-shop UI advertises physical demos before purchase");
assert.match(sceneSource, /result\.refreshPending[\s\S]{0,300}homeSnapshotRequest/,
  "a committed purchase with a stale snapshot is refreshed without retrying charge");

console.log("PASS: frontend activity rebinding and placement teardown contracts");