import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";
import { seasonNow, canIssueItem, HALLOWEEN_RELEASE_START, HALLOWEEN_RELEASE_END } from "../season.mjs";

const root = new URL("../", import.meta.url);
const server = readFileSync(new URL("server.js", root), "utf8");
const html = readFileSync(new URL("public/index.html", root), "utf8");
const neighborhood = readFileSync(new URL("public/neighborhood.js", root), "utf8");
const at = date => new Date(date);
const released = at("2026-09-29T12:00:00Z");

test("baby unicorn retains static art without missing animation requests", () => {
  const start = html.indexOf("        for (const p of PETS) {", html.indexOf("// Animated pet frames"));
  const end = html.indexOf("// Wearables are 2-frame sheets", start);
  assert.ok(start >= 0 && end > start, "pet animation preload loop exists");
  const requests = [];
  vm.runInNewContext(html.slice(start, end), {
    PETS: [{ id: "pet_unicorn" }, { id: "pet_phoenix" }, { id: "pet_bat" }],
    _petArtUrl: url => url,
    load: { image: (key, url) => requests.push({ key, url }) },
  });
  assert.equal(requests.length, 10, "other pets retain all five animation loads");
  assert.ok(requests.every(({ url }) => !url.includes("unicorn")));
  assert.ok(existsSync(new URL("public/assets/pets/pet_unicorn.png", root)), "authored static baby remains");
  for (const frame of ["walk1", "walk2", "walk3", "sit", "action"])
    assert.ok(existsSync(new URL(`public/assets/pets/anim/unicorn_s3_${frame}.png`, root)), "grown animation remains");
});

test("bounded release and UTC calendar have a single October 10 boundary", () => {
  assert.equal(seasonNow(at("2026-10-26"), true), "halloween");
  assert.equal(seasonNow(at("2026-10-27"), true), "christmas");
  assert.equal(seasonNow(at("2026-10-27"), false), "christmas");
  assert.equal(canIssueItem("santahat", at("2026-10-27")), true);
  assert.equal(canIssueItem("witchhat", at("2026-10-27")), false);
  assert.equal(seasonNow(at("2026-12-27")), "newyears");
  assert.equal(seasonNow(new Date(HALLOWEEN_RELEASE_START - 1), true), "rainy");
  assert.equal(seasonNow(new Date(HALLOWEEN_RELEASE_START), true), "halloween");
  assert.equal(seasonNow(new Date(HALLOWEEN_RELEASE_END - 1), true), "halloween");
  assert.equal(seasonNow(new Date(HALLOWEEN_RELEASE_END), true), "christmas");
  assert.equal(seasonNow(released, false), "rainy");
  for (const [date, expected] of [
    ["2027-08-01", "rainy"], ["2027-10-09", "rainy"], ["2027-10-10", "halloween"],
    ["2027-11-04", "halloween"], ["2027-11-05", "christmas"], ["2027-12-26", "christmas"],
    ["2027-12-27", "newyears"], ["2028-01-15", "newyears"], ["2028-01-16", "valentines"],
    ["2028-02-16", "valentines"], ["2028-02-17", null],
  ]) assert.equal(seasonNow(at(date), true), expected, date);
});

test("seasonal issuance is denied outside its season; frog shelving is unconditional", () => {
  for (const item of ["witchhat", "pumpkinhead", "vampirecape", "pet_bat"]) {
    assert.equal(canIssueItem(item, released, true), true);
    assert.equal(canIssueItem(item, released, false), false);
    assert.equal(canIssueItem(item, at("2026-11-05"), true), false);
  }
  for (const date of ["2026-09-29", "2027-08-01", "2027-10-31"])
    assert.equal(canIssueItem("pet_frog", at(date), false), false);
  assert.equal(canIssueItem("raincoat", released, true), false);
  assert.equal(canIssueItem("raincoat", released, false), true);
  assert.equal(canIssueItem("batwings", released, false), true);
});

