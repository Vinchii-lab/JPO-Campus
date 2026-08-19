const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
const clientSource = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

// Load only the declarative server kit registry. Requiring server.js would
// start the live server, so this contract test evaluates the self-contained
// registry section in an empty VM instead.
const kitStart = serverSource.indexOf("const PB_DEFAULT_KIT =");
const kitEnd = serverSource.indexOf("function petBattleKit(", kitStart);
assert.ok(kitStart >= 0 && kitEnd > kitStart, "server kit registry not found");

const sandbox = {};
vm.runInNewContext(
  `${serverSource.slice(kitStart, kitEnd)}
   globalThis.__battleKits = { PB_DEFAULT_KIT, PB_KITS, PB_PASSIVE_HINTS };`,
  sandbox,
  { filename: "server-kit-registry.js" },
);

const { PB_KITS: kits } = sandbox.__battleKits;
const expectedPets = [
  "pet_duck", "pet_duck_snow",
  "pet_cat", "pet_cat_black", "pet_cat_snow",
  "pet_dog", "pet_dog_choco", "pet_dog_husky",
  "pet_bunny", "pet_bunny_cocoa",
  "pet_turtle", "pet_turtle_sapphire",
  "pet_dragon", "pet_dragon_crimson", "pet_dragon_obsidian",
  "pet_frog", "pet_unicorn", "pet_phoenix",
];
assert.deepEqual(Object.keys(kits).sort(), expectedPets.sort(), "every current pet needs exactly one server kit");

const kitIds = new Set();
const specialNames = new Set();
const ultimateNames = new Set();

for (const pet of expectedPets) {
  const kit = kits[pet];
  assert.ok(kit.id && !kitIds.has(kit.id), `${pet} needs a unique kit id`);
  for (const field of ["attackName", "guardName", "specialName", "ultimateName"]) {
    assert.ok(kit[field], `${pet} is missing ${field}`);
  }
  for (const field of ["attackHint", "guardHint", "specialHint", "ultimateHint"]) {
    assert.ok(kit[field], `${pet} is missing ${field}`);
  }
  kitIds.add(kit.id);
  specialNames.add(kit.specialName);
  ultimateNames.add(kit.ultimateName);
}

assert.equal(kitIds.size, expectedPets.length, "kit ids must be unique");
assert.equal(specialNames.size, expectedPets.length, "special move names must be unique");
assert.equal(ultimateNames.size, expectedPets.length, "ultimate move names must be unique");

const expectedProfiles = {
  pet_duck: ["peck", "peck"], pet_duck_snow: ["peck", "peck"],
  pet_cat: ["scratch", "scratch"], pet_cat_black: ["scratch", "scratch"], pet_cat_snow: ["scratch", "scratch"],
  pet_dog: ["bite", "bite"], pet_dog_choco: ["bite", "bite"], pet_dog_husky: ["bite", "bite"],
  pet_bunny: ["kick", "kick"], pet_bunny_cocoa: ["kick", "kick"],
  pet_turtle: ["shell", "shell"], pet_turtle_sapphire: ["shell", "shell"],
  pet_dragon: ["wing", "wing"], pet_dragon_crimson: ["wing", "wing"], pet_dragon_obsidian: ["wing", "wing"],
  pet_frog: ["tongue", "tongue"], pet_unicorn: ["beam", "horn"], pet_phoenix: ["wing", "wing"],
};
const attackMotions = new Set();
const attackEffects = new Set();
for (const pet of expectedPets) {
  const [motion, effect] = expectedProfiles[pet];
  const escapedPet = pet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(clientSource, new RegExp(`${escapedPet}:?\\s*\\{[^}]*motion:\\s*'${motion}'[^}]*effect:\\s*'${effect}'`),
    `client attack profile is missing ${pet}`);
  assert.match(clientSource, new RegExp(`\\.pb-motion-${motion}\\b`), `client is missing the ${motion} animation`);
  assert.match(clientSource, new RegExp(`\\.pb-hit-${effect}\\b`), `client is missing the ${effect} contact effect`);
  attackMotions.add(motion);
  attackEffects.add(effect);

  const stem = pet.replace(/^pet_/, "");
  const hasActionPose = ["", "_s2", "_s3"].some(form =>
    fs.existsSync(path.join(root, "public/assets/pets/anim", `${stem}${form}_action.png`)));
  assert.ok(hasActionPose, `${pet} needs at least one reusable action pose`);
}
assert.ok(attackMotions.size >= 8, "the roster needs varied animal attack motion");
assert.ok(attackEffects.size >= 8, "the roster needs varied on-target contact effects");
assert.match(clientSource, /function pbShowActionPose\(/, "battle attacks must swap to existing action art");
assert.match(clientSource, /function pbSpawnAnimalHit\(/, "battle attacks must create animal-specific contact feedback");
const wingKeyframes = clientSource.slice(
  clientSource.indexOf("@keyframes pb-motion-wing"),
  clientSource.indexOf("@keyframes pb-motion-beam"),
);
assert.doesNotMatch(wingKeyframes, /--pb-flight/, "flying attacks should animate in place, not slide across the arena");
assert.match(clientSource, /pb-sprite-container\.pb-is-flying\s*\{\s*animation:\s*pb-idle-hover/,
  "flying pets should visibly hover between attacks");
assert.match(clientSource, /pet_dragon'.*pet_dragon_crimson'.*pet_dragon_obsidian'.*pet_phoenix/s,
  "every flying battle pet should receive the hover treatment");

const statsSource = serverSource.slice(
  serverSource.indexOf("function petBattleStats("),
  serverSource.indexOf("// ── Helpers", serverSource.indexOf("function petBattleStats(")),
);
assert.doesNotMatch(statsSource, /kit\.(?:hpMult|atkMult|guardBonus|critBonus|dodgeBonus|specialMult|ultimateMult)/,
  "species must not change combat stats");

const resolverSource = serverSource.slice(
  serverSource.indexOf("function petBattleResolveRound("),
  serverSource.indexOf("// Emit a semantic event", serverSource.indexOf("function petBattleResolveRound(")),
);
for (const dispatch of [
  /applyEffect\(A/, /applyEffect\(D/,
  /applyGuardIdentity\(A/, /applyGuardIdentity\(D/,
  /applyCounter\(A/, /applyCounter\(D/,
  /tick\(A/, /tick\(D/,
]) {
  assert.doesNotMatch(resolverSource, dispatch, "visual kits must not dispatch hidden combat effects");
}

console.log(`PASS ${expectedPets.length} animal attack profiles, ${attackMotions.size} motions, ${attackEffects.size} contact effects`);