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

const expectedUltimates = {
  pet_duck: ["splash-dive", "peck"], pet_duck_snow: ["snow-dive", "peck"],
  pet_cat: ["boss-slam", "scratch"], pet_cat_black: ["void-blink", "scratch"], pet_cat_snow: ["frost-coronation", "scratch"],
  pet_dog: ["solar-leap", "bite"], pet_dog_choco: ["cocoa-pounce", "bite"], pet_dog_husky: ["moonlit-blink", "bite"],
  pet_bunny: ["blizzard-binky", "kick"], pet_bunny_cocoa: ["drift-donuts", "kick"],
  pet_turtle: ["shell-garden", "shell"], pet_turtle_sapphire: ["frost-stomp", "shell"],
  pet_dragon: ["neon-ignition", "wing"], pet_dragon_crimson: ["inferno-breath", "wing"], pet_dragon_obsidian: ["void-slam", "wing"],
  pet_frog: ["rain-dance", "tongue"], pet_unicorn: ["halo-blessing", "horn"], pet_phoenix: ["phoenix-rebirth", "wing"],
};

const profileStart = clientSource.indexOf("const PB_ATTACK_PROFILE_BY_PET =");
const profileEnd = clientSource.indexOf("function getPbTheme(", profileStart);
assert.ok(profileStart >= 0 && profileEnd > profileStart, "client move choreography registry not found");
const clientSandbox = {};
vm.runInNewContext(
  `${clientSource.slice(profileStart, profileEnd)}
   globalThis.__battleProfiles = { PB_ATTACK_PROFILE_BY_PET, PB_DEFAULT_ATTACK_PROFILE, getPbAttackProfile };`,
  clientSandbox,
  { filename: "client-battle-profiles.js" },
);
const {
  PB_ATTACK_PROFILE_BY_PET: profiles,
  getPbAttackProfile,
} = clientSandbox.__battleProfiles;

assert.deepEqual(Object.keys(profiles).sort(), expectedPets.sort(),
  "every current pet needs exactly one client animation profile");