// Exercise the actual socket handler bodies without connecting to a DB or
// starting a server. In-memory fixtures exist only in this regression test.
function handlerSource(name) {
  const start = server.indexOf(`  socket.on("${name}",`);
  assert.notEqual(start, -1, name);
  const end = server.indexOf("\n  });", start) + "\n  });".length;
  return server.slice(start, end);
}
function harness({ date = released, email = "" } = {}) {
  const player = { name: "Season test", email, coins: 60000, cosmetics: [], pet: "", petXp: {}, slots: {}, equipped: "", wings: "" };
  const handlers = {}, events = [], broadcasts = [], queries = [];
  const context = vm.createContext({
    socket: { id: "test", on: (name, fn) => { handlers[name] = fn; }, emit: (...args) => events.push(args) },
    players: { test: player }, canIssueItem: id => canIssueItem(id, date, true),
    salePrice: price => price, takeToken: () => true, buyBucket: {},
    inAnyMatch: () => false, inActiveRound: () => false, locationOf: () => "hq",
    emitToLocation: (...args) => broadcasts.push(args),
    petStageFor: p => (p.petXp[p.pet] || 0) >= 70 ? 3 : (p.petXp[p.pet] || 0) >= 30 ? 2 : 1,
    pool: { query: async (...args) => { queries.push(args); return { rows: [] }; } },
    console: { log() {}, error(...args) { throw new Error(args.join(" ")); } },
  });
  for (const name of ["SHOP", "PETS", "WEAR_SLOT", "SLOT_COL"]) {
    const match = server.match(new RegExp(`const ${name}\\s*=\\s*(\\{[\\s\\S]*?\\});`));
    assert.ok(match, name);
    vm.runInContext(`const ${name} = ${match[1]};`, context);
  }
  vm.runInContext(`
    const RARE_COSMETICS = new Set(["goldenwings", "phoenixwings"]);
    const RARE_PETS = new Set(["pet_unicorn", "pet_phoenix"]);
    const WINGS_IDS = new Set(["batwings"]);
    const SLOT_KEYS = ["top", "bottom", "neckwear", "held", "feet"];
    const emptySlots = () => ({top:"",bottom:"",neckwear:"",held:"",feet:""});
  `, context);
  for (const name of ["buyCosmetic", "buyPet", "equipCosmetic", "equipPet"])
    vm.runInContext(handlerSource(name), context);
  return { player, handlers, events, broadcasts, queries };
}

test("real purchase handlers charge prices, stack cape, replace head slot, and broadcast slots", async () => {
  const h = harness();
  for (const item of ["witchhat", "vampirecape", "batwings", "pumpkinhead"])
    await h.handlers.buyCosmetic({ item });
  await h.handlers.buyPet({ item: "pet_bat" });
  assert.equal(h.player.coins, 60000 - 6500 - 13000 - 12000 - 10000 - 18000);
  assert.equal(h.player.equipped, "pumpkinhead");
  assert.equal(h.player.slots.neckwear, "vampirecape");
  assert.equal(h.player.wings, "batwings");
  assert.equal(h.player.pet, "pet_bat");
  assert.ok(h.broadcasts.some(([, name, p]) => name === "playerCosmeticUpdate" && p.slots.neckwear === "vampirecape"));
  const balance = h.player.coins;
  await h.handlers.buyPet({ item: "pet_bat" });
  assert.equal(h.player.coins, balance, "duplicate purchase must not charge");
  await h.handlers.equipCosmetic({ item: "", slot: "neckwear" });
  assert.equal(h.player.slots.neckwear, "");
  assert.equal(h.player.equipped, "pumpkinhead");
  assert.equal(h.player.wings, "batwings");
});

test("stale-client buys never reach persistence; owned frogs and rainy gear stay equipable", async () => {
  for (const email of ["", "test@example.invalid"]) {
    const h = harness({ date: at("2026-11-05"), email });
    for (const item of ["witchhat", "pumpkinhead", "vampirecape", "raincoat"])
      await h.handlers.buyCosmetic({ item });
    for (const item of ["pet_bat", "pet_frog"])
      await h.handlers.buyPet({ item });
    assert.equal(h.queries.length, 0);
    assert.equal(h.player.coins, 60000);
    assert.deepEqual(h.player.cosmetics, []);
    assert.equal(h.events.filter(([name]) => name === "shopError").length, 6);
  }
  const h = harness();
  h.player.cosmetics.push("pet_frog", "raincoat", "umbrella", "rainboots");
  h.player.petXp.pet_frog = 81;
  await h.handlers.equipPet({ item: "pet_frog" });
  for (const item of ["raincoat", "umbrella", "rainboots"])
    await h.handlers.equipCosmetic({ item });
  assert.equal(h.player.pet, "pet_frog");
  assert.equal(h.player.petXp.pet_frog, 81);
  assert.equal(h.player.slots.top, "raincoat");
  assert.equal(h.player.slots.held, "umbrella");
  assert.equal(h.player.slots.feet, "rainboots");
});

