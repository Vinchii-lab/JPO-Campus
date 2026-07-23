import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import path from "path";
import { readFileSync } from "fs";
import pg from "pg";
import crypto from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";  // no insecure default: admin features stay disabled until this env/secret is set
// Signs the resume tokens that let a returning browser auto-rejoin without
// re-registering. When unset, auto-rejoin is disabled and everyone falls back to
// the normal register flow. This is lightweight identity continuity, NOT auth.
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const BUILD_STAMP = Date.now();

// ── Database ───────────────────────────────────────────────────────────────
// The DB is the source of truth for everything durable (profiles, coins,
// cosmetics, approvals, announcer status, announcements). The in-memory maps
// below are only a live-connection cache for currently-connected sockets.
const { Pool } = pg;
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set. Provision a database (see the database skill).");
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on("error", (err) => console.error("Postgres pool error:", err));

const app        = express();
const httpServer = createServer(app);
const io         = new Server(httpServer);

app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

// Serve index.html directly so it's never served from static-file cache.
// Each server restart produces a new BUILD_STAMP injected into the page,
// guaranteeing the browser fetches a fresh copy every time.
app.get('/', (_req, res) => {
  const html = readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
    .replace('__BUILD_STAMP_TOKEN__', BUILD_STAMP);
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('ETag', `"${BUILD_STAMP}"`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// Health probe endpoint — used by the deployment platform's startup/health
// checks. Deliberately trivial (no DB, no file reads) so a probe can never
// fail while the process itself is alive; the probe path is configured in
// .replit-artifact/artifact.toml under [services.production.health.startup].
app.get('/healthz', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).json({ ok: true, stamp: BUILD_STAMP });
});

// Stamp endpoint — always returns the current server's build stamp, never cached.
// The page checks this on load and force-reloads if it was served from a stale cache.
app.get('/stamp', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json({ stamp: BUILD_STAMP });
});

// ── Admin office reset ───────────────────────────────────────────────────────
// POST /admin/purge  { password, keepEmail }
// Deletes ALL announcements and ALL player accounts EXCEPT keepEmail, then
// kicks every live session that isn't the kept account. Gated by
// ADMIN_PASSWORD (constant-time compare, same trust level as the in-game
// admin panel) plus a small attempt limiter so it can't be brute-forced.
// This exists as an HTTP endpoint because production DB access is read-only
// from tooling — a full office reset has to run inside the deployed server.
let purgeAttempts = { count: 0, windowStart: 0 };
app.post("/admin/purge", express.json(), async (req, res) => {
  const now = Date.now();
  if (now - purgeAttempts.windowStart > 10 * 60_000) purgeAttempts = { count: 0, windowStart: now };
  if (++purgeAttempts.count > 5) return res.status(429).json({ error: "Too many attempts — try again later." });

  const { password, keepEmail } = req.body || {};
  const a = Buffer.from(String(password || ""));
  const b = Buffer.from(ADMIN_PASSWORD);
  // timingSafeEqual throws on length mismatch — guard first (same pattern as verifyToken).
  if (!ADMIN_PASSWORD || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: "Bad admin password." });
  }

  const keep = String(keepEmail || "").trim().toLowerCase();
  if (!keep) return res.status(400).json({ error: "keepEmail is required." });

  try {
    // Refuse to run if the kept account doesn't exist — a typo here must not
    // wipe the whole office including the requester.
    const { rows: keepRows } = await pool.query("SELECT email FROM jpo_players WHERE email = $1", [keep]);
    if (keepRows.length === 0) return res.status(404).json({ error: `No account found for ${keep} — nothing was deleted.` });

    const client = await pool.connect();
    let announcementsDeleted, playersDeleted;
    try {
      await client.query("BEGIN");
      announcementsDeleted = (await client.query("DELETE FROM jpo_announcements")).rowCount;
      playersDeleted = (await client.query("DELETE FROM jpo_players WHERE email <> $1", [keep])).rowCount;
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    // Every live session except the kept account now references a deleted row —
    // kick them exactly like the admin-panel kick (client clears its resume
    // token and shows the kicked screen). No forced socket disconnect, same as
    // kickPlayer: with players[id] deleted, every game handler ignores them.
    for (const [id, p] of Object.entries(players)) {
      if (p.email === keep) continue;
      cancelMatchFor(id, "Match cancelled — no coins moved.");
      delete players[id];
      io.to(id).emit("kicked");
      io.emit("playerLeft", id);
    }
    for (const id of Object.keys(pending)) {
      delete pending[id];
      io.to(id).emit("rejected");
    }
    for (const em of Object.keys(graceByEmail)) if (em !== keep) cancelGrace(em);
    io.emit("announcementsUpdate", await fetchAnnouncements());
    _notifyAdmins();

    console.log(`Office purge: kept ${keep}, deleted ${playersDeleted} players and ${announcementsDeleted} announcements`);
    return res.json({ ok: true, kept: keep, playersDeleted, announcementsDeleted });
  } catch (err) {
    console.error("Purge failed:", err);
    return res.status(500).json({ error: "Purge failed — no partial deletes (transactional)." });
  }
});

app.use(express.static(path.join(__dirname, "public")));

// ── Live-connection cache (ephemeral, per server process) ────────────────────
const pending = {};   // socketId → { firstName, lastName, email, character, name, hairIdx, skinIdx, shirtIdx, pantsIdx }
const players = {};   // socketId → live player state (mirrors a jpo_players row for online, approved players)
const admins  = new Set();   // socketIds authenticated as admin this session (never persisted)

// email → { oldId, name, x, y, dir, timer }. A gracefully-disconnected player is
// parked here for GRACE_MS so a quick refresh / network blip resumes the SAME
// session without the avatar vanishing for everyone else. The frozen sprite (still
// shown on other clients under `oldId`) is removed only if they don't return in time.
const graceByEmail = {};
const GRACE_MS = 10_000;

// ── Cosmetics catalog ────────────────────────────────────────────────────────
// Permanent, worn items: buy once, own forever, wear ONE at a time (the
// equipped choice lives in jpo_players.equipped_cosmetic; '' = nothing worn).
// Buying auto-equips; `equipCosmetic` switches or takes off without repurchase.
// Ids MUST match the client COSMETICS catalog in public/index.html (it maps
// ids to emoji/names for the shop UI and the overhead overlay).
// Prices are balanced against the +2/min earn rate: cheapest reachable in one
// session (players start with 50), fanciest takes a few days of hanging out.
const SHOP = {
  sunglasses:   15,
  book:         20,
  crown:        30,
  headphones:   35,
  beret:        40,
  chefhat:      45,
  camera:       60,
  gamerheadset: 75,
  guitar:       90,
  // Sprite wearables — drawn ON the body client-side (real pixel art, not a
  // floating emoji). Same buy/equip mechanics as every other cosmetic.
  shades:       150,
  cap:          200,
  chain:        250,
};

// ── Pets catalog ─────────────────────────────────────────────────────────────
// Buy-once companions that follow their owner around the office. Ownership is
// stored in the SAME cosmetics array as wearables (the 'pet_' prefix keeps the
// id spaces disjoint — equipCosmetic rejects pet ids because they're not in
// SHOP, and equipPet rejects wearable ids because they're not in PETS). The
// active pet lives in jpo_players.equipped_pet ('' = none): a separate slot
// from equipped_cosmetic, so you can wear shades AND walk your dog. Ids MUST
// match the client PETS catalog in public/index.html (emoji/names live there).
const PETS = {
  pet_duck:   10000,
  pet_cat:    12500,
  pet_dog:    12500,
  pet_bunny:  15000,
  pet_turtle: 20000,
  pet_dragon: 30000,
};

// Wardrobe: one flat price to change shirt and/or trouser colours (either or
// both in a single change). The server is authoritative — the client's price
// label is display-only. Indexes are validated against CLOTH_MAX.
const WARDROBE_PRICE = 25;

// ── Usable (consumable) items ────────────────────────────────────────────────
// Unlike SHOP cosmetics (permanent, worn), these are bought in packs of `uses`
// and deplete when used. Ownership lives in jpo_players.items (jsonb: itemId →
// remaining uses) for email-backed players, in-memory for session-only ones.
// Buying again adds `uses` more. Adding a new item = add an entry here + a
// client-side shop row / effect handler.
const USABLE_ITEMS = {
  cigarette:    { cost: 20,  uses: 5 },   // pack of 5 smokes — outdoors on the grass only
  coffee:       { cost: 10,  uses: 1 },   // single cup — +40% walk speed for 45s
  coffee_round: { cost: 40,  uses: 1 },   // a round of coffees — boosts everyone nearby (incl. you)
  confetti:     { cost: 30,  uses: 1 },   // party popper — visual burst everyone can see
  fireworks:    { cost: 75,  uses: 1 },   // sky show — bigger, longer visual burst
  pizza_party:  { cost: 150, uses: 1 },   // pizza for everyone nearby — longer boost + 🍕 bubbles
};
// The speed-boost-granting subset of USABLE_ITEMS — these are refused for
// everyone in the dark during Office After Dark (see the useItem gate).
const BOOST_ITEMS     = new Set(["coffee", "coffee_round", "pizza_party"]);
const SMOKE_MS        = 10_000;  // how long the smoke-puff effect plays (also the "one at a time" cooldown)
const COFFEE_MULT     = 1.4;     // walk-speed multiplier — MUST match client COFFEE_MULT in public/index.html
const COFFEE_MS       = 45_000;  // boost duration — MUST match client (client gets it in the coffeeBoost event)
const PIZZA_MS        = 90_000;  // pizza-party boost duration (same mult as coffee — the move budget only knows one multiplier)
const BOOST_GRACE_MS  = 2_500;   // extra server-side slack past expiry so latency can't reject a legit last step
const GROUP_RADIUS    = 420;     // "everyone nearby" radius for group consumables, scaled px (~9 tiles)

// ── Interactive office objects ────────────────────────────────────────────
// Fixed stations on the map you can use with E. Coords are scaled world px
// (tile*48, same space as player x/y) and MUST match OFFICE_OBJECTS in
// public/index.html. r = max distance from the object's centre to the player's
// sprite origin. The client only ever sends an intent; proximity, cooldowns,
// and rate limits are all enforced here.
const OBJECTS = {
  coffee_machine2: { x: 8256, y: 3456, r: 150 }, // coffee maker on the Library counter (c171-172 r70) — shares the coffee_machine cooldown
  // White cabinet coffee makers (Interiors 2669/2685 units) around the office.
  // EVERY id starting with "coffee_machine" is one station of the same brew
  // system: interact matches on the prefix and they ALL share the single
  // per-person coffeeMachineReadyAt cooldown — more machines are a walk-distance
  // convenience, never a faster refill. Coords MUST match OFFICE_OBJECTS.
  coffee_machine3:  { x: 2016, y: 1440, r: 150 }, // West Office pair (c41-42, r28-29)
  coffee_machine4:  { x: 7056, y: 1584, r: 150 }, // East Office pair (c146-147, r31-32)
  coffee_machine5:  { x: 4800, y: 1776, r: 150 }, // Central Office pair (c99-100, r35-36)
  coffee_machine6:  { x: 3600, y: 3840, r: 150 }, // Lounge/Market pair (c74-75, r78-79)
  coffee_machine7:  { x: 8808, y: 3168, r: 150 }, // Game Room single (c183, r64-65)
  coffee_machine8:  { x: 8904, y: 3648, r: 150 }, // Library single (c185, r74-75)
  coffee_machine9:  { x: 3768, y: 5088, r: 150 }, // IT Office single (c78, r104-105)
  coffee_machine10: { x: 3768, y: 5616, r: 150 }, // Dev Room single (c78, r115-116)
  coffee_machine11: { x: 8952, y: 5712, r: 150 }, // Training Room single (c186, r117-118)
  water_cooler:    { x: 1800, y: 3816, r: 150 }, // water dispenser, Market north wall (c37, r78-79)
  arcade:          { x: 5280, y: 6000, r: 170 }, // arcade cabinets, Break Room basement corner (c108-111, r123-127)
  fridge:          { x: 5592, y: 4008, r: 190 }, // drink-cooler stack, cafeteria serving area (c116, r82-84)
  kitchen_island:  { x: 5232, y: 3624, r: 240 }, // cafeteria serving line: display cases + checkout counter (c104-113, r74-75)
  snack_counter:   { x: 9048, y: 1968, r: 220 }, // twin snack displays, Gym (c186-187 + c189-190, r38-43; one shared anchor)
  // ── Cafeteria kitchen: PAID food stations (menus in FOOD_MENUS, routing in
  // FOOD_STATIONS — fridge + kitchen_island above are paid stations too).
  // Wide furniture runs get 2-3 anchors sharing one menu.
  candy_stand:     { x: 4392, y: 3576, r: 150 }, // candy stand (Wall c91, r73-75)
  dessert_case:    { x: 4728, y: 3624, r: 240 }, // pink dessert counters + west display cases (c93-103, r74-75)
  grill_bank:      { x: 4560, y: 3960, r: 200 }, // kitchen appliance bank, west half (c91-99, r81-83)
  grill_bank2:     { x: 4944, y: 3960, r: 200 }, // kitchen appliance bank, east half (c100-106, r81-83)
  produce_crates:  { x: 5184, y: 3984, r: 170 }, // produce crates (c106-109, r82-83)
  bakery_line:     { x: 4512, y: 4536, r: 170 }, // prep/bakery tables, west (c91-97, r94-95)
  bakery_line2:    { x: 4848, y: 4536, r: 170 }, // prep/bakery tables, middle (c98-104, r94-95)
  bakery_line3:    { x: 5232, y: 4536, r: 210 }, // prep/bakery tables + register, east (c105-113, r94-95)
  // cafeteria_food<N> spots are appended after the map loads (see FOOD_TABLES).
};
// Free coffee is on a LONG per-person refill so the 10-coin shop coffee
// (instant, usable anywhere, stockpilable) stays worth buying.
const COFFEE_MACHINE_COOLDOWN_MS = 10 * 60_000;
const WATER_COOLDOWN_MS = 4_000;   // one sip (and one flavor line) per few seconds
const WATER_LINES = [
  "Crisp. Refreshing. Corporate.",
  "You feel 2% more hydrated.",
  "The cooler gurgles approvingly.",
  "Ice cold — someone refilled it. A hero.",
  "Tastes like a productive afternoon.",
  "Glug glug glug. Perfect form.",
  "Hydration is a competitive advantage.",
  "You briefly consider this water's long journey.",
];
let waterLineIdx = 0;
// Free snacks (gym counter + cafeteria dining tables): pure flavor (no buff,
// no coins). The eater gets the line as a toast; everyone nearby sees the
// snack emoji bubble over their head.
const FRIDGE_COOLDOWN_MS = 45_000;   // "you're full" window between free snacks

// ── Cafeteria kitchen: PAID food menus ───────────────────────────────────
// Every kitchen station in the cafeteria sells food for coins: `interact`
// sends the station's menu (foodMenu event), `buyFood` re-validates proximity
// and charges the SERVER-side price — the client renders whatever foodMenu
// sent and is never authoritative. Several station ids share one menu (the
// appliance bank / bakery tables are wider than one interact radius, so they
// get 2-3 anchors). Paid food deliberately never touches fridgeReadyAt (the
// free-snack cooldown) in either direction: the price + buyBucket are the
// limiters, and a paid meal shouldn't lock the free dining-table nibbles.
const FOOD_MENUS = {
  sweets: { title: "🍬 Candy Stand", items: [
    { id: "lollipop",  name: "Lollipop",             icon: "🍭", price: 3 },
    { id: "gummies",   name: "Gummy bears",          icon: "🍬", price: 4 },
    { id: "chocolate", name: "Chocolate bar",        icon: "🍫", price: 5 },
    { id: "donut",     name: "Sprinkle donut",       icon: "🍩", price: 5 },
    { id: "cupcake",   name: "Cupcake",              icon: "🧁", price: 6 },
    { id: "icecream",  name: "Soft-serve cone",      icon: "🍦", price: 7 },
  ] },
  desserts: { title: "🍰 Dessert Counter", items: [
    { id: "cookie",    name: "Warm cookie",          icon: "🍪", price: 4 },
    { id: "pudding",   name: "Caramel pudding",      icon: "🍮", price: 6 },
    { id: "pie",       name: "Pie slice",            icon: "🥧", price: 7 },
    { id: "cake",      name: "Cake slice",           icon: "🍰", price: 8 },
    { id: "shortcake", name: "Strawberry shortcake", icon: "🍓", price: 9 },
    { id: "fondue",    name: "Chocolate fondue",     icon: "🫕", price: 10 },
  ] },
  meals: { title: "🍽️ Serving Line", items: [
    { id: "salad",     name: "Garden salad",         icon: "🥗", price: 8 },
    { id: "taco",      name: "Taco",                 icon: "🌮", price: 9 },
    { id: "pizza",     name: "Pizza slice",          icon: "🍕", price: 10 },
    { id: "spaghetti", name: "Spaghetti",            icon: "🍝", price: 11 },
    { id: "burger",    name: "Office burger",        icon: "🍔", price: 12 },
    { id: "curry",     name: "Curry plate",          icon: "🍛", price: 12 },
  ] },
  grill: { title: "🍳 Kitchen Grill", items: [
    { id: "eggs",      name: "Fried eggs",           icon: "🍳", price: 6 },
    { id: "hotdog",    name: "Hot dog",              icon: "🌭", price: 6 },
    { id: "bacon",     name: "Bacon strips",         icon: "🥓", price: 7 },
    { id: "soup",      name: "Soup of the day",      icon: "🍲", price: 7 },
    { id: "pancakes",  name: "Pancake stack",        icon: "🥞", price: 8 },
    { id: "sandwich",  name: "Grilled sandwich",     icon: "🥪", price: 8 },
  ] },
  produce: { title: "🥕 Fresh Produce", items: [
    { id: "carrot",    name: "Crunchy carrot",       icon: "🥕", price: 2 },
    { id: "apple",     name: "Apple",                icon: "🍎", price: 3 },
    { id: "banana",    name: "Banana",               icon: "🍌", price: 3 },
    { id: "grapes",    name: "Grapes",               icon: "🍇", price: 4 },
    { id: "melon",     name: "Watermelon slice",     icon: "🍉", price: 5 },
    { id: "avocado",   name: "Avocado",              icon: "🥑", price: 6 },
  ] },
  bakery: { title: "🥐 Bakery Line", items: [
    { id: "bagel",     name: "Bagel",                icon: "🥯", price: 4 },
    { id: "pretzel",   name: "Soft pretzel",         icon: "🥨", price: 4 },
    { id: "croissant", name: "Croissant",            icon: "🥐", price: 5 },
    { id: "baguette",  name: "Baguette",             icon: "🥖", price: 5 },
    { id: "bread",     name: "Fresh loaf",           icon: "🍞", price: 6 },
    { id: "bakedpie",  name: "Whole pie",            icon: "🥧", price: 8 },
  ] },
  drinks: { title: "🧊 Drink Coolers", items: [
    { id: "juicebox",  name: "Juice box",            icon: "🧃", price: 3 },
    { id: "milk",      name: "Milk",                 icon: "🥛", price: 3 },
    { id: "soda",      name: "Fizzy soda",           icon: "🥤", price: 4 },
    { id: "lemonade",  name: "Lemonade",             icon: "🍋", price: 4 },
    { id: "coconut",   name: "Coconut water",        icon: "🥥", price: 5 },
    { id: "boba",      name: "Bubble tea",           icon: "🧋", price: 6 },
  ] },
};
// Station object id → FOOD_MENUS key. Ids MUST exist in OBJECTS (and in the
// client's OFFICE_OBJECTS — the usual lockstep).
const FOOD_STATIONS = {
  candy_stand: "sweets", dessert_case: "desserts", kitchen_island: "meals",
  grill_bank: "grill", grill_bank2: "grill", produce_crates: "produce",
  bakery_line: "bakery", bakery_line2: "bakery", bakery_line3: "bakery",
  fridge: "drinks",
};

// Free-snack menus for the remaining FREE spots. `icon` picks the toast
// prefix the client shows before the line (cafeteria tables 🍽️, gym 💪).
const MEALS = [
  { emoji: "🍝", line: "A generous plate of pasta. Carbs are a team sport." },
  { emoji: "🍛", line: "Today's special: curry. The cafeteria outdid itself." },
  { emoji: "🥘", line: "Something simmered, something delicious. No questions." },
  { emoji: "🍲", line: "A warm bowl of stew. Morale +1." },
  { emoji: "🌮", line: "Taco day. Attendance mysteriously improves on taco day." },
  { emoji: "🍱", line: "A neatly packed lunch box. Compartments = serenity." },
  { emoji: "🍔", line: "A cafeteria burger, engineered to leave no meeting survivor hungry." },
  { emoji: "🥟", line: "Dumplings! Grab them before Accounting hears about it." },
];
let mealIdx = 0;
const GYM_SNACKS = [
  { emoji: "🥤", line: "A protein shake. You feel 4% more swole already." },
  { emoji: "🍌", line: "A perfectly ripe banana. Nature's energy bar." },
  { emoji: "⚡", line: "An energy bar that tastes like drywall and ambition." },
  { emoji: "🥚", line: "Two boiled eggs. The gym fridge does not do subtle." },
  { emoji: "🫐", line: "A cup of blueberries. Antioxidants for the grind." },
];
let gymSnackIdx = 0;
// Cooldowns are keyed by email (fallback: socket id) and live in memory only —
// a server restart forgives them, which is fine for flavor perks.
const coffeeMachineReadyAt = new Map();  // key → ts when the next free coffee unlocks
const waterReadyAt = new Map();          // key → ts of the next allowed sip
const fridgeReadyAt = new Map();         // key → ts when the next snack unlocks
function pruneCooldowns(map, now) {      // opportunistic sweep so the maps can't grow unbounded
  if (map.size < 500) return;
  for (const [k, t] of map) if (t <= now) map.delete(k);
}

// Fixed emote allowlist — ids only, the client maps them to emoji. MUST match
// the EMOTES list in public/index.html.
const EMOTES = new Set(["wave", "heart", "laugh", "party", "thumbs", "fire", "sad", "shock"]);

function clampIdx(v, max) {
  return (Number.isInteger(v) && v >= 0 && v <= max) ? v : 0;
}

// Max valid shirt/trouser colour index. MUST equal client CLOTH_COLORS.length - 1 in public/index.html.
const CLOTH_MAX = 22;

