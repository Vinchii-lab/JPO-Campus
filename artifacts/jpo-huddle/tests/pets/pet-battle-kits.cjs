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

const { PB_KITS: kits, PB_PASSIVE_HINTS: passiveHints } = sandbox.__battleKits;
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

const allowedEffects = new Set([
  "none", "weaken", "chill", "freeze", "bleed", "burn", "inferno",
  "poison", "expose", "power", "counter", "shield", "greatShield",
  "heal", "aegis", "drain", "voidDrain", "rally", "evade", "charge",
  "burrow", "regen", "storm", "phoenixBurn", "rebirth",
]);
const kitIds = new Set();
const specialNames = new Set();
const ultimateNames = new Set();
const motions = new Set();

for (const pet of expectedPets) {
  const kit = kits[pet];
  assert.ok(kit.id && !kitIds.has(kit.id), `${pet} needs a unique kit id`);
  assert.ok(kit.passive && passiveHints[kit.id], `${pet} needs an accurate public passive description`);
  assert.ok(kit.motion, `${pet} needs a movement family`);
  assert.ok(allowedEffects.has(kit.specialEffect), `${pet} has an unsupported special effect`);
  assert.ok(allowedEffects.has(kit.ultimateEffect), `${pet} has an unsupported ultimate effect`);
  for (const field of ["attackName", "guardName", "specialName", "ultimateName"]) {
    assert.ok(kit[field], `${pet} is missing ${field}`);
  }
  for (const field of ["attackHint", "guardHint", "specialHint", "ultimateHint"]) {
    assert.ok(kit[field], `${pet} is missing ${field}`);
  }
  assert.ok(kit.hpMult >= 0.85 && kit.hpMult <= 1.2, `${pet} HP multiplier is outside the side-grade budget`);
  assert.ok(kit.atkMult >= 0.85 && kit.atkMult <= 1.2, `${pet} attack multiplier is outside the side-grade budget`);

  kitIds.add(kit.id);
  specialNames.add(kit.specialName);
  ultimateNames.add(kit.ultimateName);
  motions.add(kit.motion);
}

assert.equal(kitIds.size, expectedPets.length, "kit ids must be unique");
assert.equal(specialNames.size, expectedPets.length, "special move names must be unique");
assert.equal(ultimateNames.size, expectedPets.length, "ultimate move names must be unique");
assert.ok(motions.size >= 8, "the roster needs genuinely varied motion families");

for (const motion of motions) {
  assert.match(clientSource, new RegExp(`\\.pb-motion-${motion}\\b`), `client is missing the ${motion} animation`);
}
for (const pet of expectedPets) {
  assert.match(clientSource, new RegExp(`${pet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*'${kits[pet].motion}'`),
    `client motion fallback is missing ${pet}`);
}

console.log(`PASS ${expectedPets.length} distinct pet kits, ${motions.size} motion families, complete public metadata`);