const moveIds = ["attack", "special", "ultimate"];
const choreographies = new Set();
const attackEffects = new Set();
for (const pet of expectedPets) {
  const [ultimateChoreo, effect] = expectedUltimates[pet];
  const resolved = moveIds.map(moveId => getPbAttackProfile(pet, moveId));
  assert.equal(new Set(resolved.map(profile => profile.choreo)).size, 3,
    `${pet} Attack, Special, and Ultimate must use different office choreographies`);
  assert.equal(resolved[2].choreo, ultimateChoreo, `${pet} lost its signature Ultimate choreography`);
  assert.ok(resolved.every(profile => profile.effect === effect), `${pet} lost its contact effect`);
  assert.ok(resolved.every(profile => profile.label && profile.label !== "HIT!"),
    `${pet} needs a visible label for every move`);
  assert.match(clientSource, new RegExp(`\\.pb-hit-${effect}\\b`), `client is missing the ${effect} contact effect`);
  for (const { choreo } of resolved) {
    assert.match(clientSource, new RegExp(`case '${choreo}'|choreo === '${choreo}'`),
      `battle adapter is missing ${pet}'s ${choreo} office choreography`);
    choreographies.add(choreo);
  }
  attackEffects.add(effect);

  const stem = pet.replace(/^pet_/, "");
  const hasActionPose = ["", "_s2", "_s3"].some(form =>
    fs.existsSync(path.join(root, "public/assets/pets/anim", `${stem}${form}_action.png`)));
  assert.ok(hasActionPose, `${pet} needs at least one reusable action pose`);
}
assert.ok(choreographies.size >= 25, "the roster needs distinct lower-tier and signature office choreographies");
assert.ok(attackEffects.size >= 8, "the roster needs varied on-target contact effects");
assert.match(clientSource, /function pbShowActionPose\(/, "battle attacks must swap to existing action art");
assert.match(clientSource, /Choreography varies by move, but the character never changes visible[\s\S]*const suffix = stage >= 3/,
  "move choreography must preserve the pet's current visible form");
assert.doesNotMatch(clientSource, /preferredSuffix\s*=\s*moveId/,
  "moves must not select a different evolution's action art");
const actionPoseStart = clientSource.indexOf("function pbActionPoseCandidates(");
const actionPoseEnd = clientSource.indexOf("const pbActionPoseAvailability", actionPoseStart);
const actionPoseSandbox = {};
vm.runInNewContext(
  `${clientSource.slice(actionPoseStart, actionPoseEnd)}
   globalThis.__pbActionPoseCandidates = pbActionPoseCandidates;`,
  actionPoseSandbox,
  { filename: "client-action-pose-candidates.js" },
);
for (const pet of expectedPets) {
  const stem = pet.replace(/^pet_/, "");
  for (const stage of [1, 2, 3]) {
    const suffix = stage === 3 ? "_s3" : stage === 2 ? "_s2" : "";
    const exactSrc = `assets/pets/anim/${stem}${suffix}_action.png`;
    const candidates = Array.from(actionPoseSandbox.__pbActionPoseCandidates(pet, stage));
    assert.deepEqual(candidates, [exactSrc],
      `${pet} stage ${stage} must never fall back to another evolution's action art`);
    if (stage > 1 && !fs.existsSync(path.join(root, "public", exactSrc))) {
      const lowerForm = stage === 3 ? `${stem}_s2_action.png` : `${stem}_action.png`;
      assert.ok(!candidates.some(src => src.endsWith(lowerForm)),
        `${pet} stage ${stage} must keep its idle art when exact action art is unavailable`);
    }
  }
}
assert.match(clientSource, /function pbSpawnAnimalHit\(/, "battle attacks must create animal-specific contact feedback");
assert.match(clientSource, /function pbPlayOfficeChoreo\(/, "battle attacks must use the office choreography adapter");
assert.match(clientSource, /pbPlayOfficeChoreo\(myPrefix, oppPrefix, attacker, attRes\.move/,
  "the authoritative battle round queue must pass the resolved move into the choreography adapter");
const clientChoreoResolverSource = clientSource.slice(
  clientSource.indexOf("function pbResolveOfficeChoreo("),
  clientSource.indexOf("async function pbPlayOfficeChoreo("),
);
assert.match(clientChoreoResolverSource, /getPbAttackProfile\(petId, moveId\)\.choreo/,
  "the choreography resolver must select by both pet and move");
assert.doesNotMatch(clientChoreoResolverSource, /stage|Math\.random/,
  "move choreography must be deterministic and must not depend on evolution stage");
for (const signature of [
  "pbTravelRings(from, to", "pbWeather('snow'", "pbWeather('rain'",
  "assets/pets/shell_sapphire.png", "pbFlameBreath(mouth, to", "pbAfterimages(attPrefix",
  "case 'cat-stretch'", "case 'cat-pounce'", "case 'boss-slam'",
  "case 'dragon-sputter'", "case 'smoke-breath'", "case 'phoenix-rebirth'",
]) {
  assert.ok(clientSource.includes(signature), `battle choreography is missing signature beat: ${signature}`);
}
const dragonBreathSource = clientSource.slice(
  clientSource.indexOf("case 'neon-ignition'"),
  clientSource.indexOf("case 'rain-dance'"),
);
assert.doesNotMatch(dragonBreathSource, /pbBeam\(/,
  "dragon fire must render as a flame-and-smoke plume, never a simple beam");
const obsidianSource = clientSource.slice(
  clientSource.indexOf("case 'void-slam'"),
  clientSource.indexOf("case 'rain-dance'"),
);
assert.match(obsidianSource, /pbTravelRings[\s\S]*?pbFlameBreath/,
  "Obsidian's signature move must combine the heavy stomp with fire breath");
const wingKeyframes = clientSource.slice(
  clientSource.indexOf("@keyframes pb-motion-wing"),
  clientSource.indexOf("@keyframes pb-motion-beam"),
);
assert.doesNotMatch(wingKeyframes, /--pb-flight/, "flying attacks should animate in place, not slide across the arena");
assert.match(clientSource, /pb-sprite-container\.pb-is-flying:not\(\.pb-in-action\)[\s\S]*?animation:\s*pb-idle-hover/,
  "dragon and phoenix battle idles should remain visibly airborne");
assert.match(clientSource, /function pbFlightFrames[\s\S]*?return \[1, 2, 3\]\.map[\s\S]*?_walk\$\{n\}/,
  "dragon and phoenix battle idles should cycle all three exact-form wing frames");
assert.match(clientSource, /setInterval\(showFrame,\s*145\)/,
  "dragon and phoenix wing frames should keep flapping between battle actions");
assert.match(clientSource, /classList\.toggle\('pb-is-flying', flying\)/,
  "every dragon and phoenix battle sprite should receive the airborne idle");
assert.match(clientSource, /if \(flying\) \{[\s\S]*?petObj\._animSet\.walk/,
  "office dragons and phoenixes should keep cycling flight frames while stationary");

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

console.log(`PASS ${expectedPets.length} pets × 3 distinct move choreographies, ${choreographies.size} sequences, ${attackEffects.size} contact effects`);