// ── World bounds (derived from the loaded Tiled map, NOT hardcoded) ───────────
// Movement validation rejects positions outside the office. We read the same
// Tiled map the client renders (public/assets/JPO_HQ.tmj) so the bounds track a
// future map swap automatically. RENDER_SCALE must match the client's setScale(3)
// in public/index.html — the map file stores tile counts/sizes, not the on-screen
// render scale. Falls back to the current 210×128 map if the file can't be read.
const RENDER_SCALE = 3;
// Outdoor mask: OUTDOOR[row*MAP_W + col] === true where the Floor tile comes
// from the exterior tileset (grass/pavement), found BY NAME ("Ext") with a
// bounded gid range — Ext is NOT the last tileset in JPO_HQ.tmj. Flip-flag
// bits are masked off (Tiled stores flips in the top bits of the gid). Used
// by the cigarette's "outside on the grass only" rule.
const GID_MASK = 0x1FFFFFFF;
// Work-seat GIDs on the Furniture layer: 2231 = office chair (workstations,
// conference tables, checkouts), 2763/2764 = study-carrel chairs, 2628 = the
// lounge work-pod desk chair (side-view, faces left), 2600 = the pod's LEFT
// chair seat tile (side-view, faces right — the 2584 top / 2616 legs tiles
// alias onto it client-side, so the derived cell is always 2600), 5033 = the
// studio front-desk armchair's RIGHT seat tile (the chair is 2-wide and the
// sit is centered on the column boundary — x lands exactly between the two
// tiles and Math.round picks the RIGHT one, so 5033 is the only derived gid).
// Sitting on one of these earns the work bonus; sofas/benches/beds don't.
// MUST stay in lockstep with the client's WORK_CHAIR_GIDS (what shows the 💼
// chip) — the client set also lists the alias tiles (2644, 2584/2616,
// 5016/5017/5032) for chip display; never add those here.
const WORK_SEAT_GIDS = new Set([2231, 2763, 2764, 2628, 2600, 5033]);
// Jail-tileset computer-desk chairs live on the WALL layer (their cells hold no
// Furniture gid at all) — the work-seat mask below ORs these in from the Wall
// layer. MUST stay in lockstep with the client's WALL_SEATS table.
const WALL_WORK_SEAT_GIDS = new Set([5533, 5564, 5565]);
const { WORLD_W, WORLD_H, MAP_W, MAP_H, OUTDOOR, WORK_SEATS, FOOD_TABLES } = (() => {
  try {
    const tmj = JSON.parse(readFileSync(path.join(__dirname, "public", "assets", "JPO_HQ.tmj"), "utf8"));
    const w = tmj.width * tmj.tilewidth * RENDER_SCALE;
    const h = tmj.height * tmj.tileheight * RENDER_SCALE;
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      let outdoor = null;
      const floor = tmj.layers?.find((l) => l.name === "Floor" && Array.isArray(l.data));
      // The exterior tileset is found BY NAME (not "last firstgid" — JPO_HQ.tmj
      // has tilesets after Ext), and the outdoor test is a bounded range so
      // Basement/Gym tiles never count as outdoors.
      const ext = tmj.tilesets?.find((t) => t.name === "Ext");
      if (floor && ext?.firstgid && ext?.tilecount) {
        const lo = ext.firstgid, hi = ext.firstgid + ext.tilecount;
        outdoor = floor.data.map((g) => { const gg = g & GID_MASK; return gg >= lo && gg < hi; });
      } else {
        console.error("outdoor mask unavailable (no Floor layer or Ext tileset) — smoking disabled");
      }
      // Work-seat mask from the Furniture layer (same shape as OUTDOOR).
      let workSeats = null;
      const foodTables = [];
      const furn = tmj.layers?.find((l) => l.name === "Furniture" && Array.isArray(l.data));
      if (furn) {
        workSeats = furn.data.map((g) => WORK_SEAT_GIDS.has(g & GID_MASK));
        // Wall-layer computer-desk chairs (WALL_WORK_SEAT_GIDS) also pay the
        // bonus — same mask, same index space.
        const wallL = tmj.layers?.find((l) => l.name === "Wall" && Array.isArray(l.data));
        if (wallL) wallL.data.forEach((g, i) => {
          if (WALL_WORK_SEAT_GIDS.has(g & GID_MASK)) workSeats[i] = true;
        });
        // Cafeteria food spots: one per table, keyed by the table's top-left
        // marker gid (2183), scanned row-major. The client runs the SAME scan
        // over the same map at create(), so the generated cafeteria_food<N>
        // ids stay in lockstep across a Tiled re-import. Coords are scaled
        // world px at the table's visual center (4-wide × 3-tall block).
        const ts = tmj.tilewidth * RENDER_SCALE;   // 48 at scale 3
        furn.data.forEach((g, i) => {
          if ((g & GID_MASK) !== 2183) return;
          const c = i % tmj.width, r = Math.floor(i / tmj.width);
          foodTables.push({ x: (c + 1) * ts, y: (r + 1.5) * ts });
        });
      } else {
        console.error("work-seat mask unavailable (no Furniture layer) — work bonus disabled");
      }
      return { WORLD_W: w, WORLD_H: h, MAP_W: tmj.width, MAP_H: tmj.height, OUTDOOR: outdoor, WORK_SEATS: workSeats, FOOD_TABLES: foodTables };
    }
  } catch (err) {
    console.error("map bounds load failed, using fallback:", err);
  }
  // Fallback: 210×128 tiles · 16px · scale 3, no outdoor/work masks (smoking + work bonus disabled).
  return { WORLD_W: 10080, WORLD_H: 6144, MAP_W: 210, MAP_H: 128, OUTDOOR: null, WORK_SEATS: null, FOOD_TABLES: [] };
})();

// Register the cafeteria food spots as interactive objects, and group the
// FREE snack spots (gym snack counter + cafeteria dining tables) behind one
// id set: they share the single per-person "you're full" cooldown
// (fridgeReadyAt) — only the menu differs. fridge + kitchen_island are PAID
// stations now (FOOD_STATIONS), so they are deliberately NOT in this set.
FOOD_TABLES.forEach((t, i) => { OBJECTS[`cafeteria_food${i}`] = { x: t.x, y: t.y, r: 150 }; });
const FOOD_OBJECT_IDS = new Set(["snack_counter",
  ...FOOD_TABLES.map((_, i) => `cafeteria_food${i}`)]);

// Is this player position outdoors? Uses the FEET tile — the sprite origin is
// the character's center, and the tile a player occupies is derived from
// y + BODY_DY (27px at scale 3), exactly like the client's tile lookups.
const TILE_PX = 16 * RENDER_SCALE;
const BODY_DY = 27;
function isOutdoors(x, y) {
  if (!OUTDOOR) return false;
  const col = Math.floor(x / TILE_PX), row = Math.floor((y + BODY_DY) / TILE_PX);
  if (col < 0 || row < 0 || col >= MAP_W || row >= MAP_H) return false;
  return !!OUTDOOR[row * MAP_W + col];
}

// Live socket ids within `radius` px of the given player (always includes the
// player themselves). Used by group consumables — live-connection only by
// design: grace-window (briefly disconnected) players don't get boosts.
function nearbyIds(socketId, radius) {
  const p = players[socketId];
  if (!p) return [socketId];
  const out = [];
  const r2 = radius * radius;
  for (const [id, q] of Object.entries(players)) {
    if (id === socketId) { out.push(id); continue; }
    const dx = (q.x ?? 0) - (p.x ?? 0), dy = (q.y ?? 0) - (p.y ?? 0);
    if (dx * dx + dy * dy <= r2) out.push(id);
  }
  return out;
}

// ── Work bonus (earn extra coins while seated at a computer/desk) ────────────
// A player is "working" when their reported anim is 'sit' AND the seat tile
// under them is a work seat (WORK_SEAT_GIDS). The seat cell is recovered from
// the seated sprite position with the SAME rounding math as the client's
// _deskPoseAt (sitting snaps the sprite to seatCol*48+24, seatRow*48+24-BODY_DY,
// so Math.round inverts it exactly). Rate: COIN_TICK_BASE + WORK_BONUS per
// minute while working. The client shows the 💼 chip from its own desk-seat
// detection (the same rule), so no extra socket traffic is needed.
const COIN_TICK_BASE = 2;   // passive coins per minute (the historical +2/min)
const WORK_BONUS     = 1;   // extra coins per minute while seated at a work desk
function isAtWorkSeat(p) {
  if (!WORK_SEATS || p.anim !== "sit") return false;
  const col = Math.round(((p.x ?? 0) - TILE_PX / 2) / TILE_PX);
  const row = Math.round(((p.y ?? 0) - TILE_PX / 2 + BODY_DY) / TILE_PX);
  if (col < 0 || row < 0 || col >= MAP_W || row >= MAP_H) return false;
  return !!WORK_SEATS[row * MAP_W + col];
}

// Once-per-calendar-day login bonus (server/DB date, UTC). Granted on the first
// successful entry into the office each day via restorePlayer — the atomic
// conditional UPDATE below is the farm-proofing: re-login, refresh, resume, or
// concurrent duplicate connections all hit the same WHERE guard, so at most one
// grant per email per day no matter how many times they reconnect.
const DAILY_BONUS = 10;

// ── Rate limiting (basic per-socket abuse protection) ────────────────────────
// A tiny token bucket throttles bursty events WITHOUT disconnecting the player:
// excess events are silently dropped. `tokens` refills 1 per `refillMs` up to
// `capacity`, so a short human burst is fine but a sustained flood is capped.
function makeBucket(capacity, refillMs) {
  return { tokens: capacity, capacity, refillMs, last: Date.now() };
}
function takeToken(b) {
  const now = Date.now();
  if (now > b.last) {
    const steps = Math.floor((now - b.last) / b.refillMs);
    if (steps > 0) { b.tokens = Math.min(b.capacity, b.tokens + steps); b.last += steps * b.refillMs; }
  }
  if (b.tokens > 0) { b.tokens--; return true; }
  return false;
}

// Movement: accept at most one update per MOVE_MIN_INTERVAL_MS (the client sends
// every ~50ms), and reject teleports. A single move may cover at most the distance
// a normal walk could since the last ACCEPTED update (MOVE_SPEED · elapsed, with a
// modest tolerance for jitter and a small fixed floor for one frame at ~0 elapsed).
// A previous version added a 160px allowance to EVERY move, which let a modified
// client chain small hops far faster than walking; that allowance is now granted
// ONLY on a sit<->stand "snap" (see SEAT_SNAP_ALLOWANCE), so normal travel stays
// bounded to roughly walk speed.
const MOVE_MIN_INTERVAL_MS  = 33;    // < client's 50ms cadence, so legit frames never drop
const MOVE_SPEED            = 195;   // px/s, MUST match client SPEED in public/index.html
const MOVE_SPEED_TOLERANCE  = 1.6;   // multiplicative slack over walk speed for network jitter
const MOVE_JITTER_PX        = 12;    // small additive floor: covers one ~7.5px frame at near-0 elapsed
const MOVE_ELAPSED_CAP_MS   = 1500;  // cap the time budget so a long idle can't bank a big teleport
const MOVE_BOUNDS_EPSILON   = 48;    // minimal out-of-bounds slack (~1 tile / body offset), NOT snap-sized
// Seat "snap": sitting/standing teleports the avatar ~1 tile onto/off the chair and
// flips the reported anim to/from 'sit'. Grant the extra distance ONLY on that
// transition, and rate-limit it so a modified client can't fake it every frame.
const SEAT_SNAP_ALLOWANCE   = 160;   // extra one-time distance for a legit sit/stand snap
const SEAT_SNAP_COOLDOWN_MS = 400;   // min gap between granted snap allowances (blocks anim-toggle abuse)

// ── Resume tokens (lightweight identity continuity, NOT auth) ─────────────────
// A signed "<payload>.<hmac>" token proves the server once approved this email, so
// a returning browser can auto-rejoin. It is NOT a security boundary — email
// identity stays unauthenticated (see replit.md). Disabled entirely when
// SESSION_SECRET is unset (signToken → "", verifyToken → null).
const TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days

function signToken(email) {
  if (!SESSION_SECRET) return "";
  const payload = Buffer.from(JSON.stringify({ email, iat: Date.now() })).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!SESSION_SECRET || typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot), sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch — guard first.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data || typeof data.email !== "string" || !data.email) return null;
    if (!Number.isFinite(data.iat) || Date.now() - data.iat > TOKEN_MAX_AGE_MS) return null;
    return { email: data.email, iat: data.iat };
  } catch { return null; }
}

// ── Password hashing (scrypt, no external deps) ──────────────────────────────
// Stored as "scrypt:<saltB64url>:<hashB64url>". Async so a hash never blocks the
// event loop. NULL password_hash = legacy passwordless account: the first
// register with that email claims it by setting a password (TOFU — same trust
// level as the old email-only model, but it upgrades security over time).
const scryptAsync = (pw, salt) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(pw, salt, 64, (err, buf) => (err ? reject(err) : resolve(buf))));

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(pw, salt);
  return `scrypt:${salt.toString("base64url")}:${hash.toString("base64url")}`;
}

async function verifyPassword(pw, stored) {
  if (typeof stored !== "string") return false;
  const [scheme, saltB64, hashB64] = stored.split(":");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64url");
  const actual = await scryptAsync(pw, Buffer.from(saltB64, "base64url"));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Per-EMAIL auth attempt limiter (module-level — a per-socket bucket would reset
// on every reconnect). Checked BEFORE any scrypt call so a flood can't exhaust
// the libuv threadpool. Lazy expiry: stale entries are dropped on next touch.
const AUTH_MAX_ATTEMPTS = 5;
const AUTH_WINDOW_MS = 30_000;
const authAttempts = new Map(); // email -> { count, windowStart }

function authAllowed(email) {
  const now = Date.now();
  const e = authAttempts.get(email);
  if (!e || now - e.windowStart > AUTH_WINDOW_MS) {
    authAttempts.set(email, { count: 1, windowStart: now });
    return true;
  }
  if (e.count >= AUTH_MAX_ATTEMPTS) return false;
  e.count++;
  return true;
}
// Keep the map from growing unboundedly under a many-email flood.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of authAttempts) {
    if (now - v.windowStart > AUTH_WINDOW_MS) authAttempts.delete(k);
  }
}, 5 * 60_000).unref();

const PASSWORD_MIN = 6, PASSWORD_MAX = 100;

// Strict email shape for register (the email becomes the row's PRIMARY KEY and
// is embedded in admin-panel markup): lowercase alnum + . _ % + - local part,
// dotted domain. Deliberately conservative — no quotes, spaces, or HTML chars.
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

// Department allowlist — MUST stay identical (same values, same order) to the
// client's DEPARTMENTS array in public/index.html. '' = not set (legacy
// accounts pick one, once, from their own profile card).
const DEPARTMENTS = ["HR", "IT", "Operations", "Front Desk", "CMA", "QA", "L&D", "Claims", "Accounting"];

// ── DB helpers ───────────────────────────────────────────────────────────────

// Map a jpo_players row (snake_case columns) to the in-memory / client-facing
// player state shape (camelCase).
function rowToPlayerState(row) {
  return {
    x: row.x, y: row.y, dir: row.dir, anim: row.anim === "sit" ? "sit" : "idle",
    // `name` is the in-game DISPLAY name (nickname first) — every consumer
    // (nametags, chat, announcements, grace snapshot) reads this field.
    // `fullName` keeps the real name for the admin panel.
    name:      row.nickname || row.first_name || row.name,
    fullName:  row.name,
    email:     row.email,
    character: row.character,
    hairIdx:   row.hair_idx,
    skinIdx:   row.skin_idx,
    shirtIdx:  row.shirt_idx,
    pantsIdx:  row.pants_idx,
    coins:     row.coins,
    cosmetics: row.cosmetics || [],
    equipped:  row.equipped_cosmetic || "",
    pet:       row.equipped_pet || "",
    items:     row.items || {},
    isAnnouncer: row.is_announcer,
    department:  row.department || "",
    // Epoch ms of account creation, for the profile card's "joined" line.
    createdAt:   row.created_at ? new Date(row.created_at).getTime() : null,
  };
}

// Upsert a person's profile on registration, keyed by email. Existing rows keep
// their coins / cosmetics / approved / announcer status — only the editable
// profile fields (name, character, appearance) are refreshed.
async function upsertPlayerProfile(reg) {
  const { rows } = await pool.query(
    `INSERT INTO jpo_players
       (email, first_name, last_name, name, nickname, character, hair_idx, skin_idx, shirt_idx, pants_idx, department)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (email) DO UPDATE SET
       first_name = EXCLUDED.first_name,
       last_name  = EXCLUDED.last_name,
       name       = EXCLUDED.name,
       nickname   = EXCLUDED.nickname,
       character  = EXCLUDED.character,
       hair_idx   = EXCLUDED.hair_idx,
       skin_idx   = EXCLUDED.skin_idx,
       shirt_idx  = EXCLUDED.shirt_idx,
       pants_idx  = EXCLUDED.pants_idx,
       -- Never let a department-less register wipe an already-set department
       -- (e.g. a legacy client omitting the field on a re-register).
       department = CASE WHEN EXCLUDED.department <> '' THEN EXCLUDED.department
                         ELSE jpo_players.department END,
       -- Actively re-registering = back in the approval queue: clear any
       -- earlier admin dismissal (reject/kick) so they show as pending again.
       dismissed  = false,
       updated_at = now()
     RETURNING *`,
    [reg.email, reg.firstName, reg.lastName, reg.name, reg.nickname, reg.character,
     reg.hairIdx, reg.skinIdx, reg.shirtIdx, reg.pantsIdx, reg.department],
  );
  return rows[0];
}

// Newest 50 announcements, in the exact shape the client expects. `id` is a
// string (the client embeds it into a deleteAnnouncement('<id>') onclick) and
// `ts` is epoch-ms (compared numerically for unread markers).
async function fetchAnnouncements() {
  const { rows } = await pool.query(
    `SELECT id, name, text, board, created_at
       FROM jpo_announcements
      ORDER BY id DESC
      LIMIT 50`,
  );
  return rows.map((r) => ({
    id:    String(r.id),
    name:  r.name,
    text:  r.text,
    ts:    new Date(r.created_at).getTime(),
    board: r.board,
  }));
}

// Socket ids (other than `exceptId`) currently live under `email`.
function liveSocketsForEmail(email, exceptId) {
  const ids = [];
  for (const id in players) {
    if (id !== exceptId && players[id].email && players[id].email === email) ids.push(id);
  }
  for (const id in pending) {
    if (id !== exceptId && pending[id].email && pending[id].email === email) ids.push(id);
  }
  return ids;
}

// Enforce one live session per email: drop and disconnect any older socket
// already using this email. This is the seam the reconnection grace period
// (a later task) will build on.
function dropLiveByEmail(email, exceptId) {
  for (const id of liveSocketsForEmail(email, exceptId)) {
    // Cancel any RPS match the dropped session was in. Usually the disconnect
    // below triggers this anyway, but if the socket object is already gone
    // there is no disconnect event — this call is the safety net.
    cancelMatchFor(id, "They left the office — match cancelled, no coins moved.");
    roundHandleLeave(id);
    if (players[id]) { delete players[id]; io.emit("playerLeft", id); }
    if (pending[id]) delete pending[id];
    const stale = io.sockets.sockets.get(id);
    if (stale) stale.disconnect(true);
  }
}

// Cancel a pending grace hold for an email (called when they reconnect): stop the
// removal timer and clear the frozen old sprite from every client, so restore can
// re-add a fresh one at the resumed position. Returns the parked entry (with its
// live x/y/dir snapshot) so the caller can prefer it over a possibly-stale DB row.
function cancelGrace(email) {
  const g = graceByEmail[email];
  if (!g) return null;
  clearTimeout(g.timer);
  io.emit("playerLeft", g.oldId);
  delete graceByEmail[email];
  return g;
}

// Put a socket into the office from a durable jpo_players row: cache it live and
// send the client everything it needs to render. Used both when an admin
// approves someone and when an already-approved email reconnects. The identity
// gate that decides *who* gets restored lives in the register handler — the
// reconnection-token task will swap the email check there for a token check.
async function restorePlayer(socket, row) {
  const state = rowToPlayerState(row);

  // If they're returning within the grace window, remove the frozen old sprite and
  // prefer the live in-memory position snapshot over the DB row (the disconnect
  // flush may still be in flight, and the row is only written each coin tick).
  const g = state.email ? cancelGrace(state.email) : null;
  if (g && Number.isFinite(g.x) && Number.isFinite(g.y)) {
    state.x = g.x; state.y = g.y; state.dir = g.dir || state.dir;
    state.anim = g.anim === "sit" ? "sit" : "idle";
  }

  players[socket.id] = state;

  socket.emit("approved", {
    name:      state.name,
    email:     state.email,
    character: state.character,
    hairIdx:   state.hairIdx,
    skinIdx:   state.skinIdx,
    shirtIdx:  state.shirtIdx,
    pantsIdx:  state.pantsIdx,
    coins:     state.coins,
    cosmetics: state.cosmetics,
    equipped:  state.equipped || "",
    pet:       state.pet || "",
    items:     state.items || {},
    x:         state.x,
    y:         state.y,
  });
  socket.emit("currentPlayers", players);
  socket.emit("announcerStatus", { canPost: state.isAnnouncer });
  socket.emit("announcements", await fetchAnnouncements());

  // Issue a resume token so this browser can auto-rejoin later (email-backed only).
  if (state.email) {
    const token = signToken(state.email);
    if (token) socket.emit("sessionToken", { token });
  }

  for (const pid in players) {
    if (pid !== socket.id) io.to(pid).emit("playerJoined", { id: socket.id, ...state });
  }

  // Once-per-calendar-day login bonus. Atomic conditional UPDATE: the WHERE
  // guard makes the FIRST office entry of the day (register/login/resume/
  // approve all route through here) the only one that pays out — a same-day
  // re-login, refresh, or concurrent duplicate connection matches zero rows.
  // Session-only (no-email) players get nothing: there's no durable row to
  // gate on, so paying them would be freely farmable via reconnects.
  if (state.email) {
    try {
      const { rows } = await pool.query(
        `UPDATE jpo_players
            SET coins = coins + $2, last_daily_bonus = CURRENT_DATE, updated_at = now()
          WHERE email = $1
            AND (last_daily_bonus IS NULL OR last_daily_bonus < CURRENT_DATE)
          RETURNING coins`,
        [state.email, DAILY_BONUS],
      );
      if (rows[0]) {
        state.coins = rows[0].coins;
        socket.emit("coinUpdate", { coins: state.coins });
        socket.emit("dailyBonus", { amount: DAILY_BONUS });
      }
    } catch (err) {
      console.error("daily bonus failed:", err);   // non-fatal: they're already in the office
    }
  }

  // If a round lobby is gathering, late arrivals get the invite too (with the
  // remaining join time) — otherwise a resume/reconnect during the 30s window
  // would silently miss the round.
  if (round && round.state === "joining") {
    socket.emit("roundInvite", {
      starterId: round.starterId, starterName: round.starterName,
      joinMs: Math.max(0, round.joinEndsAt - Date.now()),
      minPlayers: ROUND_MIN_PLAYERS, count: round.members.size,
    });
  }
}