test("owned-only transfer paths do not acquire seasonal restrictions", () => {
  for (const name of ["equipPet", "equipCosmetic", "storeAccept", "sendItemGift", "tradeOffer", "tradeAccept"])
    assert.doesNotMatch(handlerSource(name), /canIssueItem|seasonNow/);
  const calls = server.match(/!canIssueItem\(item\)/g) || [];
  assert.equal(calls.length, 2, "only authoritative fresh-purchase paths gate issuance");
  assert.ok(handlerSource("ownerGrantPet").includes('if (!em || !RARE_IDS.has(pet))'), "owner grants are rare-only, not an alternate frog issue route");
});

test("persistent purchases use existing atomic ownership/coins guards and correct columns", async () => {
  const h = harness({ email: "test@example.invalid" });
  await h.handlers.buyCosmetic({ item: "vampirecape" });
  await h.handlers.buyCosmetic({ item: "witchhat" });
  await h.handlers.buyPet({ item: "pet_bat" });
  assert.equal(h.queries.length, 3);
  for (const [sql] of h.queries) {
    assert.match(sql, /coins >= \$2 AND NOT \(\$3 = ANY\(cosmetics\)\)/);
    assert.match(sql, /cosmetics = array_append\(cosmetics, \$3\)/);
  }
  assert.match(h.queries[0][0], /equipped_neckwear = \$3/);
  assert.match(h.queries[1][0], /equipped_cosmetic = \$3/);
  assert.match(h.queries[2][0], /equipped_pet = \$3/);
  assert.deepEqual(Array.from(h.queries[0][1]), ["test@example.invalid", 13000, "vampirecape"]);
  assert.deepEqual(Array.from(h.queries[2][1]), ["test@example.invalid", 18000, "pet_bat"]);
});

test("bat and preserved frog retain normal three-stage XP thresholds and race stems", () => {
  const start = server.indexOf("const PET_EVOLVE_XP =");
  const end = server.indexOf("// ── Pet XP travels", start);
  const context = vm.createContext({});
  vm.runInContext(server.slice(start, end), context);
  for (const pet of ["pet_bat", "pet_frog"]) {
    for (const [xp, stage] of [[0, 1], [29, 1], [30, 2], [69, 2], [70, 3], [100, 3]])
      assert.equal(vm.runInContext(`petStageOfPet("${pet}", ${xp})`, context), stage);
  }
  const raceStart = server.indexOf("function petStemForRace(");
  const raceEnd = server.indexOf("\n}", raceStart) + 2;
  vm.runInContext(server.slice(raceStart, raceEnd), context);
  for (const [stage, stem] of [[1, "bat"], [2, "bat_s2"], [3, "bat_s3"]])
    assert.equal(vm.runInContext(`petStemForRace("pet_bat", ${stage})`, context), stem);
});

