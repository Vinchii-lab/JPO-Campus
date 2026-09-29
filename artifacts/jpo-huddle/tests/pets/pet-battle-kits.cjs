const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
const clientSource = fs.readFileSync(path.join(root, "public/index.html"), "utf8");

assert.doesNotMatch(clientSource, /pt-challenge-bot|Challenge Bot|petBattleBotChallenge/,
  "the pet profile should not expose a training-bot challenge path");
assert.doesNotMatch(serverSource, /socket\.on\("petBattleBotChallenge"/,
  "modified clients must not be able to request a training-bot battle");
assert.doesNotMatch(serverSource, /\bBOT_ID\b|PB_BOT|petBattleIsBot|petBattleBotMove|Training Bot|__petbot__/,
  "standard pet battles must not retain a hidden bot combat path");
assert.doesNotMatch(clientSource, /id="pet-bot-btn"|openPetTraining/,
  "the standalone Pet Arena entry should be removed");
assert.match(clientSource, /window\.openPetProfile[\s\S]*?petBattleGetProfile/,
  "pet clicks should open a server-backed battle profile");
assert.match(clientSource, /requestPetBattleProfile[\s\S]*?requestId[\s\S]*?payload\.requestId !== pbProfileRequestId/,
  "out-of-order profile responses must not replace the currently viewed pet");
assert.match(serverSource, /emitPetBattleProfile\(targetId, requestId[\s\S]*?requestId,[\s\S]*?reason/,
  "the server must correlate pet-profile and save responses with the client request");
assert.doesNotMatch(serverSource, /PB_DAILY_CAP|jpo_pet_battle_caps|daily_cap|dailyCap/,
  "Pet Battle XP must not have a daily reward cap");
assert.match(serverSource, /There is intentionally NO daily XP cap[\s\S]*?INSERT INTO jpo_pet_battles[\s\S]*?jpo_pet_battle_pairs/,
  "unlimited daily XP must retain settlement idempotency and rematch cooldown protection");
const combatantViewStart = serverSource.indexOf("function petBattleCombatantView(");
const combatantViewEnd = serverSource.indexOf("function petBattleStatusView(", combatantViewStart);
assert.ok(combatantViewStart >= 0 && combatantViewEnd > combatantViewStart, "battle combatant serializer not found");
assert.doesNotMatch(serverSource.slice(combatantViewStart, combatantViewEnd), /\bbuild\s*:/,
  "battle payloads must not expose either pet's exact training build");
assert.doesNotMatch(serverSource.slice(combatantViewStart, combatantViewEnd), /\b(?:hp|maxHp)\s*:/,
  "battle payloads must not expose exact HP values that reveal Vitality");
assert.match(serverSource, /function petBattlePublicRoundResult[\s\S]*?damagePct[\s\S]*?healthPct[\s\S]*?firstSide/,
  "public rounds should use percentage health/damage and relative initiative");
assert.match(serverSource, /const profile = \{[\s\S]*?kit: petBattlePublicKit[\s\S]*?\};\s*if \(self\) \{[\s\S]*?Object\.assign\(profile, \{[\s\S]*?build,/,
  "only the owner profile may receive build attributes and derived stats");
assert.match(clientSource, /BATTLE BUILD HIDDEN[\s\S]*?attributes and derived stats are private/,
  "coworker profiles should explain that battle attributes are private");
assert.match(clientSource, /payload\?\.action === 'buildSave'[\s\S]*?pbBuildRetryDraft[\s\S]*?requestPetBattleProfile/,
  "a rejected point commit should refresh authoritative state and retain a valid retry draft");
assert.match(clientSource, /obj\.on\('pointerdown'[\s\S]*?window\.openPetProfile/,
  "office pets should open their owner's battle profile when clicked");
assert.match(clientSource, /Start with 2 training points[\s\S]*?Earn Pet XP in coworker battles:[\s\S]*?\+3 win[\s\S]*?\+1 completed loss\/draw[\s\S]*?every 25 XP[\s\S]*?up to 12/i,
  "the owner pet profile should explain how coworker battles unlock training points");
assert.match(clientSource, /BATTLE ATTRIBUTE PROGRESS[\s\S]*?pet-panel-attribute-bar[\s\S]*?pet-panel-attribute-xp/,
  "the player's pet card should show progress toward the next attribute unlock");
assert.match(clientSource, /socket\.on\('petBattleXp'[\s\S]*?_myPetXp\[payload\.pet\] = payload\.xp[\s\S]*?renderPetPanel\(\)/,
  "battle XP should refresh the open pet card without waiting for a reload");
assert.doesNotMatch(clientSource, /id="rps-menu-(?:dm|challenge|petbattle|gift|trade|store)"/,
  "the avatar popover should not be cluttered with social and game actions");
for (const id of ["whisper", "challenge", "gift", "trade", "store"]) {
  assert.match(clientSource, new RegExp(`id=\"pf-action-${id}\"`),
    `${id} should be available as a coworker profile action card`);
}
assert.doesNotMatch(clientSource, /id="pf-action-petbattle"/,
  "Pet Battle should live on the pet profile rather than the player action grid");
assert.match(clientSource, /id="pf-pet-row"[\s\S]*?window\.openPetProfile/,
  "the pet row on a player profile should open the pet battle profile");
assert.match(clientSource, /id="pt-challenge"[\s\S]*?challengePetBattle\(targetId\)/,
  "a coworker's pet profile should provide the player battle action");
assert.doesNotMatch(clientSource, /bMinus|updatePbAttr\(a,\s*-1\)/,
  "the owner pet profile must not provide a subtract/reset control");
assert.match(serverSource, /const current = effectivePetBuild\(p, pet\)[\s\S]*?!petBattleBuildExtends\(current, clean\)/,
  "the server must compare a submitted build with the authoritative stored build");
assert.match(serverSource, /#>> ARRAY\[\$2::text, 'power'\][\s\S]*?#>> ARRAY\[\$2::text, 'focus'\][\s\S]*?RETURNING 1/,
  "the durable build update must atomically preserve every committed attribute floor");

const attributeStart = clientSource.indexOf("function _petAttributeBudget(");
const attributeEnd = clientSource.indexOf("function renderPetPanel(", attributeStart);
assert.ok(attributeStart >= 0 && attributeEnd > attributeStart, "pet attribute progress calculator not found");
const attributeSandbox = {};
vm.runInNewContext(
  `const PET_MYTHIC = new Set(["pet_unicorn", "pet_phoenix"]);
   function _petStageFor(pet, xp) {
     return PET_MYTHIC.has(pet) ? (xp >= 30 ? 3 : 1) : (xp >= 70 ? 3 : xp >= 30 ? 2 : 1);
   }
   ${clientSource.slice(attributeStart, attributeEnd)}
   globalThis.__petAttributeProgress = _petAttributeProgress;`,
  attributeSandbox,
  { filename: "client-pet-attribute-progress.js" },
);
const attributeProgress = attributeSandbox.__petAttributeProgress;
assert.deepEqual(
  JSON.parse(JSON.stringify(attributeProgress("pet_dog", 24))),
  { budget: 2, previous: 0, next: 25, gain: 1 },
  "a normal pet should show its first earned attribute point at 25 XP",
);
assert.deepEqual(
  JSON.parse(JSON.stringify(attributeProgress("pet_dog", 25))),
  { budget: 3, previous: 25, next: 30, gain: 1 },
  "the next normal-pet point after 25 XP should be the evolution point at 30 XP",
);
assert.deepEqual(
  JSON.parse(JSON.stringify(attributeProgress("pet_unicorn", 29))),
  { budget: 3, previous: 25, next: 30, gain: 2 },
  "a mythical pet should show both points granted by its final-form threshold",
);
assert.deepEqual(
  JSON.parse(JSON.stringify(attributeProgress("pet_dog", 200))),
  { budget: 12, previous: 200, next: null, gain: 0 },
  "attribute progress should stop at the twelve-point cap",
);

const extendsStart = serverSource.indexOf("function petBattleBuildExtends(");
const extendsEnd = serverSource.indexOf("// The build actually IN EFFECT", extendsStart);
assert.ok(extendsStart >= 0 && extendsEnd > extendsStart, "permanent build validator not found");
const extendsSandbox = {};
vm.runInNewContext(
  `const PB_ATTRS = ${JSON.stringify(["power", "vitality", "speed", "critical", "focus"])};
   ${serverSource.slice(extendsStart, extendsEnd)}
   globalThis.__petBattleBuildExtends = petBattleBuildExtends;`,
  extendsSandbox,
  { filename: "server-permanent-pet-build.js" },
);
const buildExtends = extendsSandbox.__petBattleBuildExtends;
const committed = { power: 2, vitality: 1, speed: 0, critical: 1, focus: 0 };
assert.equal(buildExtends(committed, { ...committed, focus: 1 }), true,
  "owners may spend a newly unlocked point");
assert.equal(buildExtends(committed, { power: 1, vitality: 1, speed: 1, critical: 1, focus: 0 }), false,
  "owners may not move a committed point to another attribute");

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
  "pet_frog", "pet_bat", "pet_unicorn", "pet_phoenix",
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
  pet_frog: ["rain-dance", "tongue"], pet_bat: ["void-slam", "wing"], pet_unicorn: ["halo-blessing", "horn"], pet_phoenix: ["phoenix-rebirth", "wing"],
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
const petArtStart = clientSource.indexOf("function _petArtUrl(");
const petArtEnd = clientSource.indexOf("function _petStageArt(", petArtStart);
assert.ok(petArtStart >= 0 && petArtEnd > petArtStart, "shared pet asset version helper exists");
vm.runInNewContext(
  `${clientSource.slice(petArtStart, petArtEnd)}
   ${clientSource.slice(actionPoseStart, actionPoseEnd)}
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
    assert.deepEqual(candidates.map(src => src.split("?")[0]), [exactSrc],
      `${pet} stage ${stage} must never fall back to another evolution's action art`);
    if (pet === "pet_bat")
      assert.match(candidates[0], /\?bat_rev=/, "bat action art retains its cache version");
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