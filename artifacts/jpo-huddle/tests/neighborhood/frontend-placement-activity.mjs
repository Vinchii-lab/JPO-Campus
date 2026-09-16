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
assert.match(sceneSource, /if \(this\.activity\) \{[\s\S]{0,600}setVelocity\?\.\(0, 0\)/,
  "accepted activity clears leftover local velocity before disabling the body");
assert.match(sceneSource, /if \(!this\.activity && !this\._activityPending\) \{\s*movement\?\.tick\(delta, this\.location/,
  "activity anchors do not emit periodic playerMove corrections while active or pending");
assert.match(sceneSource, /if \(this\.activity && serverPlayer\.reason && !serverPlayer\.activity\) return;/,
  "a delayed movement correction without activity cannot clear an accepted local action");

assert.match(sceneSource, /const teardownPlacement = \(\) => \{[\s\S]{0,240}selectedInstance = null;[\s\S]{0,240}hidePlacementControls\(\);/,
  "placement teardown resets selection and hides the controls centrally");
assert.match(sceneSource, /socket\.on\('homeActionResult', \(result\) => \{[\s\S]{0,180}teardownPlacement\(\);/,
  "server action completion tears down placement");
assert.match(sceneSource, /const applyHomeState = \(state\) => \{[\s\S]{0,1800}incomingRevision <= currentRevision/,
  "all full home states share a strict owner/revision gate");
assert.match(sceneSource, /socket\.on\('homeSnapshot', \(state\) => \{[\s\S]{0,120}applyHomeState\(state\)/,
  "snapshot events use the centralized full-state apply path");
assert.match(sceneSource, /setHomeState\(state\) \{[\s\S]{0,80}applyHomeState\(state\);/,
  "house-color full states cannot bypass the owner/revision gate");
assert.match(sceneSource, /socket\.on\('homePurchaseResult',[\s\S]{0,900}applyHomeState\(result\.home\)/,
  "purchase full states cannot bypass the owner/revision gate");
assert.match(sceneSource, /socket\.on\('homeConstructionResult',[\s\S]{0,260}applyHomeState\(result\.home\)/,
  "construction full states cannot bypass the owner/revision gate");
assert.match(sceneSource, /if \(result\.home\) applyHomeState\(result\.home\);/,
  "location transition full states cannot bypass the owner/revision gate");
assert.match(sceneSource, /shutdown\(\) \{[\s\S]{0,520}teardownPlacement\(\);/,
  "scene shutdown tears down placement");
assert.match(uiSource, /if \(!ctx\.active\) \{[\s\S]{0,100}container\.hidden = true;[\s\S]{0,100}container\.innerHTML = '';/,
  "inactive placement controls remove stale actionable markup");
assert.match(sceneSource, /_beginPlacement = \(\) => \{[\s\S]{0,400}this\._showPlacementControls\(\);/,
  "starting a placement shows persistent finish/cancel controls before a map click");
assert.match(sceneSource, /if \(this\.ghost\.getData\?\.\('blocked'\) === true\) \{[\s\S]{0,180}return;/,
  "an invalid placement click remains movable rather than locking an unusable preview");
assert.match(uiSource, /ghost-placement-status[\s\S]{0,240}placementMessage/,
  "placement controls explain whether to select, confirm, or cancel");
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