test("authoritative reconnect/live-season lifecycle and shared neighborhood pet methods are wired", () => {
  assert.match(server, /io\.on\("connection", \(socket\) => \{[\s\S]*?socket\.emit\("seasonState", seasonSnapshot\(\)\)/);
  assert.match(server, /io\.emit\("seasonState", seasonSnapshot\(\)\)/);
  assert.doesNotMatch(html, /getMonth\(\)|getDate\(\).*wxRainy/);
  assert.match(html, /function seasonNow\(\) \{ return _activeSeason; \}/);
  assert.match(html, /window\.addEventListener\('seasonChanged', this\._syncSeason\)/);
  assert.match(html, /this\.tweens\.killTweensOf\(this\._wx\[key\]\)/);
  assert.match(html, /this\._wx === wx/);
  assert.match(html, /this\._halloweenCleanup = window\.HalloweenOffice\?\.mount\(this\)/);
  for (const method of ["_makePet", "_stepPet", "_placePetAcc"])
    assert.ok(neighborhood.includes(`this._office('${method}', ...args)`), method);
});

test("actual client lifecycle clears rain/tweens, refreshes stock, and remounts decor after reconnect", () => {
  const handlers = {}, window = new EventTarget();
  let mounted = 0, cleaned = 0, refreshed = 0;
  window.HalloweenOffice = { mount: () => { mounted++; return () => { cleaned++; }; } };
  const context = vm.createContext({
    window, Event, _ownedItems: ["pet_frog", "raincoat"],
    socket: { on: (name, fn) => { handlers[name] = fn; } },
    document: { getElementById: () => ({ classList: { contains: () => true } }) },
    _refreshShopUI: () => { refreshed++; },
  });
  const start = html.indexOf("    let _activeSeason =");
  const end = html.indexOf("\n", html.indexOf("const _seasonRowOk =", start));
  vm.runInContext(html.slice(start, end), context);
  assert.equal(vm.runInContext("seasonNow()", context), null);
  handlers.seasonState({ season: "halloween" });
  assert.equal(vm.runInContext("_seasonRowOk({id:'witchhat',season:'halloween'})", context), true);
  assert.equal(vm.runInContext("_seasonRowOk({id:'pet_frog',season:'rainy'})", context), true);
  assert.equal(vm.runInContext("_seasonRowOk({id:'rainboots',season:'rainy'})", context), false);
  const killed = [], objects = [], shutdown = {};
  function object() {
    const o = { destroyed: false, alpha: 0, tilePositionX: 0, tilePositionY: 0 };
    for (const name of ["setScrollFactor", "setDepth", "setAlpha", "setTileScale"]) o[name] = () => o;
    o.destroy = () => { o.destroyed = true; };
    objects.push(o);
    return o;
  }
  const scene = {
    _wx: null, textures: { exists: () => true }, scale: { width: 800, height: 600 },
    add: { rectangle: object, tileSprite: object },
    tweens: { killTweensOf: o => killed.push(o) },
    events: { once: (name, fn) => { shutdown[name] = fn; } },
  };
  context.scene = scene;
  const syncStart = html.indexOf("        this._syncSeason = () => {");
  const syncEnd = html.indexOf("        // ── Prop Hunt scene handlers", syncStart);
  vm.runInContext(`(function(){${html.slice(syncStart, syncEnd)}}).call(scene)`, context);
  assert.equal(mounted, 1);
  handlers.seasonState({ season: "rainy" });
  assert.equal(cleaned, 1);
  assert.equal(objects.length, 4);
  assert.ok(scene._wx);
  handlers.seasonState({ season: "halloween" });
  assert.equal(scene._wx, null);
  assert.equal(killed.length, 4);
  assert.ok(objects.every(o => o.destroyed));
  assert.equal(mounted, 2);
  handlers.disconnect();
  assert.equal(cleaned, 2);
  assert.equal(vm.runInContext("seasonNow()", context), null);
  handlers.seasonState({ season: "halloween" });
  assert.equal(mounted, 3);
  assert.equal(refreshed, 4);
  shutdown.shutdown();
  assert.equal(cleaned, 3);
  handlers.seasonState({ season: "halloween" });
  assert.equal(mounted, 3, "shutdown removes the season listener");
});

test("all bat stage/frame assets and native wearable sheets match renderer contract", () => {
  for (const stage of ["", "_s2", "_s3"]) {
    for (const name of [`pets/pet_bat${stage}.png`, ...["walk1", "walk2", "walk3", "sit", "action"].map(f => `pets/anim/bat${stage}_${f}.png`)]) {
      const path = new URL(`public/assets/${name}`, root);
      assert.ok(existsSync(path), name);
      const png = readFileSync(path);
      assert.equal(png.readUInt32BE(16), 64, name);
      assert.equal(png.readUInt32BE(20), 64, name);
      assert.equal(png[25], 6, `${name}: RGBA transparency`);
    }
  }
  for (const [name, height] of [["witchhat", 13], ["pumpkinhead", 13], ["vampirecape", 14]]) {
    const png = readFileSync(new URL(`public/assets/wear_${name}.png`, root));
    assert.equal(png.readUInt32BE(16), 48);
    assert.equal(png.readUInt32BE(20), height);
  }
  assert.match(html, /WEARABLE_DEFS\.vampirecape\.poseLayer = true/);
  assert.match(html, /witchhat:'head', pumpkinhead:'head'/);
  assert.match(server, /const PET_EVOLVE_XP = \[30, 70\]/);
  assert.match(html, /const PET_EVOLVE_XP = \[30, 70\]/);
  assert.match(html, /'pet_frog', 'pet_bat'/, "all evolution stages preload");
});