// ── Rock-paper-scissors challenges (ephemeral, in-session only) ──────────────
// A match references LIVE SOCKETS (one live session per email means a socket id
// uniquely identifies a session). No match state is persisted: coins only move
// at RESOLUTION time in one atomic statement, so a crash/restart/disconnect at
// any earlier point moves nothing (no escrow, no refund paths). The one
// invariant that makes the accept-time balance check exact: a player in a match
// cannot spend coins (buyCosmetic is blocked while in rpsBySocket) — the only
// concurrent coin mutation left is the +2/min tick, which only ADDS.
const RPS_PICKS     = new Set(["rock", "paper", "scissors"]);
const RPS_BEATS     = { rock: "scissors", paper: "rock", scissors: "paper" };  // key beats value
const RPS_ACCEPT_MS = 30_000;  // challenged player has this long to accept/decline
const RPS_PICK_MS   = 20_000;  // both players must pick within this window
const RPS_WAGER_MAX = 10_000;
const RPS_RANGE_PX  = 480;     // "walk up to someone": ~10 tiles at render scale 3

// The duel roster. Every game shares ONE lifecycle (challenge → accept →
// play → finishMatch → settle) and ONE match map (rpsBySocket), so all the
// cleanup seams (disconnect/kick/dropLiveByEmail → cancelMatchFor) and the
// mid-match spend block apply to new games automatically. The `rps*` event
// names are kept for the shared lifecycle events (they predate the roster);
// payloads carry a `game` field.
const GAMES      = new Set(["rps", "ttt", "qd", "ib", "wr", "trivia", "c4"]);
const GAME_NAMES = { rps: "Rock-Paper-Scissors", ttt: "Tic-Tac-Toe", qd: "Quick Draw", ib: "Icebreakers", wr: "Word Race", trivia: "Trivia Duel", c4: "Connect Four" };
const TTT_MOVE_MS   = 20_000;  // per-move clock — the slow side forfeits
const TTT_LINES     = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const QD_ARM_MIN_MS = 2_000;   // random wait before the DRAW! signal…
const QD_ARM_MAX_MS = 6_000;   // …lands somewhere in [min, max]
const QD_LIVE_MS    = 5_000;   // nobody taps within this after the signal → cancel
const IB_ROUNDS     = 3;       // Icebreakers: best of 3 either/or rounds
const IB_SUBMIT_MS  = 20_000;  // per-round answer window (mirrors the RPS pick clock)
const IB_REVEAL_MS  = 5_000;   // reading pause between the reveal and the next round
const WR_TIME_MS    = 60_000;  // Word Race: nobody solves it in this → draw
const IB_CHOICES    = new Set(["a", "b"]);
const TRIV_ROUNDS    = 3;       // Trivia Duel: best of 3 questions
const TRIV_ANSWER_MS = 10_000;  // per-question clock — no answer counts as wrong
const TRIV_REVEAL_MS = 4_000;   // reading pause between the reveal and the next question
const C4_COLS    = 7;           // Connect Four board
const C4_ROWS    = 6;
const C4_MOVE_MS = 20_000;      // per-move clock — the slow side forfeits (mirrors TTT)

// Icebreaker prompt pool (SERVER-ONLY — the client only ever sees the labels
// of the rounds it is playing). Work-friendly either/or pairs; a match draws
// IB_ROUNDS distinct prompts so no repeats within a match.
const IB_PROMPTS = [
  { a: "Coffee", b: "Tea" },
  { a: "Early bird", b: "Night owl" },
  { a: "Beach", b: "Mountains" },
  { a: "Dogs", b: "Cats" },
  { a: "Call", b: "Text" },
  { a: "Sweet", b: "Salty" },
  { a: "Summer", b: "Winter" },
  { a: "Movie night", b: "Game night" },
  { a: "Cook at home", b: "Order in" },
  { a: "Window seat", b: "Aisle seat" },
  { a: "City", b: "Countryside" },
  { a: "Books", b: "Podcasts" },
  { a: "Pizza", b: "Tacos" },
  { a: "Tidy desk", b: "Organized chaos" },
  { a: "Morning shower", b: "Evening shower" },
  { a: "Save it", b: "Spend it" },
  { a: "Plan everything", b: "Wing it" },
  { a: "Karaoke", b: "Trivia night" },
  { a: "Big breakfast", b: "Big dinner" },
  { a: "Stairs", b: "Elevator" },
  { a: "Silence to focus", b: "Music to focus" },
  { a: "Hot weather", b: "Cold weather" },
  { a: "Sneakers", b: "Sandals" },
  { a: "Road trip", b: "Flight" },
  { a: "Comedy", b: "Thriller" },
  { a: "Cake", b: "Ice cream" },
  { a: "Online shopping", b: "In-store shopping" },
  { a: "Camping", b: "Hotel" },
  { a: "Phone call", b: "Email" },
  { a: "Gym", b: "Home workout" },
  { a: "Aisle browsing", b: "Search bar" },
  { a: "Team lunch", b: "Eat at your desk" },
  { a: "Standing desk", b: "Sitting desk" },
  { a: "Group chat", b: "One-on-one" },
  { a: "Notifications on", b: "Do not disturb" },
  { a: "Handwritten notes", b: "Typed notes" },
  { a: "Ask for directions", b: "Figure it out yourself" },
  { a: "Spicy food", b: "Mild food" },
  { a: "Rewatch a favorite", b: "Try something new" },
  { a: "Physical books", b: "E-books" },
  { a: "Cold AC", b: "Warm office" },
  { a: "Multitask", b: "One thing at a time" },
  { a: "Text back fast", b: "Take your time" },
  { a: "Plan the trip", b: "Wing the trip" },
  { a: "Sunrise", b: "Sunset" },
  { a: "Comfy shoes", b: "Stylish shoes" },
  { a: "Instant coffee", b: "Brewed coffee" },
  { a: "Big parties", b: "Small get-togethers" },
  { a: "Save dessert for last", b: "Dessert first" },
  { a: "Board games", b: "Video games" },
  { a: "Talk it out", b: "Think it through" },
  { a: "Alarm clock", b: "Wake up naturally" },
];

// Word Race pool (SERVER-ONLY — the client gets the scramble, never the word,
// until the match is over). Office-themed, 5–8 letters, all uppercase.
const WR_WORDS = [
  "OFFICE", "COFFEE", "MEETING", "KEYBOARD", "MONITOR", "PRINTER", "STAPLER",
  "FOLDER", "LAPTOP", "DEADLINE", "INVOICE", "PAYROLL", "BUDGET", "REPORT",
  "MANAGER", "CLIENT", "PROJECT", "CALENDAR", "AGENDA", "BINDER", "PANTRY",
  "ARCHIVE", "CONTRACT", "TEAMWORK", "SCHEDULE", "PENCIL", "ERASER", "DRAWER",
  "CUBICLE", "ELEVATOR", "HALLWAY", "FEEDBACK", "TRAINING", "HOLIDAY",
  "WEEKEND", "OVERTIME", "RECEIPT", "SCANNER", "DESKTOP", "SUPPLIES",
];
const WR_WORD_SET = new Set(WR_WORDS);

// Trivia Duel pool (SERVER-ONLY — the correct index NEVER leaves the server
// before the reveal). Easy/medium general knowledge, 4 options each; a match
// draws TRIV_ROUNDS distinct questions so no repeats within a match.
// { q, opts: [4 strings], c: correct index 0-3 }
const TRIV_QS = [
  { q: "How many continents are there?", opts: ["5", "6", "7", "8"], c: 2 },
  { q: "What is the largest planet in our solar system?", opts: ["Earth", "Saturn", "Neptune", "Jupiter"], c: 3 },
  { q: "Which ocean is the largest?", opts: ["Atlantic", "Pacific", "Indian", "Arctic"], c: 1 },
  { q: "How many minutes are in a full day?", opts: ["1240", "1380", "1440", "1560"], c: 2 },
  { q: "What color do you get by mixing blue and yellow?", opts: ["Purple", "Green", "Orange", "Brown"], c: 1 },
  { q: "Which animal is the tallest in the world?", opts: ["Elephant", "Giraffe", "Ostrich", "Camel"], c: 1 },
  { q: "How many sides does a hexagon have?", opts: ["5", "6", "7", "8"], c: 1 },
  { q: "What is the capital of Japan?", opts: ["Osaka", "Kyoto", "Tokyo", "Seoul"], c: 2 },
  { q: "Which planet is known as the Red Planet?", opts: ["Venus", "Mars", "Mercury", "Jupiter"], c: 1 },
  { q: "What is H2O more commonly known as?", opts: ["Salt", "Oxygen", "Water", "Hydrogen"], c: 2 },
  { q: "How many legs does a spider have?", opts: ["6", "8", "10", "12"], c: 1 },
  { q: "Which is the smallest prime number?", opts: ["0", "1", "2", "3"], c: 2 },
  { q: "What does 'www' stand for?", opts: ["World Wide Web", "Web World Wide", "Wide World Web", "World Web Wide"], c: 0 },
  { q: "How many colors are in a rainbow?", opts: ["5", "6", "7", "8"], c: 2 },
  { q: "Which country is famous for the Eiffel Tower?", opts: ["Italy", "France", "Spain", "Germany"], c: 1 },
  { q: "What is the fastest land animal?", opts: ["Lion", "Horse", "Cheetah", "Leopard"], c: 2 },
  { q: "How many days are in a leap year?", opts: ["364", "365", "366", "367"], c: 2 },
  { q: "Which fruit is famous for keeping the doctor away?", opts: ["Banana", "Apple", "Orange", "Mango"], c: 1 },
  { q: "What is the largest mammal on Earth?", opts: ["Elephant", "Blue whale", "Hippo", "Giraffe"], c: 1 },
  { q: "How many strings does a standard guitar have?", opts: ["4", "5", "6", "7"], c: 2 },
  { q: "Which month has 28 days in a common year?", opts: ["January", "February", "April", "June"], c: 1 },
  { q: "What do bees make?", opts: ["Milk", "Silk", "Honey", "Wax paper"], c: 2 },
  { q: "Which shape has three sides?", opts: ["Square", "Triangle", "Circle", "Pentagon"], c: 1 },
  { q: "What is the boiling point of water at sea level (°C)?", opts: ["50", "90", "100", "120"], c: 2 },
  { q: "Which is the longest river in the world?", opts: ["Amazon", "Nile", "Yangtze", "Mississippi"], c: 1 },
  { q: "How many players are on a basketball court per team?", opts: ["4", "5", "6", "7"], c: 1 },
  { q: "What is the currency of the United States?", opts: ["Peso", "Euro", "Dollar", "Pound"], c: 2 },
  { q: "Which bird is known for mimicking human speech?", opts: ["Eagle", "Parrot", "Owl", "Penguin"], c: 1 },
  { q: "What is 9 × 8?", opts: ["64", "72", "81", "96"], c: 1 },
  { q: "Which sea creature has eight arms?", opts: ["Squid", "Jellyfish", "Octopus", "Starfish"], c: 2 },
  { q: "What is the capital of the Philippines?", opts: ["Cebu", "Davao", "Manila", "Quezon City"], c: 2 },
  { q: "Which of these is NOT a primary color of light?", opts: ["Red", "Green", "Blue", "Yellow"], c: 3 },
  { q: "How many hours are in three days?", opts: ["48", "60", "72", "84"], c: 2 },
  { q: "Which planet is closest to the sun?", opts: ["Venus", "Earth", "Mercury", "Mars"], c: 2 },
  { q: "What is the largest desert in the world?", opts: ["Gobi", "Sahara", "Antarctica", "Arabian"], c: 2 },
  { q: "How many keys does a standard piano have?", opts: ["66", "76", "88", "99"], c: 2 },
  { q: "Which language has the most native speakers?", opts: ["English", "Mandarin", "Spanish", "Hindi"], c: 1 },
  { q: "What does a thermometer measure?", opts: ["Speed", "Weight", "Temperature", "Pressure"], c: 2 },
  { q: "Which of these animals hibernates in winter?", opts: ["Bear", "Lion", "Zebra", "Giraffe"], c: 0 },
  { q: "How many zeros are in one million?", opts: ["5", "6", "7", "8"], c: 1 },
  { q: "What is the main ingredient of bread?", opts: ["Rice", "Corn", "Flour", "Sugar"], c: 2 },
  { q: "Which sport uses a shuttlecock?", opts: ["Tennis", "Badminton", "Squash", "Cricket"], c: 1 },
  { q: "What is the tallest mountain in the world?", opts: ["K2", "Kilimanjaro", "Everest", "Fuji"], c: 2 },
  { q: "How many bones does an adult human have?", opts: ["106", "186", "206", "306"], c: 2 },
  { q: "Which gas do plants absorb from the air?", opts: ["Oxygen", "Nitrogen", "Carbon dioxide", "Helium"], c: 2 },
  { q: "What is 15% of 200?", opts: ["20", "25", "30", "35"], c: 2 },
  { q: "Which instrument has black and white keys?", opts: ["Violin", "Piano", "Drum", "Flute"], c: 1 },
  { q: "How many sides does a stop sign have?", opts: ["6", "7", "8", "9"], c: 2 },
  { q: "Which country invented pizza?", opts: ["France", "Greece", "Italy", "Spain"], c: 2 },
  { q: "What do caterpillars turn into?", opts: ["Bees", "Moths or butterflies", "Beetles", "Dragonflies"], c: 1 },
  { q: "How many weeks are in a year?", opts: ["48", "50", "52", "54"], c: 2 },
  { q: "Which organ pumps blood around the body?", opts: ["Lungs", "Brain", "Heart", "Liver"], c: 2 },
  { q: "What is the freezing point of water (°C)?", opts: ["-10", "0", "5", "10"], c: 1 },
  { q: "Which of these is a NOT a mammal?", opts: ["Dolphin", "Bat", "Whale", "Shark"], c: 3 },
  { q: "How many letters are in the English alphabet?", opts: ["24", "25", "26", "27"], c: 2 },
  { q: "Which direction does the sun rise from?", opts: ["North", "South", "East", "West"], c: 2 },
  { q: "What is a group of lions called?", opts: ["Pack", "Pride", "Herd", "Flock"], c: 1 },
  { q: "How many wheels does a tricycle have?", opts: ["2", "3", "4", "6"], c: 1 },
  { q: "Which meal is typically eaten in the morning?", opts: ["Dinner", "Lunch", "Breakfast", "Supper"], c: 2 },
  { q: "What is 7 squared?", opts: ["14", "21", "49", "77"], c: 2 },
  { q: "Which metal is liquid at room temperature?", opts: ["Iron", "Mercury", "Gold", "Silver"], c: 1 },
  { q: "How many stars are on the flag of the Philippines?", opts: ["1", "2", "3", "4"], c: 2 },
  { q: "Which key combination is famous for copy?", opts: ["Ctrl+V", "Ctrl+C", "Ctrl+X", "Ctrl+Z"], c: 1 },
  { q: "What animal is the largest living bird?", opts: ["Eagle", "Ostrich", "Swan", "Albatross"], c: 1 },
];

let rpsSeq = 0;
const rpsBySocket = new Map(); // socketId → shared match object (both parties map to the SAME object)

// Every timer a match object can own, across all games. cancelMatchFor and
// finishMatch clear the whole set so no orphaned timer can fire on a dead match.
function clearMatchTimers(m) {
  clearTimeout(m.acceptTimer); clearTimeout(m.pickTimer);
  clearTimeout(m.moveTimer);   clearTimeout(m.signalTimer); clearTimeout(m.liveTimer);
  clearTimeout(m.roundTimer);  clearTimeout(m.revealTimer);
}

function rpsOtherId(m, id) { return id === m.challengerId ? m.targetId : m.challengerId; }

// Cancel any pending/picking match involving this socket id, notifying both
// sides. Keyed off rpsBySocket — NOT players[] — because dropLiveByEmail
// deletes players[id] before disconnecting the stale socket, and kickPlayer
// never disconnects the target at all. A match already settling is left alone
// (picks were locked; the result stands even if someone disconnects mid-settle).
function cancelMatchFor(id, reason) {
  const m = rpsBySocket.get(id);
  if (!m || (m.state !== "pending" && m.state !== "picking" && m.state !== "playing")) return;
  m.state = "done";
  clearMatchTimers(m);
  rpsBySocket.delete(m.challengerId);
  rpsBySocket.delete(m.targetId);
  const msg = reason || "Match cancelled — no coins moved.";
  io.to(m.challengerId).emit("rpsCancelled", { challengeId: m.id, reason: msg });
  io.to(m.targetId).emit("rpsCancelled", { challengeId: m.id, reason: msg });
}

// Create a pending challenge and notify both sides. Shared by the direct
// rpsChallenge handler and the arcade cabinet (which starts a friendly,
// 0-wager match). Callers must have already validated: both players exist,
// neither is in rpsBySocket, and the wager is affordable if > 0.
function startRpsChallenge(challengerId, targetId, wager, viaArcade = false, game = "rps") {
  const me = players[challengerId], target = players[targetId];
  if (!me || !target) return;
  const m = {
    id: ++rpsSeq, challengerId, targetId, wager, game,
    state: "pending", picks: {}, pickTimer: null,
    acceptTimer: setTimeout(() => cancelMatchFor(challengerId, "Challenge expired."), RPS_ACCEPT_MS),
  };
  rpsBySocket.set(challengerId, m);
  rpsBySocket.set(targetId, m);
  io.to(targetId).emit("rpsChallengeIncoming", {
    challengeId: m.id, fromId: challengerId, fromName: me.name, wager, game, timeoutMs: RPS_ACCEPT_MS, arcade: viaArcade,
  });
  io.to(challengerId).emit("rpsChallengeSent", {
    challengeId: m.id, toId: targetId, toName: target.name, wager, game, arcade: viaArcade,
  });
  console.log(`${GAME_NAMES[game]} challenge${viaArcade ? " (arcade)" : ""}: ${me.name} → ${target.name} (${wager} coins)`);
}

// Move the wager loser→winner. Email players settle in SQL with the same
// atomic relative pattern as buyCosmetic; session-only players settle in
// memory. Mixed matches do the SQL side FIRST and touch memory only after it
// succeeds, so a partial transfer is impossible. Returns coins actually moved.
async function rpsSettle(winnerId, loserId, wager) {
  const w = players[winnerId], l = players[loserId];
  if (!w || !l || !(wager > 0)) return 0;
  if (w.email && l.email) {
    const { rows } = await pool.query(
      `WITH debit AS (
         UPDATE jpo_players SET coins = coins - $3, updated_at = now()
          WHERE email = $2 AND coins >= $3
          RETURNING coins
       )
       UPDATE jpo_players SET coins = coins + $3, updated_at = now()
        WHERE email = $1 AND EXISTS (SELECT 1 FROM debit)
        RETURNING coins, (SELECT coins FROM debit) AS loser_coins`,
      [w.email, l.email, wager],
    );
    if (!rows[0]) return 0;
    w.coins = rows[0].coins;
    l.coins = rows[0].loser_coins;
    return wager;
  }
  if (!w.email && !l.email) {
    if (l.coins < wager) return 0;
    l.coins -= wager; w.coins += wager;
    return wager;
  }
  if (l.email) {  // email loser pays a session-only winner
    const { rows } = await pool.query(
      `UPDATE jpo_players SET coins = coins - $2, updated_at = now()
        WHERE email = $1 AND coins >= $2 RETURNING coins`,
      [l.email, wager],
    );
    if (!rows[0]) return 0;
    l.coins = rows[0].coins;
    w.coins += wager;
    return wager;
  }
  // session-only loser pays an email winner: check memory before the SQL credit
  if (l.coins < wager) return 0;
  const { rows } = await pool.query(
    `UPDATE jpo_players SET coins = coins + $2, updated_at = now()
      WHERE email = $1 RETURNING coins`,
    [w.email, wager],
  );
  if (!rows[0]) return 0;
  l.coins -= wager;
  w.coins = rows[0].coins;
  return wager;
}

// Shared settlement for EVERY game — the ONLY picking/playing → settling
// transition. The state flip is SYNCHRONOUS (before any await), so a late
// timer, a repeat tap/move/pick, or cancelMatchFor firing mid-settle are all
// no-ops (double-settle is impossible even though rpsSettle awaits SQL).
// `extras(recipientId, otherId)` merges game-specific fields (picks, board,
// reaction time) into each side's rpsResult payload.
async function finishMatch(m, { draw = false, winnerId, loserId, forfeit = false, extras } = {}) {
  if (m.state !== "picking" && m.state !== "playing") return;
  m.state = "settling";
  clearMatchTimers(m);
  const { challengerId: cId, targetId: tId, wager } = m;
  const done = () => { m.state = "done"; rpsBySocket.delete(cId); rpsBySocket.delete(tId); };
  const extra = (me, them) => (extras ? extras(me, them) : {});

  if (draw) {
    for (const [me, them] of [[cId, tId], [tId, cId]]) {
      io.to(me).emit("rpsResult", {
        challengeId: m.id, game: m.game, outcome: "draw", forfeit: false,
        wager, coinsDelta: 0, ...extra(me, them),
      });
    }
    io.emit("rpsIndicator", { draw: true, aId: cId, bId: tId });
    done();
    return;
  }

  let transferred = 0;
  if (wager > 0) {
    try {
      transferred = await rpsSettle(winnerId, loserId, wager);
    } catch (err) {
      console.error(`${m.game} settle failed:`, err);
    }
  }
  const wp = players[winnerId], lp = players[loserId];
  io.to(winnerId).emit("rpsResult", {
    challengeId: m.id, game: m.game, outcome: "win", forfeit,
    wager, coinsDelta: transferred, ...extra(winnerId, loserId),
  });
  io.to(loserId).emit("rpsResult", {
    challengeId: m.id, game: m.game, outcome: "lose", forfeit,
    wager, coinsDelta: -transferred, ...extra(loserId, winnerId),
  });
  if (wp) io.to(winnerId).emit("coinUpdate", { coins: wp.coins });
  if (lp) io.to(loserId).emit("coinUpdate", { coins: lp.coins });
  io.emit("rpsIndicator", { draw: false, winnerId, loserId });
  console.log(`${GAME_NAMES[m.game] || m.game}: ${wp?.name || "?"} beat ${lp?.name || "?"}${transferred ? ` for ${transferred} coins` : ""}${forfeit ? " (forfeit)" : ""}`);
  done();
}

// Resolve a picking-phase RPS match: called when both picks are in OR the pick
// timer expires. One picked → forfeit win; none → cancel (no coins move).
async function rpsResolve(m) {
  if (m.state !== "picking") return;   // double-fire guard (pick race vs timer)
  const { challengerId: cId, targetId: tId } = m;
  const pc = m.picks[cId], pt = m.picks[tId];
  if (!pc && !pt) {
    cancelMatchFor(cId, "Nobody picked in time — match cancelled, no coins moved.");
    return;
  }

  let winnerId, loserId, draw = false;
  if (pc && pt) {
    if (pc === pt) draw = true;
    else if (RPS_BEATS[pc] === pt) { winnerId = cId; loserId = tId; }
    else { winnerId = tId; loserId = cId; }
  } else if (pc) { winnerId = cId; loserId = tId; }
  else { winnerId = tId; loserId = cId; }

  await finishMatch(m, {
    draw, winnerId, loserId, forfeit: !(pc && pt),
    extras: (me, them) => ({ yourPick: m.picks[me] || null, theirPick: m.picks[them] || null }),
  });
}

