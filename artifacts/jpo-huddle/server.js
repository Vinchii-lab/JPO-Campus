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

// Stamp endpoint — always returns the current server's build stamp, never cached.
// The page checks this on load and force-reloads if it was served from a stale cache.
app.get('/stamp', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json({ stamp: BUILD_STAMP });
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
  cigarette: { cost: 20, uses: 5 },   // pack of 5 smokes — outdoors on the grass only
  coffee:    { cost: 10, uses: 1 },   // single cup — +40% walk speed for 45s
};
const SMOKE_MS        = 10_000;  // how long the smoke-puff effect plays (also the "one at a time" cooldown)
const COFFEE_MULT     = 1.4;     // walk-speed multiplier — MUST match client COFFEE_MULT in public/index.html
const COFFEE_MS       = 45_000;  // boost duration — MUST match client (client gets it in the coffeeBoost event)
const BOOST_GRACE_MS  = 2_500;   // extra server-side slack past expiry so latency can't reject a legit last step

// ── Interactive office objects ────────────────────────────────────────────
// Fixed stations on the map you can use with E. Coords are scaled world px
// (tile*48, same space as player x/y) and MUST match OFFICE_OBJECTS in
// public/index.html. r = max distance from the object's centre to the player's
// sprite origin. The client only ever sends an intent; proximity, cooldowns,
// and rate limits are all enforced here.
const OBJECTS = {
  coffee_machine: { x: 1056, y: 864, r: 150 },   // vending-machine bank, IT kitchenette corner (c21-22, r17-18)
  water_cooler:   { x: 1800, y: 1272, r: 150 },  // water dispenser, Pantry (c37, r25-26, beside the potted plant)
  arcade:         { x: 720,  y: 720, r: 170 },   // twin TV screens, IT lounge (c13-16, r14-15)
  fridge:         { x: 1344, y: 1584, r: 190 },  // white kitchen/fridge unit, Pantry (c24-31, r31-33)
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
// Fridge snacks: pure flavor (no buff, no coins). The eater gets the line as a
// toast; everyone nearby sees the snack emoji bubble over their head.
const FRIDGE_COOLDOWN_MS = 45_000;   // "you're full" window between snacks
const SNACKS = [
  { emoji: "🍕", line: "Cold pizza from Friday. Still elite." },
  { emoji: "🥪", line: "A mystery sandwich. It was labeled. You ignored the label." },
  { emoji: "🍎", line: "An apple a day keeps the standup short." },
  { emoji: "🍩", line: "Someone brought donuts. That someone is a hero." },
  { emoji: "🥗", line: "A responsible little salad. Your future self says thanks." },
  { emoji: "🍫", line: "Emergency chocolate. This qualifies as an emergency." },
  { emoji: "🧀", line: "A cheeky cube of cheese. Quality control, obviously." },
  { emoji: "🍜", line: "Instant noodles — the official fuel of shipping features." },
  { emoji: "🍦", line: "Freezer ice cream. Eat fast, type faster." },
  { emoji: "🥡", line: "Leftover takeout. Finders keepers is office law." },
];
let snackIdx = 0;
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
// Tiled map the client renders (public/assets/Office.tmj) so the bounds track a
// future map swap automatically. RENDER_SCALE must match the client's setScale(3)
// in public/index.html — the map file stores tile counts/sizes, not the on-screen
// render scale. Falls back to the current 63×36 map if the file can't be read.
const RENDER_SCALE = 3;
// Outdoor mask: OUTDOOR[row*MAP_W + col] === true where the Floor tile comes
// from the exterior tileset (grass/pavement). Ext is the map's LAST tileset, so
// any Floor gid >= its firstgid is outdoor. Flip-flag bits are masked off
// (Tiled stores flips in the top bits of the gid). Used by the cigarette's
// "outside on the grass only" rule.
const GID_MASK = 0x1FFFFFFF;
// Work-seat GIDs on the Furniture layer: 606 = workstation chair (shares its
// cell with a monitor), 975 / 980 = the baked-in chair cell of the blue / green
// manager desks (the cell the sit action snaps the avatar onto — matches the
// client's DESK_FAMILIES chair cells). Sitting on one of these earns the work
// bonus; sofas/benches/wooden chairs don't. MUST stay in lockstep with the
// client's "desk-type seat" rule (_deskPoseAt: gid 606 or deskChairAt hit),
// which is what shows the 💼 chip.
const WORK_SEAT_GIDS = new Set([606, 975, 980]);
const { WORLD_W, WORLD_H, MAP_W, MAP_H, OUTDOOR, WORK_SEATS } = (() => {
  try {
    const tmj = JSON.parse(readFileSync(path.join(__dirname, "public", "assets", "Office.tmj"), "utf8"));
    const w = tmj.width * tmj.tilewidth * RENDER_SCALE;
    const h = tmj.height * tmj.tileheight * RENDER_SCALE;
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      let outdoor = null;
      const floor = tmj.layers?.find((l) => l.name === "Floor" && Array.isArray(l.data));
      const extGid = tmj.tilesets?.length
        ? Math.max(...tmj.tilesets.map((t) => t.firstgid || 0))
        : null;
      if (floor && extGid) {
        outdoor = floor.data.map((g) => (g & GID_MASK) >= extGid);
      } else {
        console.error("outdoor mask unavailable (no Floor layer or tilesets) — smoking disabled");
      }
      // Work-seat mask from the Furniture layer (same shape as OUTDOOR).
      let workSeats = null;
      const furn = tmj.layers?.find((l) => l.name === "Furniture" && Array.isArray(l.data));
      if (furn) {
        workSeats = furn.data.map((g) => WORK_SEAT_GIDS.has(g & GID_MASK));
      } else {
        console.error("work-seat mask unavailable (no Furniture layer) — work bonus disabled");
      }
      return { WORLD_W: w, WORLD_H: h, MAP_W: tmj.width, MAP_H: tmj.height, OUTDOOR: outdoor, WORK_SEATS: workSeats };
    }
  } catch (err) {
    console.error("map bounds load failed, using fallback:", err);
  }
  // Fallback: 63×36 tiles · 16px · scale 3, no outdoor/work masks (smoking + work bonus disabled).
  return { WORLD_W: 3024, WORLD_H: 1728, MAP_W: 63, MAP_H: 36, OUTDOOR: null, WORK_SEATS: null };
})();

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
const MOVE_SPEED            = 150;   // px/s, MUST match client SPEED in public/index.html
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
const GAMES      = new Set(["rps", "ttt", "qd", "ib", "wr"]);
const GAME_NAMES = { rps: "Rock-Paper-Scissors", ttt: "Tic-Tac-Toe", qd: "Quick Draw", ib: "Icebreakers", wr: "Word Race" };
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
          [p.email, Math.round(p.x ?? 1080), Math.round(p.y ?? 840), p.dir || "down", p.anim === "sit" ? "sit" : "idle", rate],
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
    socket.emit("pendingList", _pendingList());
    socket.emit("playerList",  _playerList());
  });

  socket.on("approvePlayer", async (targetId) => {
    if (!admins.has(socket.id)) return;
    const reg = pending[targetId];
    if (!reg) return;
    delete pending[targetId];

    try {
      // Session-only (no email) registrant: approve into memory only.
      if (!reg.email) {
        const state = {
          x: 1080, y: 840, dir: "down", anim: "idle",
          name: reg.nickname || reg.firstName || reg.name, fullName: reg.name,
          email: "", character: reg.character,
          hairIdx: reg.hairIdx, skinIdx: reg.skinIdx, shirtIdx: reg.shirtIdx, pantsIdx: reg.pantsIdx,
          coins: 50, cosmetics: [], equipped: "", items: {}, isAnnouncer: false,
          department: reg.department || "", createdAt: Date.now(),
        };
        players[targetId] = state;
        io.to(targetId).emit("approved", {
          name: state.name, character: state.character,
          hairIdx: state.hairIdx, skinIdx: state.skinIdx, shirtIdx: state.shirtIdx, pantsIdx: state.pantsIdx,
          coins: state.coins, cosmetics: state.cosmetics, equipped: state.equipped, items: state.items,
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

      const { rows } = await pool.query(
        `UPDATE jpo_players SET approved = true, updated_at = now() WHERE email = $1 RETURNING *`,
        [reg.email],
      );
      const row = rows[0];
      if (!row) return;

      const targetSocket = io.sockets.sockets.get(targetId);
      if (targetSocket) await restorePlayer(targetSocket, row);
      _notifyAdmins();
      console.log(`Approved: ${row.name}`);
    } catch (err) {
      console.error("approvePlayer failed:", err);
    }
  });

  socket.on("rejectPlayer", (targetId) => {
    if (!admins.has(socket.id)) return;
    const reg = pending[targetId];
    if (reg) delete pending[targetId];
    io.to(targetId).emit("rejected");
    _notifyAdmins();
    console.log(`Rejected: ${reg?.name}`);
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
    delete players[targetId];
    io.to(targetId).emit("kicked");
    io.emit("playerLeft", targetId);
    if (p.email) {
      try {
        await pool.query(
          `UPDATE jpo_players SET approved = false, updated_at = now() WHERE email = $1`,
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
      const boosted = me.boostUntil && now < me.boostUntil + BOOST_GRACE_MS;
      const speed = boosted ? MOVE_SPEED * COFFEE_MULT : MOVE_SPEED;
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
    io.emit("chatMessage", { id: socket.id, name: players[socket.id].name, message: text });
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
      fullName:   p.fullName || p.name,
      department: p.department || "",
      email:      p.email || "",
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

    if (object === "coffee_machine") {
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
      io.emit("coffeeBoost", { id: socket.id, durationMs: COFFEE_MS, mult: COFFEE_MULT });
      console.log(`${p.name} brewed a free coffee at the machine`);

    } else if (object === "water_cooler") {
      const key = p.email || socket.id;
      if (now < (waterReadyAt.get(key) || 0)) return;   // just sipped — quietly ignore
      pruneCooldowns(waterReadyAt, now);
      waterReadyAt.set(key, now + WATER_COOLDOWN_MS);
      const line = WATER_LINES[waterLineIdx++ % WATER_LINES.length];
      socket.emit("waterCooler", { line });
      io.emit("objectEffect", { id: socket.id, kind: "water" });

    } else if (object === "fridge") {
      const key = p.email || socket.id;
      const readyAt = fridgeReadyAt.get(key) || 0;
      if (now < readyAt) {
        socket.emit("interactError", { message: "You're full! The fridge will forgive you in a bit. 🫃" });
        return;
      }
      pruneCooldowns(fridgeReadyAt, now);
      fridgeReadyAt.set(key, now + FRIDGE_COOLDOWN_MS);
      const s = SNACKS[snackIdx++ % SNACKS.length];
      socket.emit("fridgeSnack", { line: s.line });
      io.emit("objectEffect", { id: socket.id, kind: "snack", emoji: s.emoji });

    } else if (object === "arcade") {
      if (rpsBySocket.has(socket.id)) {
        socket.emit("interactError", { message: "You're already in a match." });
        return;
      }
      // Needs a second player standing at the cabinet; the nearest free one
      // gets the invite and the normal accept/decline flow takes over.
      let bestId = null, bestD = Infinity;
      for (const [oid, op] of Object.entries(players)) {
        if (oid === socket.id || rpsBySocket.has(oid)) continue;
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

  // ── Disconnect ───────────────────────────────────────────────────────
  socket.on("disconnect", async () => {
    // A mid-match refresh/blip cancels the match immediately (no coins move) —
    // even though the PLAYER gets a ~10s grace window, the MATCH does not:
    // leaving an opponent staring at a hung pick screen is worse than a re-challenge.
    cancelMatchFor(socket.id, "They left the office — match cancelled, no coins moved.");
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
            [email, Math.round(p.x ?? 1080), Math.round(p.y ?? 840), p.dir || "down", p.anim === "sit" ? "sit" : "idle"],
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
  admins.forEach(id => {
    io.to(id).emit("pendingList", _pendingList());
    io.to(id).emit("playerList",  _playerList());
  });
}

function _pendingList() {
  // `name` here is the FULL name (approval decisions need real identity);
  // nickname is shown alongside it in the admin panel.
  return Object.entries(pending).map(([id, p]) => ({
    id, name: p.name, nickname: p.nickname || "", email: p.email, character: p.character,
  }));
}

function _playerList() {
  // `name` = in-game display name (nickname); `fullName` = real name for admins.
  return Object.entries(players).map(([id, p]) => ({
    id, name: p.name, fullName: p.fullName || p.name, coins: p.coins, cosmetics: p.cosmetics,
    email: p.email || "", isAnnouncer: !!p.isAnnouncer, department: p.department || "",
  }));
}

const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
  console.log(`JPO Huddle server running on port ${port}`);
});