// Tic-Tac-Toe helpers. Boards are 9-slot arrays of 'X' | 'O' | null; the
// server owns the board and turn — clients only send move intents.
function tttWinner(board) {
  for (const [a, b, c] of TTT_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return null;
}
function tttExtras(m) {
  return (me) => ({ board: m.board.slice(), yourMark: m.marks[me] });
}
// Per-move clock expiry: whoever's turn it is forfeits (mirrors the RPS
// pick-timeout forfeit). Timer callbacks re-check state at fire time.
function tttTimeout(m) {
  if (m.state !== "playing" || m.game !== "ttt") return;
  const slow = m.turn, fast = rpsOtherId(m, slow);
  finishMatch(m, { winnerId: fast, loserId: slow, forfeit: true, extras: tttExtras(m) })
    .catch((err) => console.error("ttt timeout resolve failed:", err));
}
function tttBroadcast(m) {
  for (const id of [m.challengerId, m.targetId]) {
    io.to(id).emit("tttState", {
      challengeId: m.id, board: m.board.slice(),
      yourTurn: m.state === "playing" && m.turn === id,
      yourMark: m.marks[id], moveMs: TTT_MOVE_MS,
    });
  }
}

// ── Icebreakers helpers ──────────────────────────────────────────────────────
// Round state lives on the match object: ibRound (1-based), ibPhase
// ('answer' | 'reveal'), ibSubs (socketId → {answer, guess}, reset per round),
// ibScores, ibPrompts (IB_ROUNDS distinct picks made at accept time). All
// timer callbacks capture the round number and re-check state/game/phase/round
// at fire time (same fire-time re-check discipline as tttTimeout/qdSignal), so
// a stale timer can never act on a later round or a cancelled match.
function ibExtras(m) {
  return (me, them) => ({ scores: { you: m.ibScores[me], them: m.ibScores[them] } });
}

function ibStartRound(m) {
  if (m.state !== "playing" || m.game !== "ib") return;
  m.ibPhase = "answer";
  m.ibSubs = {};
  const round = m.ibRound;
  const prompt = m.ibPrompts[round - 1];
  for (const id of [m.challengerId, m.targetId]) {
    io.to(id).emit("ibRound", {
      challengeId: m.id, round, rounds: IB_ROUNDS,
      prompt: { a: prompt.a, b: prompt.b },
      submitMs: IB_SUBMIT_MS,
      scores: { you: m.ibScores[id], them: m.ibScores[rpsOtherId(m, id)] },
    });
  }
  m.roundTimer = setTimeout(() => ibRoundTimeout(m, round), IB_SUBMIT_MS);
}

// Answer-window expiry: exactly one submitted → forfeit win for the submitter
// (mirrors the RPS pick-timeout); neither → cancel, no coins moved.
function ibRoundTimeout(m, round) {
  if (m.state !== "playing" || m.game !== "ib" || m.ibPhase !== "answer" || m.ibRound !== round) return;
  const submitted = [m.challengerId, m.targetId].filter((id) => m.ibSubs[id]);
  if (submitted.length === 0) {
    cancelMatchFor(m.challengerId, "Nobody answered in time — match cancelled, no coins moved.");
    return;
  }
  const winnerId = submitted[0], loserId = rpsOtherId(m, winnerId);
  finishMatch(m, { winnerId, loserId, forfeit: true, extras: ibExtras(m) })
    .catch((err) => console.error("ib timeout resolve failed:", err));
}

// Both answers are in: score the guesses, show the reveal, then (after a
// reading pause) either start the next round or settle the match.
function ibReveal(m) {
  if (m.state !== "playing" || m.game !== "ib" || m.ibPhase !== "answer") return;
  clearTimeout(m.roundTimer);
  m.ibPhase = "reveal";
  const cId = m.challengerId, tId = m.targetId;
  const round = m.ibRound;
  const prompt = m.ibPrompts[round - 1];
  const subC = m.ibSubs[cId], subT = m.ibSubs[tId];
  if (subC.guess === subT.answer) m.ibScores[cId]++;
  if (subT.guess === subC.answer) m.ibScores[tId]++;
  const final = round >= IB_ROUNDS;
  for (const [me, them] of [[cId, tId], [tId, cId]]) {
    const mine = m.ibSubs[me], theirs = m.ibSubs[them];
    io.to(me).emit("ibReveal", {
      challengeId: m.id, round, rounds: IB_ROUNDS,
      prompt: { a: prompt.a, b: prompt.b },
      you:  { answer: mine.answer,   guess: mine.guess,   gotPoint: mine.guess === theirs.answer },
      them: { answer: theirs.answer, guess: theirs.guess, gotPoint: theirs.guess === mine.answer },
      scores: { you: m.ibScores[me], them: m.ibScores[them] },
      final, revealMs: IB_REVEAL_MS,
    });
  }
  m.revealTimer = setTimeout(() => {
    if (m.state !== "playing" || m.game !== "ib" || m.ibPhase !== "reveal" || m.ibRound !== round) return;
    if (!final) { m.ibRound++; ibStartRound(m); return; }
    const a = m.ibScores[cId], b = m.ibScores[tId];
    const opts = a === b
      ? { draw: true, extras: ibExtras(m) }
      : { winnerId: a > b ? cId : tId, loserId: a > b ? tId : cId, extras: ibExtras(m) };
    finishMatch(m, opts).catch((err) => console.error("ib resolve failed:", err));
  }, IB_REVEAL_MS);
}

// ── Trivia Duel helpers ──────────────────────────────────────────────────────
// Round state on the match object: trivRound (1-based), trivPhase ('answer' |
// 'reveal'), trivAns (socketId → {choice, seq, at}, reset per round),
// trivScores, trivQs (TRIV_ROUNDS distinct picks made at accept time), trivSeq
// (monotonic arrival counter — adjudicates "fastest correct" by SERVER arrival
// order, never client timestamps). The correct index NEVER leaves the server
// before the reveal. Reuses roundTimer/revealTimer (cleared by
// clearMatchTimers). Unlike Icebreakers, a missing answer is just WRONG — the
// round is scored and the match moves on (an idle match ends 0-0 = draw, no
// coins moved, same spirit as Word Race's unsolved draw).
function trivExtras(m) {
  return (me, them) => ({ scores: { you: m.trivScores[me], them: m.trivScores[them] } });
}

function trivStartRound(m) {
  if (m.state !== "playing" || m.game !== "trivia") return;
  m.trivPhase = "answer";
  m.trivAns = {};
  m.trivRoundStartAt = Date.now();   // for the reveal's "answered in 2.3s" flair
  const round = m.trivRound;
  const qq = m.trivQs[round - 1];
  for (const id of [m.challengerId, m.targetId]) {
    io.to(id).emit("trivRound", {
      challengeId: m.id, round, rounds: TRIV_ROUNDS,
      q: qq.q, options: qq.opts.slice(), answerMs: TRIV_ANSWER_MS,
      scores: { you: m.trivScores[id], them: m.trivScores[rpsOtherId(m, id)] },
    });
  }
  m.roundTimer = setTimeout(() => {
    if (m.state !== "playing" || m.game !== "trivia" || m.trivPhase !== "answer" || m.trivRound !== round) return;
    trivReveal(m);   // clock ran out — score whatever answers are in
  }, TRIV_ANSWER_MS);
}

// Score the round and show the reveal. Point goes to the FASTEST CORRECT
// answer (earliest server arrival among correct picks); none correct → no
// point. After the reading pause: next round, or settle on score (tie = draw).
function trivReveal(m) {
  if (m.state !== "playing" || m.game !== "trivia" || m.trivPhase !== "answer") return;
  clearTimeout(m.roundTimer);
  m.trivPhase = "reveal";
  const cId = m.challengerId, tId = m.targetId;
  const round = m.trivRound;
  const qq = m.trivQs[round - 1];
  const correct = [cId, tId]
    .filter((id) => m.trivAns[id] && m.trivAns[id].choice === qq.c)
    .sort((a, b) => m.trivAns[a].seq - m.trivAns[b].seq);
  const pointTo = correct[0] || null;
  if (pointTo) m.trivScores[pointTo]++;
  const final = round >= TRIV_ROUNDS;
  for (const [me, them] of [[cId, tId], [tId, cId]]) {
    const mk = (id) => {
      const a = m.trivAns[id];
      return {
        choice: a ? a.choice : null,
        correct: !!a && a.choice === qq.c,
        gotPoint: pointTo === id,
        ms: a ? a.at : null,   // answer time within the round, for the "2.3s" flair
      };
    };
    io.to(me).emit("trivReveal", {
      challengeId: m.id, round, rounds: TRIV_ROUNDS,
      correctIdx: qq.c,
      you: mk(me), them: mk(them),
      scores: { you: m.trivScores[me], them: m.trivScores[them] },
      final, revealMs: TRIV_REVEAL_MS,
    });
  }
  m.revealTimer = setTimeout(() => {
    if (m.state !== "playing" || m.game !== "trivia" || m.trivPhase !== "reveal" || m.trivRound !== round) return;
    if (!final) { m.trivRound++; trivStartRound(m); return; }
    const a = m.trivScores[cId], b = m.trivScores[tId];
    const opts = a === b
      ? { draw: true, extras: trivExtras(m) }
      : { winnerId: a > b ? cId : tId, loserId: a > b ? tId : cId, extras: trivExtras(m) };
    finishMatch(m, opts).catch((err) => console.error("trivia resolve failed:", err));
  }, TRIV_REVEAL_MS);
}

// ── Connect Four helpers ─────────────────────────────────────────────────────
// board = flat array of C4_COLS*C4_ROWS (index = row * C4_COLS + col, row 0 =
// TOP), cells null | 'R' | 'Y'. Discs fall to the lowest empty row of a
// column. Mirrors the TTT structure: per-move clock on moveTimer, timeout =
// forfeit by the slow side, server-authoritative validation, silent drop of
// bad moves.
function c4Extras(m) {
  return (me) => ({ board: m.board.slice(), yourDisc: m.discs[me] });
}
function c4Timeout(m) {
  if (m.state !== "playing" || m.game !== "c4") return;
  const slow = m.turn, fast = rpsOtherId(m, slow);
  finishMatch(m, { winnerId: fast, loserId: slow, forfeit: true, extras: c4Extras(m) })
    .catch((err) => console.error("c4 timeout resolve failed:", err));
}
function c4Broadcast(m) {
  for (const id of [m.challengerId, m.targetId]) {
    io.to(id).emit("c4State", {
      challengeId: m.id, board: m.board.slice(),
      yourTurn: m.state === "playing" && m.turn === id,
      yourDisc: m.discs[id], moveMs: C4_MOVE_MS,
      lastDrop: m.c4LastDrop ?? null,   // flat index of the newest disc, for the client's drop pop
    });
  }
}
// Four-in-a-row scan from the cell just played (the only cell that can
// complete a line): walk both ways along the 4 axes.
function c4Winner(board, idx) {
  const col = idx % C4_COLS, row = Math.floor(idx / C4_COLS);
  const disc = board[idx];
  for (const [dc, dr] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    let n = 1;
    for (const sign of [1, -1]) {
      let c = col + dc * sign, r = row + dr * sign;
      while (c >= 0 && c < C4_COLS && r >= 0 && r < C4_ROWS && board[r * C4_COLS + c] === disc) {
        n++; c += dc * sign; r += dr * sign;
      }
    }
    if (n >= 4) return true;
  }
  return false;
}

// ── Word Race helper ─────────────────────────────────────────────────────────
// Fisher-Yates until the scramble differs from the word AND isn't accidentally
// another pool word; bounded attempts because repeated-letter words make
// "shuffle until different" theoretically unbounded.
function wrScramble(word) {
  const letters = word.split("");
  let out = word;
  for (let attempt = 0; attempt < 20; attempt++) {
    for (let i = letters.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [letters[i], letters[j]] = [letters[j], letters[i]];
    }
    out = letters.join("");
    if (out !== word && !WR_WORD_SET.has(out)) return out;
  }
  return out;
}

// ── Opt-in load-test metrics (set LOADTEST_METRICS=1) ─────────────────────
// Zero overhead when unset: nothing is sampled or logged. The loadtest/
// harness spawns the server with this flag and parses the [metrics] lines to
// observe event-loop lag, RSS, connection counts, and coin-tick duration.
const LT_METRICS = process.env.LOADTEST_METRICS === "1";
const ltState = { coinTickMs: 0, mvOk: 0, mvThr: 0, mvRej: 0 };   // mv counters are cumulative
if (LT_METRICS) {
  const SAMPLE_MS = 100;
  let lagSamples = [];
  let lastSample = performance.now();
  setInterval(() => {
    const nowP = performance.now();
    lagSamples.push(Math.max(0, nowP - lastSample - SAMPLE_MS));
    lastSample = nowP;
  }, SAMPLE_MS);
  setInterval(() => {
    if (!lagSamples.length) return;
    lagSamples.sort((a, b) => a - b);
    const q = (p) => lagSamples[Math.min(lagSamples.length - 1, Math.floor(p * lagSamples.length))];
    const rssMb = process.memoryUsage().rss / 1048576;
    console.log(
      `[metrics] clients=${io.engine.clientsCount} players=${Object.keys(players).length}` +
      ` lag_p50=${q(0.5).toFixed(1)} lag_p99=${q(0.99).toFixed(1)} lag_max=${lagSamples[lagSamples.length - 1].toFixed(1)}` +
      ` rss_mb=${rssMb.toFixed(0)} coin_tick_ms=${ltState.coinTickMs}` +
      ` mv_ok=${ltState.mvOk} mv_thr=${ltState.mvThr} mv_rej=${ltState.mvRej}`,
    );
    lagSamples = [];
  }, 5000);
}

// Passive coin earning (+COIN_TICK_BASE/min per active player, +WORK_BONUS more
// while seated at a work desk — see isAtWorkSeat). We also flush each
// email-backed player's position in the same tick, so movement never triggers a
// per-move DB write. Coins are incremented atomically in SQL and read back, so
// concurrent purchases can't lose or double-count.
setInterval(async () => {
  const ltTickStart = Date.now();
  for (const id in players) {
    const p = players[id];
    const rate = COIN_TICK_BASE + (isAtWorkSeat(p) ? WORK_BONUS : 0);
    if (p.email) {
      try {
        const { rows } = await pool.query(
          `UPDATE jpo_players
              SET coins = coins + $6, x = $2, y = $3, dir = $4, anim = $5, updated_at = now()
            WHERE email = $1
            RETURNING coins`,
          [p.email, Math.round(p.x ?? 5304), Math.round(p.y ?? 2232), p.dir || "down", p.anim === "sit" ? "sit" : "idle", rate],
        );
        if (rows[0]) p.coins = rows[0].coins;
      } catch (err) {
        console.error("coin/position tick failed:", err);
        p.coins = (p.coins || 0) + rate;
      }
    } else {
      p.coins = (p.coins || 0) + rate;
    }
    io.to(id).emit("coinUpdate", { coins: p.coins });
  }
  ltState.coinTickMs = Date.now() - ltTickStart;
}, 60_000);

// ── Office After Dark rounds (ephemeral, in-memory only) ────────────────────
// One office-wide opt-in round at a time: a ~30s join window, then ONE secret
// killer vs everyone else ("crew"). Crew wins if anyone survives the round
// timer; the killer wins by eliminating all crew first. Winners get a small
// coin prize (atomic relative SQL, same pattern as the daily bonus — it only
// ADDS coins, so there is no wager-style exactness invariant to protect).
// Round state references LIVE SOCKETS (same rule as duels): a disconnect or
// refresh mid-round drops you from the round even though the PLAYER gets the
// usual grace window — the round must never wait on a ghost. Nothing is
// persisted: a server restart cancels the round harmlessly (clients clear all
// round UI on the socket 'disconnect' event, so no stuck darkness).
// SECRECY RULE: the killer's identity is sent ONLY to the killer (their own
// `role` in roundBegin) until roundEnd reveals it to all participants. Kill
// broadcasts carry only the victim. Keep it that way.
// ROUND_JOIN_MS / ROUND_DURATION_MS accept env overrides — TEST KNOBS ONLY
// (headless integration tests can't wait 3 real minutes); never set in prod.
const ROUND_JOIN_MS          = Math.max(3_000,  Number(process.env.ROUND_JOIN_MS) || 30_000);
const ROUND_DURATION_MS      = Math.max(10_000, Number(process.env.ROUND_DURATION_MS) || 180_000);
const ROUND_MIN_PLAYERS      = 3;
const ROUND_KILL_RANGE_PX    = 200;     // ~4 tiles at render scale 3 (well under RPS_RANGE_PX)
// Desync slack for the server-side kill check ONLY (never advertised to the
// client). The killer's server position is fed by throttled playerMoves, so it
// lags their on-screen position while they're walking; without slack, a kill
// the client's own range check legitimately offered gets rejected "Get
// closer…" mid-chase. The client still targets at ROUND_KILL_RANGE_PX.
const ROUND_KILL_SLACK_PX    = 80;
const ROUND_KILL_COOLDOWN_MS = 12_000;  // between kills — ALSO the arm delay before the first kill
const ROUND_PRIZE            = 25;      // per winner
// Killer speed edge: alive killers of the ACTIVE round walk this much faster
// than base speed, so they can close a chase. Delivered ONLY in the killers'
// private roundBegin payload (never broadcast — a public value would out them).
// Combines with a coffee boost by taking the LARGER multiplier, never the
// product; the client uses the same rule. Alive participants can't gain NEW
// boosts while the round is live (boost items + coffee machine are refused
// with the SAME message for crew and killers, so a refusal can't out anyone;
// group boosts skip everyone in the dark) and alive CREW have their move
// budget clamped to base speed — a pre-round coffee can't erase the edge.
const ROUND_KILLER_SPEED_MULT = 1.15;

let round = null;
// { state:'joining'|'active'|'ending', starterId, starterName,
//   members: Map<socketId, {name, alive, killReadyAt?}>,  ← includes the killers
//   killerIds: Set<socketId>, joinTimer, joinEndsAt, endTimer, endsAt }
// killReadyAt lives PER KILLER on the member record — with several killers a
// shared cooldown would let one killer's strike lock out the others.

// Killer count scales with the lobby at ~1 per 3 players (user-requested
// ratio): 3-4 → 1, 5-7 → 2, 8-10 → 3, 11-13 → 4, …
function killerCountFor(n) {
  return 1 + Math.floor(Math.max(0, n - 2) / 3);
}

// Who the killers were LAST round (emails, or socket ids for session-only
// players). Pure Math.random() picks the same person back-to-back
// surprisingly often with a small group (1-in-3 with 3 players), which
// feels rigged — so previous killers are excluded from the draw whenever
// enough other candidates remain to keep the pick a real choice. In-memory
// only: a restart forgets it, which is fine (worst case one repeat after a
// redeploy).
let lastKillerKeys = new Set();

function inRound(id)       { return !!round && round.members.has(id); }
function inActiveRound(id) { return !!round && round.state === "active" && round.members.has(id); }

// "In the dark": an ALIVE participant of the ACTIVE round (killer included).
// While a round is live these players must not receive chat/whispers from
// anyone OUTSIDE the dark (non-participants and eliminated ghosts have the
// lights on and were calling out positions to players still in the round).
function inTheDark(id) {
  if (!round || round.state !== "active") return false;
  const m = round.members.get(id);
  return !!m && m.alive;
}

// Roster sent to EVERY participant (ids/names/alive are not secret — clients
// need it for the kill affordance, 💀 flashes, and spectator rendering, and it
// must not include grace-window ghosts the killer could waste a kill on).
function roundRoster() {
  return [...round.members].map(([id, m]) => ({ id, name: m.name, alive: m.alive }));
}

function roundEmitMembers(event, payload) {
  for (const id of round.members.keys()) io.to(id).emit(event, payload);
}

function aliveCrewCount() {
  let n = 0;
  for (const [id, m] of round.members) if (m.alive && !round.killerIds.has(id)) n++;
  return n;
}

function cancelRound(reason) {
  if (!round) return;
  const r = round;
  round = null;
  clearTimeout(r.joinTimer); clearTimeout(r.endTimer);
  for (const id of r.members.keys()) io.to(id).emit("roundCancelled", { reason });
  console.log(`Office After Dark: cancelled (${reason})`);
}

// Join window expired: enough players → assign the killers and go dark.
function beginRound() {
  if (!round || round.state !== "joining") return;
  // Belt-and-braces: drop members whose player entry vanished without a
  // cleanup call (should not happen — roundHandleLeave covers every seam).
  for (const id of [...round.members.keys()]) if (!players[id]) round.members.delete(id);
  if (round.members.size < ROUND_MIN_PLAYERS) {
    cancelRound(`Not enough players — it takes at least ${ROUND_MIN_PLAYERS} to play.`);
    return;
  }
  const ids = [...round.members.keys()];
  const killerCount = killerCountFor(ids.length);
  // Exclude last round's killers from the draw when enough others remain to
  // keep it a real choice (identity keyed by email so reconnects/socket-id
  // churn can't dodge it).
  const keyOf = (id) => (players[id]?.email || id);
  const pool = ids.filter((id) => !lastKillerKeys.has(keyOf(id)));
  const candidates = pool.length >= killerCount + 1 ? pool : ids;
  // Fisher-Yates shuffle a copy, take the first killerCount as the killers.
  const deck = [...candidates];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  round.killerIds = new Set(deck.slice(0, killerCount));
  // Name snapshot at draw time: the end-card reveal must name ALL killers,
  // including any who leave mid-round (leavers vanish from members/killerIds).
  round.killerNameOf = new Map([...round.killerIds].map((k) => [k, round.members.get(k).name]));
  lastKillerKeys  = new Set([...round.killerIds].map(keyOf));
  round.state     = "active";
  round.endsAt    = Date.now() + ROUND_DURATION_MS;
  round.endTimer  = setTimeout(() => {
    endRound("crew").catch((err) => console.error("round timer end failed:", err));
  }, ROUND_DURATION_MS);
  const armAt = Date.now() + ROUND_KILL_COOLDOWN_MS;   // arm delay = one cooldown
  for (const kid of round.killerIds) round.members.get(kid).killReadyAt = armAt;
  const roster = roundRoster();
  for (const id of ids) {
    // Identical payload for every crew member — only `role` differs (and only
    // killers additionally get their accomplices, so a killer team never
    // wastes a kill on each other). Constants (cooldown, prize) leak nothing.
    const isKiller = round.killerIds.has(id);
    io.to(id).emit("roundBegin", {
      role: isKiller ? "killer" : "crew",
      accomplices: isKiller
        ? [...round.killerIds].filter((k) => k !== id).map((k) => ({ id: k, name: round.members.get(k).name }))
        : undefined,
      // Killer-only: the speed edge multiplier (private, like `accomplices` —
      // crew must never receive it or the payload difference would leak).
      speedMult: isKiller ? ROUND_KILLER_SPEED_MULT : undefined,
      durationMs: ROUND_DURATION_MS,
      killCooldownMs: ROUND_KILL_COOLDOWN_MS,
      killRangePx: ROUND_KILL_RANGE_PX,
      players: roster,
      prize: ROUND_PRIZE,
    });
  }
  // Assignment log: lets future "who was the killer" reports be checked
  // against facts instead of memory.
  const killerNames = [...round.killerIds].map((k) => round.members.get(k).name);
  console.log(`Office After Dark: round started with ${ids.length} players — ${killerCount} killer(s): ${killerNames.join(", ")}`);
}

// The ONLY active → ending transition. The state flip is SYNCHRONOUS (before
// any await), so a late end timer, a kill, or a leave firing mid-payout are
// all no-ops — same double-settle discipline as finishMatch. Winner identities
// (id/name/email) are snapshotted BEFORE the await because players[] entries
// can vanish while the payout SQL is in flight.
async function endRound(outcome, { forfeit = false } = {}) {
  if (!round || round.state !== "active") return;
  const r = round;
  r.state = "ending";
  clearTimeout(r.joinTimer); clearTimeout(r.endTimer);
  // Reveal names come from the draw-time snapshot so killers who LEFT are
  // still named; payouts come from members ∩ killerIds, so a leaver gets no
  // prize (they forfeited their spot).
  const killerNames = r.killerNameOf ? [...r.killerNameOf.values()] : [];
  const winnerPairs = outcome === "crew"
    ? [...r.members].filter(([id, m]) => m.alive && !r.killerIds.has(id))
    : [...r.members].filter(([id]) => r.killerIds.has(id));
  const winners = winnerPairs.map(([id, m]) => ({ id, name: m.name, email: players[id]?.email || null }));

  for (const w of winners) {
    try {
      if (w.email) {
        const { rows } = await pool.query(
          `UPDATE jpo_players SET coins = coins + $2, updated_at = now() WHERE email = $1 RETURNING coins`,
          [w.email, ROUND_PRIZE],
        );
        const p = players[w.id];
        if (rows[0] && p && p.email === w.email) {
          p.coins = rows[0].coins;
          io.to(w.id).emit("coinUpdate", { coins: p.coins });
        }
      } else {
        const p = players[w.id];   // session-only: memory credit (same as their duels)
        if (p) { p.coins += ROUND_PRIZE; io.to(w.id).emit("coinUpdate", { coins: p.coins }); }
      }
    } catch (err) { console.error("round payout failed:", err); }
  }

  const payload = {
    outcome, forfeit,
    killerIds: r.killerNameOf ? [...r.killerNameOf.keys()] : [...r.killerIds],
    killerNames,
    killerName: killerNames.join(" & ") || "???",   // legacy single-name field
    winners: winners.map((w) => w.name),
    prize: ROUND_PRIZE,
  };
  for (const id of r.members.keys()) io.to(id).emit("roundEnd", payload);
  if (round === r) round = null;
  console.log(`Office After Dark: ${outcome === "crew" ? "crew survived" : `the killer(s) (${killerNames.join(", ")}) won`}${forfeit ? " (forfeit)" : ""} — ${winners.length} winner(s) × ${ROUND_PRIZE} coins`);
}

function checkKillerWin() {
  if (round && round.state === "active" && aliveCrewCount() === 0) {
    endRound("killer").catch((err) => console.error("round killer-win end failed:", err));
  }
}

// Remove a departing socket from the round — the round-side seam mirrored on
// cancelMatchFor and hooked into the SAME three places (disconnect, kickPlayer,
// dropLiveByEmail). Keyed off round.members, NOT players[] — dropLiveByEmail
// deletes players[id] before this runs, and kickPlayer never disconnects.
function roundHandleLeave(id) {
  if (!round || !round.members.has(id)) return;
  if (round.state === "joining") {
    round.members.delete(id);
    if (round.members.size === 0) cancelRound("Everyone left before the round began.");
    // Broadcast to EVERYONE (count only, leaks nothing) so the invite card's
    // "N in so far" stays fresh for people who haven't joined yet.
    else io.emit("roundLobby", { count: round.members.size });
    return;
  }
  if (round.state !== "active") return;   // 'ending' → settlement stands
  if (round.killerIds.has(id)) {
    // A vanished killer can't win by hiding offline. With several killers the
    // round survives losing one — only the LAST killer leaving hands the crew
    // an instant forfeit win.
    round.killerIds.delete(id);
    round.members.delete(id);
    if (round.killerIds.size === 0) {
      endRound("crew", { forfeit: true }).catch((err) => console.error("round killer-leave end failed:", err));
      return;
    }
    roundEmitMembers("roundLeft", { id });
    console.log("Office After Dark: a killer left — the round continues");
    return;
  }
  round.members.delete(id);               // crew leaver forfeits any prize
  roundEmitMembers("roundLeft", { id });
  checkKillerWin();
}

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  // Per-connection rate-limit state — closed over by the handlers below and
  // GC'd with the socket on disconnect (no global map to clean up).
  const chatBucket  = makeBucket(5, 700);   // ~1.4 msgs/s sustained, burst of 5
  const buyBucket   = makeBucket(3, 500);   // guards rapid buy-spam / double-clicks
  const postBucket  = makeBucket(3, 1000);  // guards announcement spam
  const emoteBucket = makeBucket(4, 900);   // ~1 emote/s sustained, burst of 4
  const rpsBucket   = makeBucket(3, 2000);  // guards challenge spam (~1 per 2s sustained)
  const wrBucket    = makeBucket(6, 500);   // Word Race guesses (~2/s sustained, burst of 6)
  const itemBucket  = makeBucket(3, 1500);  // guards item-use spam (~1 per 1.5s sustained)
  const profileBucket = makeBucket(4, 1000); // guards profile-open / department-set spam
  const interactBucket = makeBucket(4, 1500);  // guards office-object spam (~1 per 1.5s sustained)
  const roundBucket = makeBucket(4, 1500);     // guards round start/join/kill spam
  let lastMoveAt = 0;                       // last ACCEPTED playerMove ts (0 = none yet)
  let wasSitting = false;                   // last reported sit state, to detect sit<->stand snaps
  let lastSnapAt = 0;                       // last time a seat-snap allowance was granted

  // Send the current announcement board to every new connection.
  fetchAnnouncements()
    .then((a) => socket.emit("announcements", a))
    .catch((err) => console.error("announcements load failed:", err));

  // ── Registration ─────────────────────────────────────────────────────
  // Auth rules (email-backed):
  //   • Existing row WITH a password → the supplied password must verify BEFORE
  //     we touch the row or drop any live session (a wrong password must not be
  //     able to overwrite a profile or disconnect the real player).
  //   • Existing row WITHOUT a password (legacy) → the first register claims it
  //     by setting the password, atomically (WHERE password_hash IS NULL).
  //   • New email → row is created with the password. Everyone waits for
  //     approval as before; approved emails restore straight into the office.
  socket.on("register", async (payload) => {
    try {
      const { firstName, lastName, nickname, email, password, character, hairIdx, skinIdx, shirtIdx, pantsIdx, clothesIdx, department } = payload || {};
      const fn   = (firstName || "").trim().slice(0, 20) || "Guest";
      const ln   = (lastName  || "").trim().slice(0, 20);
      const nick = (nickname  || "").trim().slice(0, 16) || fn;
      const em   = (email     || "").trim().slice(0, 80).toLowerCase();
      // The email becomes the PRIMARY KEY and flows into admin-panel markup
      // (including `email:<address>` pending ids inside onclick attributes) —
      // enforce a strict shape so quotes/spaces/HTML can never become a PK.
      // Empty stays allowed (session-only fallback below); invalid is rejected.
      if (em && !EMAIL_RE.test(em)) {
        socket.emit("authFailed", { message: "Enter a valid email address." });
        return;
      }
      const pw   = typeof password === "string" ? password.slice(0, PASSWORD_MAX) : "";
      const char = ["adam","alex","amelia","bob"].includes(character) ? character : "adam";
      const name = ln ? `${fn} ${ln}` : fn;

      const reg = {
        firstName: fn, lastName: ln, email: em, character: char, name, nickname: nick,
        hairIdx:  clampIdx(hairIdx, 8),
        skinIdx:  clampIdx(skinIdx, 6),
        // Legacy clients send a single clothesIdx for both — fall back to it when split fields are absent.
        shirtIdx: clampIdx(shirtIdx ?? clothesIdx, CLOTH_MAX),
        pantsIdx: clampIdx(pantsIdx ?? clothesIdx, CLOTH_MAX),
        // Unknown/missing department → '' (never stored); the upsert keeps any
        // previously-set department when '' comes in, so a forged value can't
        // clear it either.
        department: DEPARTMENTS.includes(department) ? department : "",
      };

      // No email → we can't persist (email is the identity key). Fall back to a
      // session-only pending flow so a non-standard client can still play; none
      // of their state survives a restart. The web client requires a valid
      // email, so this only guards unusual clients.
      if (!em) {
        pending[socket.id] = reg;
        socket.emit("registrationPending");
        _notifyAdmins();
        console.log(`Pending (session-only): ${name}`);
        return;
      }

      if (pw.length < PASSWORD_MIN) {
        socket.emit("authFailed", { message: `Password must be at least ${PASSWORD_MIN} characters.` });
        return;
      }
      if (!authAllowed(em)) {
        socket.emit("authFailed", { message: "Too many attempts — wait 30 seconds and try again." });
        return;
      }

      const { rows: existingRows } = await pool.query(`SELECT * FROM jpo_players WHERE email = $1`, [em]);
      const existing = existingRows[0];

      if (existing && existing.password_hash) {
        // Established account: verify BEFORE any mutation or live-session drop.
        const ok = await verifyPassword(pw, existing.password_hash);
        if (!ok) {
          socket.emit("authFailed", { message: "Wrong password for this email. Use Sign in, or ask an admin to reset it." });
          console.log(`Auth failed (register): <${em}>`);
          return;
        }
      } else if (existing) {
        // Legacy passwordless account: claim it atomically. If another socket
        // wins the race, fall back to verifying against the winner's hash.
        const hash = await hashPassword(pw);
        const { rows: claimed } = await pool.query(
          `UPDATE jpo_players
              SET password_hash = $2, password_set_at = now(), updated_at = now()
            WHERE email = $1 AND password_hash IS NULL
            RETURNING email`,
          [em, hash],
        );
        if (!claimed[0]) {
          const { rows: rr } = await pool.query(`SELECT password_hash FROM jpo_players WHERE email = $1`, [em]);
          const ok = rr[0] && await verifyPassword(pw, rr[0].password_hash);
          if (!ok) {
            socket.emit("authFailed", { message: "Wrong password for this email. Use Sign in, or ask an admin to reset it." });
            return;
          }
        } else {
          console.log(`Password set (claimed legacy account): <${em}>`);
        }
      }

      // Authenticated (or brand-new email) from here on.
      dropLiveByEmail(em, socket.id);

      let row;
      if (existing) {
        row = await upsertPlayerProfile(reg);
      } else {
        // New account: create profile + password in one insert. A concurrent
        // first-register of the same email resolves via ON CONFLICT in
        // upsertPlayerProfile-like semantics: keep it simple — insert, and on
        // conflict fall back to the claim/verify path by re-running register
        // logic is overkill for a first-touch race; the profile upsert plus an
        // atomic passwordless claim covers it.
        const hash = await hashPassword(pw);
        row = await upsertPlayerProfile(reg);
        const { rows: claimed } = await pool.query(
          `UPDATE jpo_players
              SET password_hash = $2, password_set_at = now(), updated_at = now()
            WHERE email = $1 AND password_hash IS NULL
            RETURNING *`,
          [em, hash],
        );
        if (claimed[0]) {
          row = claimed[0];
        } else {
          // Lost a same-instant race: someone else set a password first — verify.
          const { rows: rr } = await pool.query(`SELECT * FROM jpo_players WHERE email = $1`, [em]);
          const ok = rr[0] && await verifyPassword(pw, rr[0].password_hash);
          if (!ok) {
            socket.emit("authFailed", { message: "Wrong password for this email. Use Sign in, or ask an admin to reset it." });
            return;
          }
          row = rr[0];
        }
      }

      // Known + approved email → restore straight into the office (this is the
      // "resume where they left off" path). Everyone else waits for approval.
      if (row.approved) {
        await restorePlayer(socket, row);
        _notifyAdmins();
        console.log(`Restored: ${row.name} <${em}>`);
      } else {
        pending[socket.id] = reg;
        socket.emit("registrationPending");
        _notifyAdmins();
        console.log(`Pending: ${name} <${em}>`);
      }
    } catch (err) {
      console.error("register failed:", err);
      socket.emit("authFailed", { message: "Something went wrong — try again." });
    }
  });

  // ── Sign in (returning player with a password) ────────────────────────
  // No profile changes here — it only authenticates and restores.
  // NOTE (all handlers below): never destructure the raw socket payload in the
  // parameter list — `({ x } = {})` still throws on an explicit `null` payload,
  // and one malicious `socket.emit("event", null)` would crash the whole server.
  // Always take `payload` and destructure from `payload || {}`.
  socket.on("login", async (payload) => {
    const { email, password } = payload || {};
    try {
      const em = (email || "").trim().slice(0, 80).toLowerCase();
      const pw = typeof password === "string" ? password.slice(0, PASSWORD_MAX) : "";
      if (!em || !pw) { socket.emit("loginFailed", { message: "Email and password are required." }); return; }
      if (!authAllowed(em)) {
        socket.emit("loginFailed", { message: "Too many attempts — wait 30 seconds and try again." });
        return;
      }

      const { rows } = await pool.query(`SELECT * FROM jpo_players WHERE email = $1`, [em]);
      const row = rows[0];
      if (!row) { socket.emit("loginFailed", { message: "No account with that email — use Join to register." }); return; }
      if (!row.password_hash) {
        socket.emit("loginFailed", { message: "This account has no password yet — use Join once to set one." });
        return;
      }
      const ok = await verifyPassword(pw, row.password_hash);
      if (!ok) {
        socket.emit("loginFailed", { message: "Wrong password." });
        console.log(`Auth failed (login): <${em}>`);
        return;
      }

      // Authenticated: now it's safe to drop any older live session.
      dropLiveByEmail(em, socket.id);

      if (row.approved) {
        await restorePlayer(socket, row);
        _notifyAdmins();
        console.log(`Signed in: ${row.name} <${em}>`);
      } else {
        cancelGrace(em);
        pending[socket.id] = {
          firstName: row.first_name, lastName: row.last_name, email: row.email,
          character: row.character, name: row.name, nickname: row.nickname,
          hairIdx: row.hair_idx, skinIdx: row.skin_idx,
          shirtIdx: row.shirt_idx, pantsIdx: row.pants_idx,
        };
        // Actively coming back = re-enter the approval queue: clear any
        // earlier admin dismissal so the DB-backed pending list shows them.
        if (row.dismissed) await pool.query(`UPDATE jpo_players SET dismissed = false, updated_at = now() WHERE email = $1`, [em]);
        socket.emit("registrationPending");
        _notifyAdmins();
        console.log(`Signed in (pending approval): ${row.name} <${em}>`);
      }
    } catch (err) {
      console.error("login failed:", err);
      socket.emit("loginFailed", { message: "Something went wrong — try again." });
    }
  });

  // ── Resume (auto-rejoin with a signed token) ──────────────────────────
  // A returning browser sends its stored token instead of re-filling the form.
  // We validate it, look up the durable row, and either drop them straight back
  // into the office (approved) or back into the waiting queue (not approved).
  socket.on("resumeSession", async (payload) => {
    const { token } = payload || {};
    try {
      const data = verifyToken(token);
      if (!data) { socket.emit("resumeFailed"); return; }
      const em = data.email;

      const { rows } = await pool.query(`SELECT * FROM jpo_players WHERE email = $1`, [em]);
      const row = rows[0];
      if (!row) { socket.emit("resumeFailed"); return; }

      // Tokens are session credentials now: any token issued BEFORE the account's
      // password was (re)set is void — a pre-password bystander token (or a
      // reset-out attacker's token) can't bypass the password gate. Checked
      // BEFORE dropLiveByEmail so a voided token can't disconnect the real player.
      if (row.password_set_at && data.iat < new Date(row.password_set_at).getTime()) {
        socket.emit("resumeFailed");
        return;
      }

      // One live session per email — drop any stale live duplicate.
      dropLiveByEmail(em, socket.id);

      if (row.approved) {
        await restorePlayer(socket, row);
        _notifyAdmins();
        console.log(`Resumed: ${row.name} <${em}>`);
      } else {
        // Approved-then-revoked (kicked) or still awaiting first approval: rebuild
        // the pending entry from the row so admins can (re-)approve them.
        cancelGrace(em);
        pending[socket.id] = {
          firstName: row.first_name, lastName: row.last_name, email: row.email,
          character: row.character, name: row.name, nickname: row.nickname,
          hairIdx: row.hair_idx, skinIdx: row.skin_idx,
          shirtIdx: row.shirt_idx, pantsIdx: row.pants_idx,
        };
        // Actively coming back = re-enter the approval queue: clear any
        // earlier admin dismissal so the DB-backed pending list shows them.
        if (row.dismissed) await pool.query(`UPDATE jpo_players SET dismissed = false, updated_at = now() WHERE email = $1`, [em]);
        socket.emit("registrationPending");
        _notifyAdmins();
        console.log(`Resume pending (not approved): ${row.name} <${em}>`);
      }
    } catch (err) {
      console.error("resumeSession failed:", err);
      socket.emit("resumeFailed");
    }
  });

  // ── Admin auth ───────────────────────────────────────────────────────
  socket.on("adminAuth", (payload) => {
    const { password } = payload || {};
    if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) { socket.emit("adminAuthFail"); return; }
    admins.add(socket.id);
    socket.emit("adminAuthOk");
    _pendingList().then(l => socket.emit("pendingList", l)).catch(err => console.error("adminAuth pending list failed:", err));
    socket.emit("playerList",  _playerList());
  });

  // Pull-based refresh: the open admin panel re-requests both lists every few
  // seconds (and once on open), so a missed push — connection blip, zombie
  // socket, anything — can never leave the panel stale until a page refresh.
  socket.on("adminRefresh", () => {
    if (!admins.has(socket.id)) return;
    _pendingList().then(l => socket.emit("pendingList", l)).catch(err => console.error("adminRefresh failed:", err));
    socket.emit("playerList", _playerList());
  });

  socket.on("approvePlayer", async (targetId) => {
    if (!admins.has(socket.id)) return;
    if (typeof targetId !== "string") return;
    // Offline entries from the DB-backed pending list carry an `email:<email>`
    // id instead of a live socket id — approving one just flips the row; the
    // person walks straight into the office on their next visit.
    const reg = pending[targetId];
    const offlineEmail = !reg && targetId.startsWith("email:") ? targetId.slice(6) : null;
    if (!reg && !offlineEmail) return;
    if (reg) delete pending[targetId];

    try {
      // Session-only (no email) registrant: approve into memory only.
      if (reg && !reg.email) {
        const state = {
          x: 5304, y: 2232, dir: "down", anim: "idle",
          name: reg.nickname || reg.firstName || reg.name, fullName: reg.name,
          email: "", character: reg.character,
          hairIdx: reg.hairIdx, skinIdx: reg.skinIdx, shirtIdx: reg.shirtIdx, pantsIdx: reg.pantsIdx,
          coins: 50, cosmetics: [], equipped: "", pet: "", items: {}, isAnnouncer: false,
          department: reg.department || "", createdAt: Date.now(),
        };
        players[targetId] = state;
        io.to(targetId).emit("approved", {
          name: state.name, character: state.character,
          hairIdx: state.hairIdx, skinIdx: state.skinIdx, shirtIdx: state.shirtIdx, pantsIdx: state.pantsIdx,
          coins: state.coins, cosmetics: state.cosmetics, equipped: state.equipped, pet: state.pet, items: state.items,
        });
        io.to(targetId).emit("currentPlayers", players);
        io.to(targetId).emit("announcerStatus", { canPost: false });
        io.to(targetId).emit("announcements", await fetchAnnouncements());
        for (const pid in players) {
          if (pid !== targetId) io.to(pid).emit("playerJoined", { id: targetId, ...state });
        }
        _notifyAdmins();
        console.log(`Approved (session-only): ${reg.name}`);
        return;
      }

      const em = reg ? reg.email : offlineEmail;
      const { rows } = await pool.query(
        `UPDATE jpo_players SET approved = true, dismissed = false, updated_at = now() WHERE email = $1 RETURNING *`,
        [em],
      );
      const row = rows[0];
      if (!row) return;

      // Prefer the clicked socket; fall back to ANY live pending socket for
      // this email (the person may have reconnected under a new socket id
      // since the admin's list was rendered). No live socket = offline
      // approval — nothing to restore now, auto-restore handles their return.
      let targetSocket = reg ? io.sockets.sockets.get(targetId) : null;
      if (!targetSocket) {
        for (const [pid, p] of Object.entries(pending)) {
          if (p.email === em) {
            targetSocket = io.sockets.sockets.get(pid);
            if (targetSocket) { delete pending[pid]; break; }
          }
        }
      }
      if (targetSocket) await restorePlayer(targetSocket, row);
      _notifyAdmins();
      console.log(`Approved: ${row.name}${targetSocket ? "" : " (offline — enters on next visit)"}`);
    } catch (err) {
      console.error("approvePlayer failed:", err);
    }
  });

  socket.on("rejectPlayer", async (targetId) => {
    if (!admins.has(socket.id)) return;
    if (typeof targetId !== "string") return;
    const reg = pending[targetId];
    const em = reg?.email || (targetId.startsWith("email:") ? targetId.slice(6) : null);
    if (reg) { delete pending[targetId]; io.to(targetId).emit("rejected"); }
    // Also clear any OTHER live pending socket for the same email (the person
    // may have reconnected under a new id since the admin's list rendered).
    if (em) {
      for (const [pid, p] of Object.entries(pending)) {
        if (p.email === em) { delete pending[pid]; io.to(pid).emit("rejected"); }
      }
      // Mark the row dismissed so the DB-backed pending list stops showing
      // them; actively coming back (register/sign-in/resume) clears the flag
      // and re-queues them for approval.
      try {
        await pool.query(
          `UPDATE jpo_players SET dismissed = true, updated_at = now() WHERE email = $1 AND approved = false`,
          [em],
        );
      } catch (err) { console.error("rejectPlayer dismiss failed:", err); }
    }
    _notifyAdmins();
    console.log(`Rejected: ${reg?.name || em || targetId}`);
  });

  // Kick = revoke approval. Because an approved email is auto-restored on its
  // next register, a session-only kick would be a no-op; flipping approved back
  // to false keeps them out until an admin re-approves.
  socket.on("kickPlayer", async (targetId) => {
    if (!admins.has(socket.id)) return;
    const p = players[targetId];
    if (!p) return;
    // kickPlayer never disconnects the target socket, so the disconnect-based
    // match cleanup would not fire — cancel their match explicitly.
    cancelMatchFor(targetId, "Match cancelled — no coins moved.");
    roundHandleLeave(targetId);
    delete players[targetId];
    io.to(targetId).emit("kicked");
    io.emit("playerLeft", targetId);
    if (p.email) {
      try {
        // dismissed = true keeps the revoked person OUT of the DB-backed
        // pending queue until they actively come back (which re-queues them).
        await pool.query(
          `UPDATE jpo_players SET approved = false, dismissed = true, updated_at = now() WHERE email = $1`,
          [p.email],
        );
      } catch (err) { console.error("kick revoke failed:", err); }
    }
    _notifyAdmins();
    console.log(`Kicked (revoked): ${p.name}`);
  });

  // Admin designates (or revokes) a player as an announcer — persisted on the
  // player row so it survives reconnects and restarts.
  socket.on("setAnnouncer", async (payload) => {
    const { targetId, canPost } = payload || {};
    if (!admins.has(socket.id)) return;
    const p = players[targetId];
    if (!p || !p.email) return;
    try {
      await pool.query(
        `UPDATE jpo_players SET is_announcer = $1, updated_at = now() WHERE email = $2`,
        [!!canPost, p.email],
      );
      p.isAnnouncer = !!canPost;
      io.to(targetId).emit("announcerStatus", { canPost: !!canPost });
      _notifyAdmins();
      console.log(`Announcer ${canPost ? "granted" : "revoked"}: ${p.name}`);
    } catch (err) { console.error("setAnnouncer failed:", err); }
  });

  // Admin clears an account's password (recovery for a forgotten password or a
  // wrongly-claimed legacy account). password_set_at = now() voids every resume
  // token issued before this moment, and any live session for the email is
  // dropped — so whoever held the account is fully signed out. The next
  // register with this email sets a fresh password (same claim rule as legacy).
  socket.on("adminResetPassword", async (payload) => {
    const { email } = payload || {};
    if (!admins.has(socket.id)) return;
    const em = (email || "").trim().slice(0, 80).toLowerCase();
    if (!em) { socket.emit("resetPasswordDone", { ok: false, message: "Email is required." }); return; }
    try {
      const { rows } = await pool.query(
        `UPDATE jpo_players
            SET password_hash = NULL, password_set_at = now(), updated_at = now()
          WHERE email = $1
          RETURNING name`,
        [em],
      );
      if (!rows[0]) {
        socket.emit("resetPasswordDone", { ok: false, message: "No account with that email." });
        return;
      }
      dropLiveByEmail(em, null);
      cancelGrace(em);
      _notifyAdmins();
      socket.emit("resetPasswordDone", { ok: true, message: `Password cleared for ${em}. They set a new one on their next Join.` });
      console.log(`Password reset by admin: <${em}>`);
    } catch (err) {
      console.error("adminResetPassword failed:", err);
      socket.emit("resetPasswordDone", { ok: false, message: "Something went wrong — try again." });
    }
  });

  // ── Game events ──────────────────────────────────────────────────────
  socket.on("playerMove", (data) => {
    const me = players[socket.id];
    if (!me || !data) return;

    // Throttle: cap how often we accept + rebroadcast movement. The client sends
    // ~20/s (every 50ms); anything faster than MOVE_MIN_INTERVAL_MS is a flood.
    // (Two legit 50ms-cadence sends can still arrive <33ms apart when TCP
    // bunches them — that's a by-design cosmetic drop, the next move corrects.)
    const now = Date.now();
    if (now - lastMoveAt < MOVE_MIN_INTERVAL_MS) { if (LT_METRICS) ltState.mvThr++; return; }

    // Coords must be finite — they're written to integer columns on the coin tick
    // / disconnect, so a NaN/Infinity would throw there every time.
    const x = Number(data.x), y = Number(data.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    // Reject out-of-bounds positions (a modified client can't leave the office).
    // Bounds come from the loaded map; a minimal epsilon absorbs the body offset /
    // edge rounding (a seat on the top row snaps to y ≈ -BODY_DY) — NOT a teleport.
    if (x < -MOVE_BOUNDS_EPSILON || x > WORLD_W + MOVE_BOUNDS_EPSILON ||
        y < -MOVE_BOUNDS_EPSILON || y > WORLD_H + MOVE_BOUNDS_EPSILON) return;

    // A sit<->stand "snap" teleports the avatar ~1 tile and flips anim to/from 'sit';
    // grant the extra distance only on that transition, cooldown-gated so it can't be
    // replayed every frame to fake fast movement.
    const sitting = data.anim === "sit";
    let snapBonus = 0;
    if (sitting !== wasSitting && now - lastSnapAt >= SEAT_SNAP_COOLDOWN_MS) {
      snapBonus = SEAT_SNAP_ALLOWANCE;
      lastSnapAt = now;
    }

    // Reject impossible jumps once we have a baseline. The FIRST move after
    // (re)joining just establishes position — the client spawns the local avatar
    // at a fixed point that may differ from the server's restored coords, so a
    // distance check there would falsely reject a legitimate spawn. Normal travel is
    // bounded to ~MOVE_SPEED (walk speed); only a real sit/stand adds snapBonus.
    if (lastMoveAt) {
      const elapsed = Math.min(now - lastMoveAt, MOVE_ELAPSED_CAP_MS) / 1000;
      // Coffee boost: while active the client legitimately walks at
      // SPEED × COFFEE_MULT, so the per-move budget must grow in lockstep or
      // every boosted step gets rejected. BOOST_GRACE_MS of slack past expiry
      // absorbs latency on the final boosted frames; after that the budget
      // snaps back to walk speed (expiry is authoritative here, server-side).
      // Office After Dark overrides (client speed logic MUST mirror this):
      // alive killers of the active round get their private edge, combined
      // with a live coffee boost by the LARGER of the two (never the product);
      // alive CREW clamp to base speed — even a legit pre-round boost timer
      // must not let them outrun the killers (the boost resumes after).
      const boosted = me.boostUntil && now < me.boostUntil + BOOST_GRACE_MS;
      let mult = boosted ? COFFEE_MULT : 1;
      if (round && round.state === "active") {
        const rm = round.members.get(socket.id);
        if (rm && rm.alive) {
          mult = round.killerIds.has(socket.id) ? Math.max(ROUND_KILLER_SPEED_MULT, mult) : 1;
        }
      }
      const speed = MOVE_SPEED * mult;
      const maxDist = speed * elapsed * MOVE_SPEED_TOLERANCE + MOVE_JITTER_PX + snapBonus;
      const dx = x - me.x, dy = y - me.y;
      if (dx * dx + dy * dy > maxDist * maxDist) { if (LT_METRICS) ltState.mvRej++; return; }   // teleport / speed hack (silently dropped)
    }

    me.x = x; me.y = y;
    if (typeof data.dir === "string") me.dir = data.dir;
    me.anim = data.anim;
    wasSitting = sitting;
    lastMoveAt = now;
    if (LT_METRICS) ltState.mvOk++;
    socket.broadcast.emit("playerMoved", { id: socket.id, ...me });
  });

  socket.on("chatMessage", (payload) => {
    const { message } = payload || {};
    if (!players[socket.id]) return;
    if (!takeToken(chatBucket)) return;   // throttle chat spam (silently drop)
    const text = (message || "").trim().slice(0, 120);
    if (!text) return;
    const msg = { id: socket.id, name: players[socket.id].name, message: text };
    // While Office After Dark is live, players in the dark hear ONLY each
    // other. A message from anyone lit up (outsiders, eliminated ghosts) is
    // delivered to everyone EXCEPT alive participants, so observers can't
    // call out positions to people still in the round.
    if (round && round.state === "active" && !inTheDark(socket.id)) {
      for (const id of Object.keys(players)) if (!inTheDark(id)) io.to(id).emit("chatMessage", msg);
    } else {
      io.emit("chatMessage", msg);
    }
  });

  // ── Emotes (ephemeral reaction bubbles, relayed to everyone) ─────────
  socket.on("emote", (payload) => {
    const { emote } = payload || {};
    if (!players[socket.id]) return;
    if (!takeToken(emoteBucket)) return;             // throttle emote spam (silently drop)
    if (typeof emote !== "string" || !EMOTES.has(emote)) return;
    io.emit("playerEmote", { id: socket.id, emote });
  });

  // ── Private whispers (DMs) — delivered ONLY to the target, echoed to sender ──
  // The client resolves the display name to a specific socket id via its online
  // roster (autocomplete), so name collisions are settled in the UI; the server
  // just validates the id is a live player. Shares chatBucket with public chat
  // so the combined message rate is what's limited. In-session only (no DB).
  socket.on("whisper", (payload) => {
    const { targetId, message } = payload || {};
    const sender = players[socket.id];
    if (!sender) return;
    if (!takeToken(chatBucket)) return;   // same throttle as public chat (shared bucket)
    const text = (typeof message === "string" ? message : "").trim().slice(0, 120);
    if (!text || typeof targetId !== "string") return;
    if (targetId === socket.id) {
      socket.emit("whisperFailed", { message: "You can't DM yourself." });
      return;
    }
    const target = players[targetId];
    if (!target) {
      socket.emit("whisperFailed", { message: "They're not in the office right now." });
      return;
    }
    // Same rule as public chat: nobody outside the dark can whisper someone
    // who's still in the round (position call-outs). Dark→dark is allowed.
    if (inTheDark(targetId) && !inTheDark(socket.id)) {
      socket.emit("whisperFailed", { message: "🌙 They're in the dark — wait until the round ends." });
      return;
    }
    io.to(targetId).emit("whisper", { fromId: socket.id, fromName: sender.name, message: text });
    socket.emit("whisperSent", { toId: targetId, toName: target.name, message: text });
  });

  // ── Player profiles ───────────────────────────────────────────────────
  // Lookups are by LIVE socket id (like whispers) — the profile card reads
  // from the in-memory state, which is DB-restored and kept current (coins
  // from RETURNING values, department from set-once below). The email lands
  // on other people's cards by design: this is an internal team office.
  socket.on("getProfile", (payload) => {
    const { targetId } = payload || {};
    if (!players[socket.id]) return;                 // must be in the office yourself
    if (!takeToken(profileBucket)) return;           // silently drop open-spam
    if (typeof targetId !== "string") return;
    const p = players[targetId];
    if (!p) {
      socket.emit("profileData", { ok: false, message: "They're not in the office right now." });
      return;
    }
    socket.emit("profileData", {
      ok: true,
      id:         targetId,
      self:       targetId === socket.id,
      name:       p.name,
      department: p.department || "",
      coins:      p.coins,
      equipped:   p.equipped || "",
      joinedAt:   p.createdAt || null,
    });
  });

  // Set-once department picker for legacy accounts (free, validated,
  // rate-limited). The WHERE clause makes it atomic: only an empty/legacy
  // department can be claimed, so a raced or replayed set can't overwrite.
  // Admins could re-clear the column later if ever needed — not built now.
  socket.on("setDepartment", async (payload) => {
    const { department } = payload || {};
    const me = players[socket.id];
    if (!me) return;
    if (!takeToken(profileBucket)) return;           // shares the profile throttle
    if (!DEPARTMENTS.includes(department)) return;   // forged/unknown value → drop
    if (!me.email) {
      // Session-only player: nothing durable to write; set in memory only.
      if (!me.department) {
        me.department = department;
        socket.emit("departmentSet", { department });
        _notifyAdmins();
      } else {
        socket.emit("profileError", { message: "Your department is already set." });
      }
      return;
    }
    try {
      const { rows } = await pool.query(
        `UPDATE jpo_players
            SET department = $2, updated_at = now()
          WHERE email = $1 AND department = ''
          RETURNING department`,
        [me.email, department],
      );
      if (!rows[0]) {
        socket.emit("profileError", { message: "Your department is already set." });
        return;
      }
      me.department = rows[0].department;
      socket.emit("departmentSet", { department: me.department });
      _notifyAdmins();
      console.log(`Department set: ${me.name} → ${me.department}`);
    } catch (err) {
      console.error("setDepartment failed:", err);
      socket.emit("profileError", { message: "Something went wrong — try again." });
    }
  });

  // ── Rock-paper-scissors challenges ───────────────────────────────────
  // Server-authoritative: the client only ever sends intents; validity (who's
  // live, busy, in range, can afford the wager), timing, pick secrecy, and the
  // coin transfer are all decided here. See the RPS section above io.on().
  socket.on("rpsChallenge", (payload) => {
    const { targetId, wager, game } = payload || {};
    const me = players[socket.id];
    if (!me) return;
    if (!takeToken(rpsBucket)) { socket.emit("rpsChallengeFailed", { message: "Slow down a moment." }); return; }
    // Omitted game = RPS (back-compat); anything else must be on the roster.
    const g = (game === undefined || game === null) ? "rps"
            : (typeof game === "string" && GAMES.has(game)) ? game : null;
    if (g === null) { socket.emit("rpsChallengeFailed", { message: "Unknown game." }); return; }
    const w = (Number.isInteger(wager) && wager >= 0 && wager <= RPS_WAGER_MAX) ? wager : null;
    if (w === null) { socket.emit("rpsChallengeFailed", { message: "Invalid wager." }); return; }
    if (typeof targetId !== "string" || targetId === socket.id) {
      socket.emit("rpsChallengeFailed", { message: "Pick someone to challenge." });
      return;
    }
    const target = players[targetId];
    if (!target) { socket.emit("rpsChallengeFailed", { message: "They're not in the office right now." }); return; }
    if (rpsBySocket.has(socket.id)) { socket.emit("rpsChallengeFailed", { message: "You're already in a challenge." }); return; }
    if (rpsBySocket.has(targetId)) { socket.emit("rpsChallengeFailed", { message: `${target.name} is busy in another match.` }); return; }
    // ANY round membership blocks duels — joining too, or a duel accepted
    // during the 30s lobby would still be running when the lights go out.
    if (inRound(socket.id)) { socket.emit("rpsChallengeFailed", { message: "No duels during Office After Dark!" }); return; }
    if (inRound(targetId)) { socket.emit("rpsChallengeFailed", { message: `${target.name} is playing Office After Dark.` }); return; }
    const dx = (me.x ?? 0) - (target.x ?? 0), dy = (me.y ?? 0) - (target.y ?? 0);
    if (dx * dx + dy * dy > RPS_RANGE_PX * RPS_RANGE_PX) {
      socket.emit("rpsChallengeFailed", { message: "Walk closer to challenge them." });
      return;
    }
    // Soft pre-check for instant feedback; the authoritative check re-runs at accept time.
    if (w > 0 && me.coins < w)     { socket.emit("rpsChallengeFailed", { message: "You don't have that many coins." }); return; }
    if (w > 0 && target.coins < w) { socket.emit("rpsChallengeFailed", { message: `${target.name} doesn't have that many coins.` }); return; }

    startRpsChallenge(socket.id, targetId, w, false, g);
  });

  socket.on("rpsRespond", (payload) => {
    const { challengeId, accept } = payload || {};
    const m = rpsBySocket.get(socket.id);
    // Stale/forged responses (wrong id, wrong role, already started) are dropped.
    if (!m || m.id !== challengeId || m.state !== "pending" || socket.id !== m.targetId) return;
    if (!accept) { cancelMatchFor(socket.id, "Challenge declined."); return; }
    const ch = players[m.challengerId], tg = players[m.targetId];
    if (!ch || !tg) { cancelMatchFor(socket.id, "Match cancelled — someone left."); return; }
    // Authoritative accept-time wager check for BOTH sides. Exact because a
    // player in a match can't spend (shop blocked) and the tick only adds.
    if (m.wager > 0 && (ch.coins < m.wager || tg.coins < m.wager)) {
      cancelMatchFor(socket.id, "Not enough coins on one side — match cancelled.");
      return;
    }
    clearTimeout(m.acceptTimer);
    const base = (oppId, oppName) => ({
      challengeId: m.id, game: m.game, opponentId: oppId, opponentName: oppName, wager: m.wager,
    });

    if (m.game === "ttt") {
      // Server-authoritative board; first mover is random and plays X.
      m.state = "playing";
      m.board = Array(9).fill(null);
      m.turn = Math.random() < 0.5 ? m.challengerId : m.targetId;
      m.marks = { [m.turn]: "X", [rpsOtherId(m, m.turn)]: "O" };
      m.moveTimer = setTimeout(() => tttTimeout(m), TTT_MOVE_MS);
      io.to(m.challengerId).emit("rpsStart", { ...base(m.targetId, tg.name),     yourMark: m.marks[m.challengerId], yourTurn: m.turn === m.challengerId, moveMs: TTT_MOVE_MS });
      io.to(m.targetId).emit("rpsStart",     { ...base(m.challengerId, ch.name), yourMark: m.marks[m.targetId],     yourTurn: m.turn === m.targetId,     moveMs: TTT_MOVE_MS });
      return;
    }

    if (m.game === "qd") {
      // Armed → (random 2–6s) → live signal → first tap wins. Tapping while
      // still armed is an instant loss (adjudicated in qdTap). If nobody taps
      // within QD_LIVE_MS of the signal, the match cancels with no coins moved.
      m.state = "playing";
      m.qdPhase = "armed";
      const armMs = QD_ARM_MIN_MS + Math.floor(Math.random() * (QD_ARM_MAX_MS - QD_ARM_MIN_MS + 1));
      m.signalTimer = setTimeout(() => {
        if (m.state !== "playing" || m.qdPhase !== "armed") return;  // re-check at fire time
        m.qdPhase = "live";
        m.qdSignalAt = Date.now();
        io.to(m.challengerId).emit("qdSignal", { challengeId: m.id });
        io.to(m.targetId).emit("qdSignal", { challengeId: m.id });
        m.liveTimer = setTimeout(() => {
          if (m.state !== "playing") return;
          cancelMatchFor(m.challengerId, "Nobody drew — match cancelled, no coins moved.");
        }, QD_LIVE_MS);
      }, armMs);
      io.to(m.challengerId).emit("rpsStart", { ...base(m.targetId, tg.name),     maxArmMs: QD_ARM_MAX_MS });
      io.to(m.targetId).emit("rpsStart",     { ...base(m.challengerId, ch.name), maxArmMs: QD_ARM_MAX_MS });
      return;
    }

    if (m.game === "ib") {
      // Best-of-3 either/or rounds; prompts drawn without repeats. Round flow
      // (ibRound → ibSubmit×2 → ibReveal → pause → next/settle) lives in the
      // ib helpers above io.on().
      m.state = "playing";
      m.ibRound = 1;
      m.ibScores = { [m.challengerId]: 0, [m.targetId]: 0 };
      m.ibSubs = {};
      const pool = IB_PROMPTS.slice();
      m.ibPrompts = [];
      for (let i = 0; i < IB_ROUNDS; i++) {
        m.ibPrompts.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
      }
      io.to(m.challengerId).emit("rpsStart", { ...base(m.targetId, tg.name),     rounds: IB_ROUNDS, submitMs: IB_SUBMIT_MS });
      io.to(m.targetId).emit("rpsStart",     { ...base(m.challengerId, ch.name), rounds: IB_ROUNDS, submitMs: IB_SUBMIT_MS });
      ibStartRound(m);
      return;
    }

    if (m.game === "trivia") {
      // Best-of-3 questions; fastest correct answer wins each round. Round
      // flow (trivRound → trivAnswer×2/timeout → trivReveal → pause →
      // next/settle) lives in the trivia helpers above io.on().
      m.state = "playing";
      m.trivRound = 1;
      m.trivSeq = 0;
      m.trivScores = { [m.challengerId]: 0, [m.targetId]: 0 };
      m.trivAns = {};
      const pool = TRIV_QS.slice();
      m.trivQs = [];
      for (let i = 0; i < TRIV_ROUNDS; i++) {
        m.trivQs.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
      }
      io.to(m.challengerId).emit("rpsStart", { ...base(m.targetId, tg.name),     rounds: TRIV_ROUNDS, answerMs: TRIV_ANSWER_MS });
      io.to(m.targetId).emit("rpsStart",     { ...base(m.challengerId, ch.name), rounds: TRIV_ROUNDS, answerMs: TRIV_ANSWER_MS });
      trivStartRound(m);
      return;
    }

    if (m.game === "c4") {
      // Server-authoritative 7×6 board; first mover is random and plays Red.
      m.state = "playing";
      m.board = Array(C4_COLS * C4_ROWS).fill(null);
      m.turn = Math.random() < 0.5 ? m.challengerId : m.targetId;
      m.discs = { [m.turn]: "R", [rpsOtherId(m, m.turn)]: "Y" };
      m.c4LastDrop = null;
      m.moveTimer = setTimeout(() => c4Timeout(m), C4_MOVE_MS);
      io.to(m.challengerId).emit("rpsStart", { ...base(m.targetId, tg.name),     yourDisc: m.discs[m.challengerId], yourTurn: m.turn === m.challengerId, moveMs: C4_MOVE_MS });
      io.to(m.targetId).emit("rpsStart",     { ...base(m.challengerId, ch.name), yourDisc: m.discs[m.targetId],     yourTurn: m.turn === m.targetId,     moveMs: C4_MOVE_MS });
      return;
    }

    if (m.game === "wr") {
      // One scramble, first correct unscramble wins; the word itself NEVER
      // leaves the server before game over (wrSubmit adjudicates).
      m.state = "playing";
      m.wrWord = WR_WORDS[Math.floor(Math.random() * WR_WORDS.length)];
      m.wrScrambled = wrScramble(m.wrWord);
      m.wrStartAt = Date.now();
      m.roundTimer = setTimeout(() => {
        if (m.state !== "playing" || m.game !== "wr") return;   // re-check at fire time
        finishMatch(m, { draw: true, extras: () => ({ word: m.wrWord, unsolved: true }) })
          .catch((err) => console.error("wr timeout resolve failed:", err));
      }, WR_TIME_MS);
      io.to(m.challengerId).emit("rpsStart", { ...base(m.targetId, tg.name),     scramble: m.wrScrambled, raceMs: WR_TIME_MS });
      io.to(m.targetId).emit("rpsStart",     { ...base(m.challengerId, ch.name), scramble: m.wrScrambled, raceMs: WR_TIME_MS });
      return;
    }

    m.state = "picking";
    m.pickTimer = setTimeout(() => { rpsResolve(m).catch((err) => console.error("rps resolve failed:", err)); }, RPS_PICK_MS);
    io.to(m.challengerId).emit("rpsStart", { ...base(m.targetId, tg.name),     pickMs: RPS_PICK_MS });
    io.to(m.targetId).emit("rpsStart",     { ...base(m.challengerId, ch.name), pickMs: RPS_PICK_MS });
  });

  socket.on("rpsPick", (payload) => {
    const { challengeId, pick } = payload || {};
    const m = rpsBySocket.get(socket.id);
    if (!m || m.id !== challengeId || m.game !== "rps" || m.state !== "picking") return;
    if (typeof pick !== "string" || !RPS_PICKS.has(pick)) return;
    if (m.picks[socket.id]) return;   // first pick locks — no take-backs
    m.picks[socket.id] = pick;
    // Only the FACT that they picked leaks to the opponent — never the pick itself.
    io.to(rpsOtherId(m, socket.id)).emit("rpsOpponentPicked", { challengeId: m.id });
    if (m.picks[m.challengerId] && m.picks[m.targetId]) {
      rpsResolve(m).catch((err) => console.error("rps resolve failed:", err));
    }
  });

  // Tic-Tac-Toe move intent. All board/turn validation is server-side; a bad
  // move is silently dropped (same policy as a bad rpsPick).
  socket.on("tttMove", (payload) => {
    const { challengeId, cell } = payload || {};
    const m = rpsBySocket.get(socket.id);
    if (!m || m.id !== challengeId || m.game !== "ttt" || m.state !== "playing") return;
    if (m.turn !== socket.id) return;
    if (!Number.isInteger(cell) || cell < 0 || cell > 8 || m.board[cell]) return;
    m.board[cell] = m.marks[socket.id];
    clearTimeout(m.moveTimer);
    const other = rpsOtherId(m, socket.id);
    const win = tttWinner(m.board);
    const full = m.board.every(Boolean);
    if (win || full) {
      tttBroadcast(m);   // both sides see the final move land before the result card
      finishMatch(m, win
        ? { winnerId: socket.id, loserId: other, extras: tttExtras(m) }
        : { draw: true, extras: tttExtras(m) },
      ).catch((err) => console.error("ttt resolve failed:", err));
      return;
    }
    m.turn = other;
    m.moveTimer = setTimeout(() => tttTimeout(m), TTT_MOVE_MS);
    tttBroadcast(m);
  });

  // Quick Draw tap intent. Armed phase → tapper loses instantly (fired
  // early); live phase → first tap wins. finishMatch's synchronous settling
  // flip makes any second tap a no-op.
  socket.on("qdTap", (payload) => {
    const { challengeId } = payload || {};
    const m = rpsBySocket.get(socket.id);
    if (!m || m.id !== challengeId || m.game !== "qd" || m.state !== "playing") return;
    const other = rpsOtherId(m, socket.id);
    if (m.qdPhase === "armed") {
      finishMatch(m, {
        winnerId: other, loserId: socket.id, forfeit: true,
        extras: (me) => ({ early: true, youFiredEarly: me === socket.id }),
      }).catch((err) => console.error("qd resolve failed:", err));
    } else if (m.qdPhase === "live") {
      const reactionMs = Date.now() - m.qdSignalAt;
      finishMatch(m, {
        winnerId: socket.id, loserId: other,
        extras: () => ({ reactionMs }),
      }).catch((err) => console.error("qd resolve failed:", err));
    }
  });

  // Icebreakers submit intent: your own answer + your guess of theirs, both
  // 'a' | 'b'. First submit locks (like rpsPick); only the FACT of the lock
  // leaks to the opponent — answers stay secret until BOTH are in.
  socket.on("ibSubmit", (payload) => {
    const { challengeId, answer, guess } = payload || {};
    const m = rpsBySocket.get(socket.id);
    if (!m || m.id !== challengeId || m.game !== "ib" || m.state !== "playing" || m.ibPhase !== "answer") return;
    if (!IB_CHOICES.has(answer) || !IB_CHOICES.has(guess)) return;
    if (m.ibSubs[socket.id]) return;   // first submit locks — no take-backs
    m.ibSubs[socket.id] = { answer, guess };
    io.to(rpsOtherId(m, socket.id)).emit("ibPeerLocked", { challengeId: m.id });
    if (m.ibSubs[m.challengerId] && m.ibSubs[m.targetId]) ibReveal(m);
  });

  // Trivia answer intent: choice is an option index 0-3. First answer locks
  // (like rpsPick); only the FACT of the lock leaks to the opponent — the
  // pick and its correctness stay secret until the reveal. Arrival order
  // (trivSeq) adjudicates "fastest correct" — never client timestamps.
  socket.on("trivAnswer", (payload) => {
    const { challengeId, choice } = payload || {};
    const m = rpsBySocket.get(socket.id);
    if (!m || m.id !== challengeId || m.game !== "trivia" || m.state !== "playing" || m.trivPhase !== "answer") return;
    if (!Number.isInteger(choice) || choice < 0 || choice > 3) return;
    if (m.trivAns[socket.id]) return;   // first answer locks — no take-backs
    m.trivAns[socket.id] = { choice, seq: m.trivSeq++, at: Date.now() - (m.trivRoundStartAt || Date.now()) };
    io.to(rpsOtherId(m, socket.id)).emit("trivPeerLocked", { challengeId: m.id });
    if (m.trivAns[m.challengerId] && m.trivAns[m.targetId]) trivReveal(m);
  });

  // Connect Four drop intent. All board/turn validation is server-side; a bad
  // move is silently dropped (same policy as tttMove).
  socket.on("c4Drop", (payload) => {
    const { challengeId, col } = payload || {};
    const m = rpsBySocket.get(socket.id);
    if (!m || m.id !== challengeId || m.game !== "c4" || m.state !== "playing") return;
    if (m.turn !== socket.id) return;
    if (!Number.isInteger(col) || col < 0 || col >= C4_COLS) return;
    // Find the lowest empty row in that column (row C4_ROWS-1 = bottom).
    let row = -1;
    for (let r = C4_ROWS - 1; r >= 0; r--) {
      if (!m.board[r * C4_COLS + col]) { row = r; break; }
    }
    if (row === -1) return;   // column full
    const idx = row * C4_COLS + col;
    m.board[idx] = m.discs[socket.id];
    m.c4LastDrop = idx;
    clearTimeout(m.moveTimer);
    const other = rpsOtherId(m, socket.id);
    const win = c4Winner(m.board, idx);
    const full = m.board.every(Boolean);
    if (win || full) {
      c4Broadcast(m);   // both sides see the final disc land before the result card
      finishMatch(m, win
        ? { winnerId: socket.id, loserId: other, extras: c4Extras(m) }
        : { draw: true, extras: c4Extras(m) },
      ).catch((err) => console.error("c4 resolve failed:", err));
      return;
    }
    m.turn = other;
    m.moveTimer = setTimeout(() => c4Timeout(m), C4_MOVE_MS);
    c4Broadcast(m);
  });

  // Word Race guess intent. Server-side compare only (the client never knows
  // the word); wrong guesses get a private wrWrong so the input can shake —
  // no lockout, but bucketed so a spamming client is just silently dropped.
  socket.on("wrSubmit", (payload) => {
    const { challengeId, word } = payload || {};
    const m = rpsBySocket.get(socket.id);
    if (!m || m.id !== challengeId || m.game !== "wr" || m.state !== "playing") return;
    if (!takeToken(wrBucket)) return;   // throttle = drop, never disconnect
    if (typeof word !== "string" || word.length > 32) return;
    const attempt = word.toUpperCase().replace(/[^A-Z]/g, "");
    if (!attempt) return;
    if (attempt === m.wrWord) {
      const solveMs = Date.now() - m.wrStartAt;
      finishMatch(m, {
        winnerId: socket.id, loserId: rpsOtherId(m, socket.id),
        extras: (me) => ({ word: m.wrWord, solveMs, youSolved: me === socket.id }),
      }).catch((err) => console.error("wr resolve failed:", err));
    } else {
      socket.emit("wrWrong", { challengeId: m.id });
    }
  });

  // Challenger withdraws a not-yet-answered challenge.
  socket.on("rpsCancel", (payload) => {
    const { challengeId } = payload || {};
    const m = rpsBySocket.get(socket.id);
    if (!m || m.id !== challengeId || m.state !== "pending" || socket.id !== m.challengerId) return;
    cancelMatchFor(socket.id, "Challenge withdrawn.");
  });

  // ── Announcements (admin / designated announcers post, broadcast to all) ──
  socket.on("postAnnouncement", async (payload) => {
    const { text, board } = payload || {};
    const p = players[socket.id];
    const canPost = admins.has(socket.id) || !!(p && p.isAnnouncer);
    if (!canPost) return;
    if (!takeToken(postBucket)) return;   // throttle announcement spam
    const clean = (text || "").trim().slice(0, 280);
    if (!clean) return;
    // Which individual board this belongs to (the client posts from the board it's standing at).
    const boardId = (board || "").toString().trim().slice(0, 40) || "office";
    const name = p?.name || "Admin";
    try {
      await pool.query(
        `INSERT INTO jpo_announcements (name, text, board) VALUES ($1,$2,$3)`,
        [name, clean, boardId],
      );
      io.emit("announcementsUpdate", await fetchAnnouncements());
      console.log(`Announcement by ${name} [${boardId}]: ${clean.slice(0, 40)}`);
    } catch (err) { console.error("postAnnouncement failed:", err); }
  });

  socket.on("deleteAnnouncement", async (payload) => {
    const { id } = payload || {};
    if (!admins.has(socket.id)) return;
    const numId = parseInt(id, 10);
    if (!Number.isInteger(numId)) return;
    try {
      await pool.query(`DELETE FROM jpo_announcements WHERE id = $1`, [numId]);
      io.emit("announcementsUpdate", await fetchAnnouncements());
    } catch (err) { console.error("deleteAnnouncement failed:", err); }
  });

  socket.on("buyCosmetic", async (payload) => {
    const { item } = payload || {};
    const p = players[socket.id], cost = SHOP[item];
    if (!p || !cost) return;
    if (!takeToken(buyBucket)) return;   // throttle rapid buy attempts
    // No spending while in an RPS challenge/match: this is what keeps the
    // accept-time wager check exact all the way to settlement (the coin tick
    // only ever ADDS coins).
    if (rpsBySocket.has(socket.id)) { socket.emit("shopError", "Finish your match first!"); return; }
    if (inActiveRound(socket.id)) { socket.emit("shopError", "The lights are out — no shopping until the round ends!"); return; }

    // Session-only players (no email): memory-only purchase.
    if (!p.email) {
      if (p.cosmetics.includes(item)) { socket.emit("shopError", "Already owned!"); return; }
      if (p.coins < cost) { socket.emit("shopError", "Not enough coins!"); return; }
      p.coins -= cost;
      p.cosmetics.push(item);
      p.equipped = item;   // buying auto-equips
      socket.emit("coinUpdate",  { coins: p.coins });
      socket.emit("shopSuccess", { item, equipped: p.equipped });
      io.emit("playerCosmeticUpdate", { id: socket.id, cosmetics: p.cosmetics, equipped: p.equipped });
      console.log(`${p.name} bought ${item} (session-only)`);
      return;
    }

    try {
      // One atomic statement guards both "enough coins" and "not already owned",
      // so a coin tick or a double-click can't produce an inconsistent balance.
      // Buying auto-equips the new item (players can switch afterwards for free).
      const { rows } = await pool.query(
        `UPDATE jpo_players
            SET coins = coins - $2,
                cosmetics = array_append(cosmetics, $3),
                equipped_cosmetic = $3,
                updated_at = now()
          WHERE email = $1 AND coins >= $2 AND NOT ($3 = ANY(cosmetics))
          RETURNING coins, cosmetics, equipped_cosmetic`,
        [p.email, cost, item],
      );
      if (rows.length === 0) {
        if (p.cosmetics.includes(item)) socket.emit("shopError", "Already owned!");
        else socket.emit("shopError", "Not enough coins!");
        return;
      }
      p.coins = rows[0].coins;
      p.cosmetics = rows[0].cosmetics || [];
      p.equipped = rows[0].equipped_cosmetic || "";
      socket.emit("coinUpdate",  { coins: p.coins });
      socket.emit("shopSuccess", { item, equipped: p.equipped });
      io.emit("playerCosmeticUpdate", { id: socket.id, cosmetics: p.cosmetics, equipped: p.equipped });
      console.log(`${p.name} bought ${item}`);
    } catch (err) { console.error("buyCosmetic failed:", err); }
  });

  // ── Cafeteria kitchen: buy a specific item off a station's menu ──────────
  // Mirrors buyCosmetic: bucket first, the same wager-invariant blocks, price
  // from the SERVER's menu table only, and one atomic conditional UPDATE for
  // DB players (a coin tick or double-click can't overdraw). Proximity is
  // re-checked at buy time — the menu panel can be left open while walking
  // away. Paid food never reads or writes fridgeReadyAt (see FOOD_MENUS).
  socket.on("buyFood", async (payload) => {
    const { station, item } = payload || {};
    const p = players[socket.id];
    if (!p) return;
    if (!takeToken(buyBucket)) return;   // shares the shop's buy-spam throttle
    if (typeof station !== "string" || typeof item !== "string") return;
    // hasOwn so "__proto__"/"constructor" can't match (same as interact).
    if (!Object.hasOwn(FOOD_STATIONS, station)) return;
    if (rpsBySocket.has(socket.id)) { socket.emit("foodError", { message: "Finish your match first!" }); return; }
    if (inActiveRound(socket.id)) { socket.emit("foodError", { message: "The lights are out — no snacking until the round ends!" }); return; }
    const obj = OBJECTS[station];
    const dx = (p.x ?? 0) - obj.x, dy = (p.y ?? 0) - obj.y;
    if (dx * dx + dy * dy > obj.r * obj.r) {
      socket.emit("foodError", { message: "Walk back to the counter to order." });
      return;
    }
    const menuItem = FOOD_MENUS[FOOD_STATIONS[station]].items.find((it) => it.id === item);
    if (!menuItem) return;

    if (!p.email) {
      // Session-only players (no email): memory-only purchase.
      if ((p.coins ?? 0) < menuItem.price) { socket.emit("foodError", { message: "Not enough coins!" }); return; }
      p.coins -= menuItem.price;
    } else {
      try {
        const { rows } = await pool.query(
          `UPDATE jpo_players SET coins = coins - $2, updated_at = now()
            WHERE email = $1 AND coins >= $2 RETURNING coins`,
          [p.email, menuItem.price],
        );
        if (rows.length === 0) { socket.emit("foodError", { message: "Not enough coins!" }); return; }
        p.coins = rows[0].coins;   // keep the cached balance honest (wager caps read it)
      } catch (err) { console.error("buyFood failed:", err); return; }
    }
    socket.emit("coinUpdate", { coins: p.coins });
    socket.emit("foodBought", { station, item: menuItem.id, name: menuItem.name, icon: menuItem.icon, price: menuItem.price, coins: p.coins });
    // Everyone nearby sees the food bubble — same event the free snacks use.
    io.emit("objectEffect", { id: socket.id, kind: "snack", emoji: menuItem.icon });
    console.log(`${p.name} bought ${menuItem.name} (${menuItem.price} coins) at ${station}`);
  });

  // ── Cosmetics: switch which owned item is worn ('' = take it off) ────────
  // Free (no coin movement), so it is NOT blocked mid-match and doesn't touch
  // the wager invariant. Ownership is enforced in the same statement that
  // writes the choice, so a never-owned id can't be equipped.
  socket.on("equipCosmetic", async (payload) => {
    const raw = (payload || {}).item;
    const item = typeof raw === "string" ? raw : null;
    const p = players[socket.id];
    if (!p || item === null) return;
    if (item !== "" && !SHOP[item]) return;          // unknown cosmetic id
    if (!takeToken(buyBucket)) return;               // shares the shop's spam throttle
    if (p.equipped === item) return;                 // no-op

    if (!p.email) {
      if (item !== "" && !p.cosmetics.includes(item)) { socket.emit("shopError", "You don't own that!"); return; }
      p.equipped = item;
      socket.emit("equipUpdate", { equipped: p.equipped });
      io.emit("playerCosmeticUpdate", { id: socket.id, cosmetics: p.cosmetics, equipped: p.equipped });
      return;
    }

    try {
      const { rows } = await pool.query(
        `UPDATE jpo_players
            SET equipped_cosmetic = $2, updated_at = now()
          WHERE email = $1 AND ($2 = '' OR $2 = ANY(cosmetics))
          RETURNING equipped_cosmetic`,
        [p.email, item],
      );
      if (rows.length === 0) { socket.emit("shopError", "You don't own that!"); return; }
      p.equipped = rows[0].equipped_cosmetic || "";
      socket.emit("equipUpdate", { equipped: p.equipped });
      io.emit("playerCosmeticUpdate", { id: socket.id, cosmetics: p.cosmetics, equipped: p.equipped });
    } catch (err) { console.error("equipCosmetic failed:", err); }
  });

  // ── Pets: buy a companion (auto-adopts it) ───────────────────────────────
  // Mirrors buyCosmetic exactly: same throttle, same mid-match block (coins
  // move), and the same one-statement atomicity — the coins guard, the
  // "not already owned" guard, the ownership append (into the shared
  // cosmetics array) and the auto-equip into equipped_pet all commit together.
  socket.on("buyPet", async (payload) => {
    const { item } = payload || {};
    const p = players[socket.id], cost = PETS[item];
    if (!p || !cost) return;
    if (!takeToken(buyBucket)) return;   // shares the shop's spam throttle
    if (rpsBySocket.has(socket.id)) { socket.emit("shopError", "Finish your match first!"); return; }
    if (inActiveRound(socket.id)) { socket.emit("shopError", "The lights are out — no shopping until the round ends!"); return; }

    // Session-only players (no email): memory-only purchase.
    if (!p.email) {
      if (p.cosmetics.includes(item)) { socket.emit("shopError", "Already adopted!"); return; }
      if (p.coins < cost) { socket.emit("shopError", "Not enough coins!"); return; }
      p.coins -= cost;
      p.cosmetics.push(item);
      p.pet = item;   // buying auto-adopts
      socket.emit("coinUpdate", { coins: p.coins });
      socket.emit("petSuccess", { item, pet: p.pet });
      io.emit("playerPetUpdate", { id: socket.id, pet: p.pet });
      console.log(`${p.name} adopted ${item} (session-only)`);
      return;
    }

    try {
      const { rows } = await pool.query(
        `UPDATE jpo_players
            SET coins = coins - $2,
                cosmetics = array_append(cosmetics, $3),
                equipped_pet = $3,
                updated_at = now()
          WHERE email = $1 AND coins >= $2 AND NOT ($3 = ANY(cosmetics))
          RETURNING coins, cosmetics, equipped_pet`,
        [p.email, cost, item],
      );
      if (rows.length === 0) {
        if (p.cosmetics.includes(item)) socket.emit("shopError", "Already adopted!");
        else socket.emit("shopError", "Not enough coins!");
        return;
      }
      p.coins = rows[0].coins;
      p.cosmetics = rows[0].cosmetics || [];
      p.pet = rows[0].equipped_pet || "";
      socket.emit("coinUpdate", { coins: p.coins });
      socket.emit("petSuccess", { item, pet: p.pet });
      io.emit("playerPetUpdate", { id: socket.id, pet: p.pet });
      console.log(`${p.name} adopted ${item}`);
    } catch (err) { console.error("buyPet failed:", err); }
  });

  // ── Pets: switch which owned pet follows you ('' = send it home) ─────────
  // Free (no coin movement), so like equipCosmetic it is NOT blocked
  // mid-match. Ownership is enforced inside the UPDATE's WHERE clause, so a
  // never-adopted pet id can't be activated.
  socket.on("equipPet", async (payload) => {
    const raw = (payload || {}).item;
    const item = typeof raw === "string" ? raw : null;
    const p = players[socket.id];
    if (!p || item === null) return;
    if (item !== "" && !PETS[item]) return;          // unknown pet id
    if (!takeToken(buyBucket)) return;               // shares the shop's spam throttle
    if ((p.pet || "") === item) return;              // no-op

    if (!p.email) {
      if (item !== "" && !p.cosmetics.includes(item)) { socket.emit("shopError", "You don't own that!"); return; }
      p.pet = item;
      socket.emit("petUpdate", { pet: p.pet });
      io.emit("playerPetUpdate", { id: socket.id, pet: p.pet });
      return;
    }

    try {
      const { rows } = await pool.query(
        `UPDATE jpo_players
            SET equipped_pet = $2, updated_at = now()
          WHERE email = $1 AND ($2 = '' OR $2 = ANY(cosmetics))
          RETURNING equipped_pet`,
        [p.email, item],
      );
      if (rows.length === 0) { socket.emit("shopError", "You don't own that!"); return; }
      p.pet = rows[0].equipped_pet || "";
      socket.emit("petUpdate", { pet: p.pet });
      io.emit("playerPetUpdate", { id: socket.id, pet: p.pet });
    } catch (err) { console.error("equipPet failed:", err); }
  });

  // ── Wardrobe: pay to change shirt/trouser colours ────────────────────────
  // One flat WARDROBE_PRICE per change (either or both colours in the same
  // purchase). Same money rules as buyCosmetic: atomic coins-guard SQL for
  // email-backed players, blocked mid-match (it spends coins), shares the
  // buy-spam throttle. Invalid indexes are rejected outright (NOT clamped —
  // clamping would silently charge for a colour the buyer didn't pick).
  // Picking exactly the colours already worn is a no-op and charges nothing.
  socket.on("changeOutfit", async (payload) => {
    const { shirtIdx, pantsIdx } = payload || {};
    const p = players[socket.id];
    if (!p) return;
    if (!Number.isInteger(shirtIdx) || shirtIdx < 0 || shirtIdx > CLOTH_MAX) return;
    if (!Number.isInteger(pantsIdx) || pantsIdx < 0 || pantsIdx > CLOTH_MAX) return;
    if (!takeToken(buyBucket)) return;   // shares the shop's buy-spam throttle
    if (rpsBySocket.has(socket.id)) { socket.emit("shopError", "Finish your match first!"); return; }
    if (inActiveRound(socket.id)) { socket.emit("shopError", "The lights are out — no shopping until the round ends!"); return; }
    if (shirtIdx === p.shirtIdx && pantsIdx === p.pantsIdx) {
      socket.emit("shopError", "You're already wearing those colours!");
      return;
    }

    // Session-only players (no email): memory-only change.
    if (!p.email) {
      if (p.coins < WARDROBE_PRICE) { socket.emit("shopError", "Not enough coins!"); return; }
      p.coins -= WARDROBE_PRICE;
      p.shirtIdx = shirtIdx;
      p.pantsIdx = pantsIdx;
      socket.emit("coinUpdate",    { coins: p.coins });
      socket.emit("outfitSuccess", { shirtIdx, pantsIdx });
      io.emit("playerOutfitUpdate", {
        id: socket.id, character: p.character,
        hairIdx: p.hairIdx, skinIdx: p.skinIdx, shirtIdx, pantsIdx,
      });
      console.log(`${p.name} changed outfit (session-only)`);
      return;
    }

    try {
      const { rows } = await pool.query(
        `UPDATE jpo_players
            SET coins = coins - $2, shirt_idx = $3, pants_idx = $4, updated_at = now()
          WHERE email = $1 AND coins >= $2
          RETURNING coins, shirt_idx, pants_idx`,
        [p.email, WARDROBE_PRICE, shirtIdx, pantsIdx],
      );
      if (rows.length === 0) { socket.emit("shopError", "Not enough coins!"); return; }
      p.coins    = rows[0].coins;
      p.shirtIdx = rows[0].shirt_idx;
      p.pantsIdx = rows[0].pants_idx;
      socket.emit("coinUpdate",    { coins: p.coins });
      socket.emit("outfitSuccess", { shirtIdx: p.shirtIdx, pantsIdx: p.pantsIdx });
      io.emit("playerOutfitUpdate", {
        id: socket.id, character: p.character,
        hairIdx: p.hairIdx, skinIdx: p.skinIdx,
        shirtIdx: p.shirtIdx, pantsIdx: p.pantsIdx,
      });
      console.log(`${p.name} changed outfit (shirt ${p.shirtIdx}, pants ${p.pantsIdx})`);
    } catch (err) { console.error("changeOutfit failed:", err); }
  });

  // ── Usable items: buy ────────────────────────────────────────────────
  // Adds a pack of `uses` to the player's item balance. Same money rules as
  // buyCosmetic: atomic coins-guard SQL for email-backed players, and NO
  // spending while in an RPS match (that invariant is what keeps the RPS
  // accept-time wager check exact through settlement).
  socket.on("buyUsable", async (payload) => {
    const { item } = payload || {};
    const p = players[socket.id], def = USABLE_ITEMS[item];
    if (!p || !def) return;
    if (!takeToken(buyBucket)) return;   // shares the shop's buy-spam throttle
    if (rpsBySocket.has(socket.id)) { socket.emit("shopError", "Finish your match first!"); return; }
    if (inActiveRound(socket.id)) { socket.emit("shopError", "The lights are out — no shopping until the round ends!"); return; }

    // Session-only players (no email): memory-only purchase.
    if (!p.email) {
      if ((p.coins || 0) < def.cost) { socket.emit("shopError", "Not enough coins!"); return; }
      p.coins -= def.cost;
      p.items = p.items || {};
      p.items[item] = (p.items[item] || 0) + def.uses;
      socket.emit("coinUpdate", { coins: p.coins });
      socket.emit("usableBought", { item, items: p.items });
      console.log(`${p.name} bought ${item} ×${def.uses} (session-only)`);
      return;
    }

    try {
      // Atomic: the coins guard and the jsonb counter bump happen in one
      // statement, so a concurrent coin tick / double-click can't overspend.
      const { rows } = await pool.query(
        `UPDATE jpo_players
            SET coins = coins - $2,
                items = jsonb_set(COALESCE(items, '{}'::jsonb), ARRAY[$3::text],
                                  to_jsonb(COALESCE((items->>$3)::int, 0) + $4::int), true),
                updated_at = now()
          WHERE email = $1 AND coins >= $2
          RETURNING coins, items`,
        [p.email, def.cost, item, def.uses],
      );
      if (rows.length === 0) { socket.emit("shopError", "Not enough coins!"); return; }
      p.coins = rows[0].coins;
      p.items = rows[0].items || {};
      socket.emit("coinUpdate", { coins: p.coins });
      socket.emit("usableBought", { item, items: p.items });
      console.log(`${p.name} bought ${item} ×${def.uses}`);
    } catch (err) { console.error("buyUsable failed:", err); }
  });

  // ── Usable items: use ────────────────────────────────────────────────
  // Consumes one use (SQL-first decrement with a remaining>0 guard, so two
  // sessions racing the same account can't double-spend the last use) and then
  // applies the effect. Item use is allowed mid-RPS — it spends ITEMS, not
  // coins, so the wager invariant is untouched.
  socket.on("useItem", async (payload) => {
    const { item } = payload || {};
    const p = players[socket.id];
    if (!p || !USABLE_ITEMS[item]) return;
    if (!takeToken(itemBucket)) return;   // silently drop use-spam
    const now = Date.now();

    // Effect gates BEFORE consuming, so a rejected use never wastes a charge.
    // Office After Dark lockout: alive participants of the active round can't
    // gain speed boosts — a crew coffee would erase the killers' edge, and a
    // killer's group round would boost the crew around them. The message is
    // IDENTICAL for crew and killers so a refusal can never out anyone.
    if (BOOST_ITEMS.has(item) && inTheDark(socket.id)) {
      socket.emit("itemError", { message: "🌙 Too dark to brew — no boosts until the lights come back on!" });
      return;
    }
    if (item === "cigarette") {
      if (p.smokeUntil && now < p.smokeUntil) {
        socket.emit("itemError", { message: "You're already smoking!" });
        return;
      }
      if (!isOutdoors(p.x ?? 0, p.y ?? 0)) {
        socket.emit("itemError", { message: "No smoking inside! Head out to the grass. 🌿" });
        return;
      }
    } else if (item === "coffee") {
      if (p.boostUntil && now < p.boostUntil) {
        socket.emit("itemError", { message: "You're already buzzing from the last cup!" });
        return;
      }
    }

    // Consume one use.
    if (!p.email) {
      const have = (p.items && p.items[item]) || 0;
      if (have <= 0) { socket.emit("itemError", { message: "You don't have any — grab one in the shop." }); return; }
      p.items[item] = have - 1;
    } else {
      try {
        const { rows } = await pool.query(
          `UPDATE jpo_players
              SET items = jsonb_set(items, ARRAY[$2::text], to_jsonb((items->>$2)::int - 1)),
                  updated_at = now()
            WHERE email = $1 AND COALESCE((items->>$2)::int, 0) > 0
            RETURNING items`,
          [p.email, item],
        );
        if (rows.length === 0) {
          socket.emit("itemError", { message: "You don't have any — grab one in the shop." });
          return;
        }
        p.items = rows[0].items || {};
      } catch (err) { console.error("useItem failed:", err); return; }
    }
    socket.emit("itemsUpdate", { items: p.items });

    // Apply the effect. Timers live only in memory (p.smokeUntil/p.boostUntil):
    // a refresh drops the visual/boost but the charge was spent — accepted, the
    // durations are short and this keeps restore logic untouched.
    if (item === "cigarette") {
      p.smokeUntil = now + SMOKE_MS;
      io.emit("smokeStart", { id: socket.id, durationMs: SMOKE_MS });
      console.log(`${p.name} lit a cigarette (${(p.items && p.items.cigarette) || 0} left)`);
    } else if (item === "coffee") {
      p.boostUntil = now + COFFEE_MS;
      io.emit("coffeeBoost", { id: socket.id, durationMs: COFFEE_MS, mult: COFFEE_MULT });
      console.log(`${p.name} drank a coffee (+${Math.round((COFFEE_MULT - 1) * 100)}% for ${COFFEE_MS / 1000}s)`);
    } else if (item === "coffee_round" || item === "pizza_party") {
      // Group boost: everyone within GROUP_RADIUS (including the buyer) gets
      // the same speed boost. boostUntil only ever EXTENDS (max), so a short
      // boost can never clip a longer one already running server-side; the
      // client just takes the latest event's duration, which can only make it
      // walk slower than the server allows — the safe direction.
      const dur = item === "pizza_party" ? PIZZA_MS : COFFEE_MS;
      const emoji = item === "pizza_party" ? "🍕" : "☕";
      // Players in the dark (alive members of the active round) never receive
      // group boosts — an outsider's coffee round must not speed up the crew
      // (or hand a killer a boost bubble that outs them). Ghosts and everyone
      // else nearby are boosted normally. The user can't be in the dark here
      // (blocked by the gate above), so self stays included.
      const ids = nearbyIds(socket.id, GROUP_RADIUS).filter((rid) => !inTheDark(rid));
      for (const rid of ids) {
        const q = players[rid];
        if (!q) continue;
        q.boostUntil = Math.max(q.boostUntil || 0, now + dur);
        io.emit("coffeeBoost", { id: rid, durationMs: dur, mult: COFFEE_MULT, emoji });
      }
      if (item === "pizza_party")
        io.emit("groupEffect", { effect: "pizza", x: p.x ?? 0, y: p.y ?? 0 });
      console.log(`${p.name} used ${item} — boosted ${ids.length} player(s) for ${dur / 1000}s`);
    } else if (item === "confetti" || item === "fireworks") {
      // Pure visuals, broadcast like smoke puffs (everyone can see the show).
      io.emit("groupEffect", { effect: item, x: p.x ?? 0, y: p.y ?? 0 });
      console.log(`${p.name} set off ${item}`);
    }
  });

  // ── Interactive office objects ───────────────────────────────────────
  // Coffee machine (free boost, long refill), water cooler (flavor text),
  // arcade (starts a friendly RPS match with whoever else is standing there).
  // The bucket is consumed BEFORE any validation, like every other handler.
  socket.on("interact", (payload) => {
    const { object, game } = payload || {};
    const p = players[socket.id];
    if (!p) return;
    if (!takeToken(interactBucket)) return;   // silently drop spam
    // hasOwn (not a bare lookup) so "__proto__"/"constructor" can't match.
    if (typeof object !== "string" || !Object.hasOwn(OBJECTS, object)) return;
    const obj = OBJECTS[object];
    const dx = (p.x ?? 0) - obj.x, dy = (p.y ?? 0) - obj.y;
    if (dx * dx + dy * dy > obj.r * obj.r) {
      socket.emit("interactError", { message: "Walk a little closer." });
      return;
    }
    const now = Date.now();

    if (object.startsWith("coffee_machine")) {
      // ALL machines share ONE per-person refill cooldown (coffeeMachineReadyAt
      // is keyed by email only) — more stations are a convenience, not a way to
      // multiply the free-coffee rate.
      // Same After Dark lockout as boost ITEMS (and the same message for crew
      // and killers) — and it runs BEFORE the refill cooldown is spent, so a
      // refused brew never burns the machine.
      if (inTheDark(socket.id)) {
        socket.emit("interactError", { message: "🌙 Too dark to brew — no boosts until the lights come back on!" });
        return;
      }
      if (p.boostUntil && now < p.boostUntil) {
        socket.emit("interactError", { message: "You're already buzzing from the last cup!" });
        return;
      }
      const key = p.email || socket.id;
      const readyAt = coffeeMachineReadyAt.get(key) || 0;
      if (now < readyAt) {
        const mins = Math.ceil((readyAt - now) / 60_000);
        socket.emit("interactError", { message: `The machine is still refilling — about ${mins} min. (The shop sells instant cups!)` });
        return;
      }
      pruneCooldowns(coffeeMachineReadyAt, now);
      coffeeMachineReadyAt.set(key, now + COFFEE_MACHINE_COOLDOWN_MS);
      p.boostUntil = now + COFFEE_MS;
      // `machine` tells every client WHICH machine to play the brew animation
      // at (pure flavor — clients ignore unknown ids). Item/round coffees omit
      // it, so only real machine brews animate the hardware.
      io.emit("coffeeBoost", { id: socket.id, durationMs: COFFEE_MS, mult: COFFEE_MULT, machine: object });
      console.log(`${p.name} brewed a free coffee at the machine`);

    } else if (object === "water_cooler") {
      const key = p.email || socket.id;
      if (now < (waterReadyAt.get(key) || 0)) return;   // just sipped — quietly ignore
      pruneCooldowns(waterReadyAt, now);
      waterReadyAt.set(key, now + WATER_COOLDOWN_MS);
      const line = WATER_LINES[waterLineIdx++ % WATER_LINES.length];
      socket.emit("waterCooler", { line });
      io.emit("objectEffect", { id: socket.id, kind: "water" });

    } else if (Object.hasOwn(FOOD_STATIONS, object)) {
      // Cafeteria kitchen stations: browsing is FREE (interactBucket is the
      // only throttle) — just send the station's menu. The purchase happens in
      // buyFood, which re-validates everything. Prices ride along so the
      // client never hardcodes them. This branch MUST stay above the
      // FOOD_OBJECT_IDS one (fridge/kitchen_island used to live there).
      const menu = FOOD_MENUS[FOOD_STATIONS[object]];
      socket.emit("foodMenu", { station: object, title: menu.title, items: menu.items, coins: p.coins ?? 0 });

    } else if (FOOD_OBJECT_IDS.has(object)) {
      // FREE snack spots (gym snack counter + cafeteria dining tables) share
      // ONE per-person "you're full" cooldown — more stations are a
      // convenience, not a faster snack rate. Only the menu + toast icon vary.
      const key = p.email || socket.id;
      const readyAt = fridgeReadyAt.get(key) || 0;
      if (now < readyAt) {
        socket.emit("interactError", { message: "You're full! Your appetite will be back in a bit. 🫃" });
        return;
      }
      pruneCooldowns(fridgeReadyAt, now);
      fridgeReadyAt.set(key, now + FRIDGE_COOLDOWN_MS);
      let s, icon;
      if (object === "snack_counter")  { s = GYM_SNACKS[gymSnackIdx++ % GYM_SNACKS.length]; icon = "💪"; }
      else                             { s = MEALS[mealIdx++ % MEALS.length]; icon = "🍽️"; }
      socket.emit("fridgeSnack", { line: s.line, icon });
      io.emit("objectEffect", { id: socket.id, kind: "snack", emoji: s.emoji });

    } else if (object === "arcade") {
      if (rpsBySocket.has(socket.id)) {
        socket.emit("interactError", { message: "You're already in a match." });
        return;
      }
      if (inRound(socket.id)) {
        socket.emit("interactError", { message: "No arcade during Office After Dark!" });
        return;
      }
      // Needs a second player standing at the cabinet; the nearest free one
      // gets the invite and the normal accept/decline flow takes over.
      let bestId = null, bestD = Infinity;
      for (const [oid, op] of Object.entries(players)) {
        if (oid === socket.id || rpsBySocket.has(oid) || inRound(oid)) continue;
        const ox = (op.x ?? 0) - obj.x, oy = (op.y ?? 0) - obj.y;
        const d = ox * ox + oy * oy;
        if (d <= obj.r * obj.r && d < bestD) { bestId = oid; bestD = d; }
      }
      if (!bestId) {
        socket.emit("interactError", { message: "The arcade needs two players — wave someone over! 🕹️" });
        return;
      }
      // The cabinet's game picker rides along on the interact intent; anything
      // off the roster falls back to RPS. Always a friendly (0-wager) match.
      const g = (typeof game === "string" && GAMES.has(game)) ? game : "rps";
      startRpsChallenge(socket.id, bestId, 0, true, g);
    }
  });

  // ── Office After Dark handlers ───────────────────────────────────────
  // Start a round: anyone approved can, as long as no round is live and they
  // aren't mid-duel. The starter auto-joins; everyone gets the invite.
  socket.on("roundStart", () => {
    const p = players[socket.id];
    if (!p) return;
    if (!takeToken(roundBucket)) return;   // silently drop spam
    if (rpsBySocket.has(socket.id)) { socket.emit("roundError", { message: "Finish your match first!" }); return; }
    if (round) {
      socket.emit("roundError", {
        message: round.state === "joining" ? "A round is already gathering — join that one!" : "A round is already in progress.",
      });
      return;
    }
    // No await between the round-exists check above and this assignment —
    // that synchronicity is the double-start guard.
    round = {
      state: "joining", starterId: socket.id, starterName: p.name,
      members: new Map([[socket.id, { name: p.name, alive: true }]]),
      killerIds: new Set(), endsAt: 0, endTimer: null,
      joinEndsAt: Date.now() + ROUND_JOIN_MS,
      joinTimer: setTimeout(beginRound, ROUND_JOIN_MS),
    };
    io.emit("roundInvite", {
      starterId: socket.id, starterName: p.name,
      joinMs: ROUND_JOIN_MS, minPlayers: ROUND_MIN_PLAYERS, count: 1,
    });
    console.log(`Office After Dark: ${p.name} started a round`);
  });

  socket.on("roundJoin", () => {
    const p = players[socket.id];
    if (!p) return;
    if (!takeToken(roundBucket)) return;
    if (rpsBySocket.has(socket.id)) { socket.emit("roundError", { message: "Finish your match first!" }); return; }
    if (!round || round.state !== "joining") { socket.emit("roundError", { message: "No round is gathering right now." }); return; }
    if (round.members.has(socket.id)) return;   // already in — quietly ignore
    round.members.set(socket.id, { name: p.name, alive: true });
    socket.emit("roundJoined", {
      count: round.members.size,
      joinMs: Math.max(0, round.joinEndsAt - Date.now()),
      minPlayers: ROUND_MIN_PLAYERS,
    });
    // Broadcast to EVERYONE (count only, leaks nothing) so the invite card's
    // "N in so far" stays fresh for people who haven't joined yet.
    io.emit("roundLobby", { count: round.members.size });
  });

  // The killer's kill intent. Everything is validated HERE: role, aliveness,
  // cooldown, proximity (against server-side positions fed by validated
  // playerMoves). Non-killer probes are silently dropped — an error reply
  // would confirm nothing they don't already know, but silence is cheaper.
  socket.on("roundKill", (payload) => {
    const { targetId } = payload || {};
    const p = players[socket.id];
    if (!p) return;
    if (!takeToken(roundBucket)) return;
    if (!round || round.state !== "active" || !round.killerIds.has(socket.id)) return;
    if (typeof targetId !== "string" || targetId === socket.id) return;
    if (round.killerIds.has(targetId)) { socket.emit("roundError", { message: "They're with you…" }); return; }
    const me = round.members.get(socket.id);
    const tm = round.members.get(targetId);
    const tp = players[targetId];
    if (!tm || !tm.alive || !tp) { socket.emit("roundError", { message: "They slipped away…" }); return; }
    const now = Date.now();
    if (now < me.killReadyAt) {
      socket.emit("roundError", { message: `Not yet — ${Math.ceil((me.killReadyAt - now) / 1000)}s until you can strike.` });
      return;
    }
    const dx = (p.x ?? 0) - (tp.x ?? 0), dy = (p.y ?? 0) - (tp.y ?? 0);
    const maxD = ROUND_KILL_RANGE_PX + ROUND_KILL_SLACK_PX;
    if (dx * dx + dy * dy > maxD * maxD) {
      socket.emit("roundError", { message: "Get closer…" });
      return;
    }
    tm.alive = false;
    me.killReadyAt = now + ROUND_KILL_COOLDOWN_MS;   // cooldown is PER KILLER
    // Private cooldown ping to the striking killer only — with several
    // killers, a broadcast restart would wrongly reset teammates' timers.
    socket.emit("roundKillCooldown", { cooldownMs: ROUND_KILL_COOLDOWN_MS });
    // Victim id/name only — the killer's identity stays secret until roundEnd.
    roundEmitMembers("roundKilled", { victimId: targetId, victimName: tm.name });
    console.log(`Office After Dark: ${tm.name} was eliminated`);
    checkKillerWin();
  });

  // ── Disconnect ───────────────────────────────────────────────────────
  socket.on("disconnect", async () => {
    // A mid-match refresh/blip cancels the match immediately (no coins move) —
    // even though the PLAYER gets a ~10s grace window, the MATCH does not:
    // leaving an opponent staring at a hung pick screen is worse than a re-challenge.
    cancelMatchFor(socket.id, "They left the office — match cancelled, no coins moved.");
    roundHandleLeave(socket.id);   // same policy: the PLAYER gets grace, the round does not
    if (pending[socket.id]) {
      console.log(`Pending disconnected: ${pending[socket.id].name}`);
      delete pending[socket.id];
    }
    const p = players[socket.id];
    if (p) {
      delete players[socket.id];
      if (p.email) {
        // Grace period: don't broadcast "left" yet. Keep the avatar visible for
        // everyone else and let a quick reconnect (refresh / blip) resume the SAME
        // session via cancelGrace. Only remove the sprite if they don't return in
        // time. We snapshot the live position so the resume lands exactly here even
        // if the DB flush below is still in flight.
        const email = p.email;
        if (graceByEmail[email]) {
          clearTimeout(graceByEmail[email].timer);
          io.emit("playerLeft", graceByEmail[email].oldId);
        }
        graceByEmail[email] = {
          oldId: socket.id, name: p.name, x: p.x, y: p.y, dir: p.dir, anim: p.anim,
          timer: setTimeout(() => {
            io.emit("playerLeft", socket.id);
            delete graceByEmail[email];
            console.log(`${p.name} left (grace expired)`);
          }, GRACE_MS),
        };
        // Flush final position so a restore AFTER grace expiry still resumes here.
        try {
          await pool.query(
            `UPDATE jpo_players SET x = $2, y = $3, dir = $4, anim = $5, updated_at = now() WHERE email = $1`,
            [email, Math.round(p.x ?? 5304), Math.round(p.y ?? 2232), p.dir || "down", p.anim === "sit" ? "sit" : "idle"],
          );
        } catch (err) { console.error("disconnect flush failed:", err); }
      } else {
        // Session-only player: nothing durable to resume — remove immediately.
        console.log(`${p.name} left`);
        io.emit("playerLeft", socket.id);
      }
    }
    admins.delete(socket.id);
    _notifyAdmins();
  });
});

function _notifyAdmins() {
  if (!admins.size) return;
  _pendingList()
    .then((pend) => {
      const plist = _playerList();
      admins.forEach(id => {
        io.to(id).emit("pendingList", pend);
        io.to(id).emit("playerList",  plist);
      });
    })
    .catch((err) => console.error("notifyAdmins failed:", err));
}

async function _pendingList() {
  // `name` here is the FULL name (approval decisions need real identity);
  // nickname is shown alongside it in the admin panel.
  // Live (connected) registrants first — keyed by socket id, as always.
  const list = Object.entries(pending).map(([id, p]) => ({
    id, name: p.name, nickname: p.nickname || "", email: p.email, character: p.character,
  }));
  // Plus everyone who registered and then LEFT while waiting (closed the tab,
  // phone locked…). Their registration is durable in the DB; before this the
  // queue was memory-only, so they silently vanished from the admin panel the
  // moment they disconnected. Offline entries use an `email:<email>` id —
  // approve/reject resolve it back to the row; approval while offline simply
  // flips the row, and they walk straight in on their next visit.
  try {
    const liveEmails = new Set(list.map(p => p.email).filter(Boolean));
    const { rows } = await pool.query(
      `SELECT email, name, nickname, character FROM jpo_players
        WHERE approved = false AND dismissed = false
        ORDER BY created_at ASC`,
    );
    for (const r of rows) {
      if (liveEmails.has(r.email)) continue;
      list.push({
        id: `email:${r.email}`, name: r.name, nickname: r.nickname || "",
        email: r.email, character: r.character, offline: true,
      });
    }
  } catch (err) { console.error("pending list query failed:", err); }
  return list;
}

function _playerList() {
  // `name` = in-game display name (nickname); `fullName` = real name for admins.
  return Object.entries(players).map(([id, p]) => ({
    id, name: p.name, fullName: p.fullName || p.name, coins: p.coins, cosmetics: p.cosmetics,
    email: p.email || "", isAnnouncer: !!p.isAnnouncer, department: p.department || "",
  }));
}

// Self-healing schema nudge: `dismissed` was added after the app went live, so
// a production database that predates it gets the column on boot (idempotent —
// a no-op everywhere else). Awaited before listen so no query can race it.
try {
  await pool.query(`ALTER TABLE jpo_players ADD COLUMN IF NOT EXISTS dismissed boolean NOT NULL DEFAULT false`);
} catch (err) {
  console.error("schema nudge (dismissed column) failed:", err);
}

const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
  console.log(`JPO Huddle server running on port ${port}`);
});
