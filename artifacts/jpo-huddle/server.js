import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import path from "path";
import { readFileSync } from "fs";
import pg from "pg";
import crypto from "crypto";
import OpenAI from "openai";
import { ReplitConnectors } from "@replit/connectors-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";  // no insecure default: admin features stay disabled until this env/secret is set
// Signs the resume tokens that let a returning browser auto-rejoin without
// re-registering. When unset, auto-rejoin is disabled and everyone falls back to
// the normal register flow. This is lightweight identity continuity, NOT auth.
const SESSION_SECRET = process.env.SESSION_SECRET || "";
// Content-derived build stamp: identical across server instances running the
// same code (boot-time stamps would make an autoscaled deployment hand a
// reconnecting client alternating stamps → reload churn) and unchanged by a
// restart that didn't touch the page — tabs reload only for real new code.
const BUILD_STAMP = crypto.createHash("sha1")
  .update(readFileSync(path.join(__dirname, "public", "index.html")))
  .digest("hex").slice(0, 12);

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
// The content-hash BUILD_STAMP is injected into the page; it changes exactly
// when the page's code changes, and the build handshake uses it to pull
// already-open tabs forward after a deploy/restart that shipped new code.
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

// ── Voice ICE: STUN + minted TURN relay credentials ─────────────────────────
// Proximity voice is peer-to-peer; pairs behind strict/carrier-grade NAT
// (common on home ISPs) can't form a direct path and need a TURN relay.
// Short-lived relay credentials are minted through the Twilio connection
// (Network Traversal Service) and cached until 75% of their TTL. On ANY
// failure the endpoint degrades to the same STUN-only list the client
// defaults to — voice then behaves exactly as before this feature.
const _ice = { cached: null, until: 0, sid: null, connectors: null };
// Strategy 1 — direct: TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN secrets, plain
// Basic auth against api.twilio.com. This is the reliable path.
// Strategy 2 — connector proxy: the attached Twilio connection. As of
// 2026-07 its stored credential is rejected by Twilio's classic REST API
// (error 20003 on every path shape), so this only matters if the connector
// gains classic-API support later — then it lights up on its own.
async function mintTwilioDirect() {
  const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok) return null;   // not configured — let the caller try the proxy
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid.trim()}/Tokens.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid.trim()}:${tok.trim()}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "Ttl=14400",
  });
  if (!r.ok) throw new Error(`direct token mint ${r.status}`);
  return r.json();
}
async function mintTwilioProxy() {
  if (!_ice.connectors) _ice.connectors = new ReplitConnectors();
  if (!_ice.sid) {
    const r = await _ice.connectors.proxy("twilio", "/2010-04-01/Accounts.json", { method: "GET" });
    if (!r.ok) throw new Error(`accounts lookup ${r.status}`);
    _ice.sid = (await r.json())?.accounts?.[0]?.sid;
    if (!_ice.sid) throw new Error("no account sid in accounts lookup");
  }
  const r = await _ice.connectors.proxy("twilio", `/2010-04-01/Accounts/${_ice.sid}/Tokens.json`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "Ttl=14400",
  });
  if (!r.ok) throw new Error(`token mint ${r.status}`);
  return r.json();
}
async function mintIceServers() {
  if (_ice.cached && Date.now() < _ice.until) return _ice.cached;
  let d = null, directErr = null;
  try { d = await mintTwilioDirect(); }
  catch (e) { directErr = e; console.warn(`voice-ice: direct mint failed (${e.message}) — trying connector proxy`); }
  if (!d) {
    try { d = await mintTwilioProxy(); }
    catch (e) { throw directErr && directErr.message ? new Error(`${directErr.message}; proxy: ${e.message}`) : e; }
  }
  const servers = (d.ice_servers || []).map((s) => {
    const e = { urls: s.urls || s.url };
    if (s.username) e.username = s.username;
    if (s.credential) e.credential = s.credential;
    return e;
  });
  if (!servers.length) throw new Error("empty ice_servers");
  const ttl = Number(d.ttl) || 14400;
  _ice.cached = { iceServers: servers, ttl };
  _ice.until = Date.now() + ttl * 750;   // 75% of ttl, in ms
  return _ice.cached;
}
app.get('/voice-ice', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  try {
    res.json(await mintIceServers());
  } catch (e) {
    console.warn(`voice-ice: STUN-only fallback (${e.message})`);
    res.json({ iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }], ttl: 600, fallback: true });
  }
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
      // Round-leave seam, same as disconnect/kickPlayer/dropLiveByEmail —
      // without it a purge mid-round leaves unkillable ghost members and the
      // round zombie-runs to the timer. Keyed off round.members, so calling
      // it before/after the players[] delete both work; order matches
      // dropLiveByEmail (delete first is fine).
      roundHandleLeave(id);
      delete players[id];
      io.to(id).emit("kicked");
      io.emit("playerLeft", id);
    }
    for (const id of Object.keys(pending)) {
      delete pending[id];
      io.to(id).emit("rejected");
    }
    // Graced (briefly disconnected) players aren't in players[] — cancel the
    // hold AND leave their deferred round spot (no successor restore follows).
    for (const em of Object.keys(graceByEmail)) if (em !== keep) { cancelGrace(em); roundLeaveGoneByEmail(em); }
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

// ── Admin broadcast banner (ephemeral, per server process) ────────────────────
// One office-wide banner every client shows until THEY dismiss it (dismissal is
// client-side by banner id). Late logins still see the current banner.
let adminBanner = null;   // { id, text, ts } | null
let bannerSeq = 0;

// ── Office Bingo (admin-triggered event, ephemeral) ──────────────────────────
// One game at a time. Players keyed by EMAIL so a refresh mid-game keeps the
// same card. Server owns the cards, the calls, and the win check — the client
// only daubs and claims. Prize is paid by the house (no entry fee).
let bingo = null;   // { id, state:'joining'|'active', prize, players: Map(email -> {name, card, daubs:Set}), pool, called:[], joinTimer, callTimer }
let bingoGameSeq = 0;   // every game gets a fresh id; late async emits from an old game carry it so clients can ignore them
// Env-tunable so integration tests can run a fast game (prod stays 60s/4s).
const BINGO_JOIN_MS = Number(process.env.BINGO_JOIN_MS) || 60_000;
const BINGO_CALL_MS = Number(process.env.BINGO_CALL_MS) || 4_000;
const BINGO_PRIZE_MIN = 100, BINGO_PRIZE_MAX = 100_000;
function makeBingoCard() {
  // Column-ranged like real bingo: B 1-15, I 16-30, N 31-45, G 46-60, O 61-75.
  // card[row][col]; center (2,2) is FREE = 0.
  const cols = [];
  for (let c = 0; c < 5; c++) {
    const pool = Array.from({ length: 15 }, (_, i) => c * 15 + i + 1);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    cols.push(pool.slice(0, 5));
  }
  const card = Array.from({ length: 5 }, (_, r) => Array.from({ length: 5 }, (_, c) => cols[c][r]));
  card[2][2] = 0;
  return card;
}
function bingoHasLine(card, daubs) {
  const hit = (r, c) => card[r][c] === 0 || daubs.has(card[r][c]);
  for (let r = 0; r < 5; r++) if ([0,1,2,3,4].every((c) => hit(r, c))) return `row ${r + 1}`;
  for (let c = 0; c < 5; c++) if ([0,1,2,3,4].every((r) => hit(r, c))) return `column ${c + 1}`;
  if ([0,1,2,3,4].every((i) => hit(i, i))) return "diagonal";
  if ([0,1,2,3,4].every((i) => hit(i, 4 - i))) return "diagonal";
  return null;
}
function bingoStop() {
  if (!bingo) return;
  clearTimeout(bingo.joinTimer);
  clearInterval(bingo.callTimer);
  bingo = null;
}
// Draw + broadcast the next ball. Shared by the auto interval and the
// admin's manual "call next number" button.
function bingoCallNext() {
  if (!bingo || bingo.state !== "active") return;
  const n = bingo.pool.shift();
  if (n === undefined) {
    io.emit("bingoOver", { gameId: bingo.id, winnerName: null, message: "All 75 numbers called — no bingo! The office keeps its coins." });
    bingoStop();
    return;
  }
  bingo.called.push(n);
  io.emit("bingoCall", { gameId: bingo.id, n, letter: "BINGO"[Math.floor((n - 1) / 15)], count: bingo.called.length });
}
// auto → interval calls; manual → the admin host presses "call next".
function bingoSetMode(mode) {
  if (!bingo) return;
  bingo.mode = mode;
  clearInterval(bingo.callTimer);
  bingo.callTimer = (mode === "auto" && bingo.state === "active")
    ? setInterval(bingoCallNext, BINGO_CALL_MS) : null;
}
// Join window over → start calling (needs 2+ players for a real game).
function bingoBegin() {
  if (!bingo || bingo.state !== "joining") return;
  if (bingo.players.size < 2) {
    io.emit("bingoOver", { gameId: bingo.id, winnerName: null, message: "Bingo cancelled — not enough players joined." });
    bingoStop();
    return;
  }
  bingo.state = "active";
  io.emit("bingoStart", { gameId: bingo.id, playerCount: bingo.players.size, prize: bingo.prize, mode: bingo.mode });
  console.log(`BINGO active: ${bingo.players.size} players (${bingo.mode} calling)`);
  bingoSetMode(bingo.mode);
}

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
// ids to names/prices for the shop UI; the emoji there is only the row icon).
// ALL wearables are sprite wearables since July 2026 — drawn ON the body
// client-side (real pixel art pinned to the avatar, not a floating emoji).
// Premium price ladder (vs the +2/min earn rate: cheapest ≈ a couple days of
// hanging out, crown is a long-term goal); server is authoritative — client
// drift only mislabels the shop row.
const SHOP = {
  sunglasses:   3000,
  book:         3200,
  spectacles:   3400,
  headphones:   3600,
  beret:        3800,
  chefhat:      4000,
  beanie:       4200,
  camera:       4400,
  flatcap:      4600,
  gamerheadset: 4800,
  rangerhat:    5000,
  guitar:       5250,
  shades:       5500,
  catears:      5750,
  cap:          6000,
  scifihelmet:  6500,
  chain:        7000,
  crown:        8000,
};

// ── Pets catalog ─────────────────────────────────────────────────────────────
// Buy-once companions that follow their owner around the office. Ownership is
// stored in the SAME cosmetics array as wearables (the 'pet_' prefix keeps the
// id spaces disjoint — equipCosmetic rejects pet ids because they're not in
// SHOP, and equipPet rejects wearable ids because they're not in PETS). The
// active pet lives in jpo_players.equipped_pet ('' = none): a separate slot
// from equipped_cosmetic, so you can wear shades AND walk your dog. Ids MUST
// match the client PETS catalog in public/index.html (emoji/names live there).
// Breed/color variants (July 2026) are simply their own pet ids
// (pet_<species>_<variant>) — the whole adopt/bring/persist/broadcast
// pipeline reuses them untouched, and existing owners' ids ARE the classic
// looks (zero migration). Classic prices unchanged; fancy looks cost more.
// Ids MUST match the client PETS catalog in public/index.html.
const PETS = {
  pet_duck:             10000,
  pet_duck_snow:        14000,
  pet_cat:              12500,
  pet_cat_black:        16000,
  pet_cat_snow:         18000,
  pet_dog:              12500,
  pet_dog_choco:        16000,
  pet_dog_husky:        18000,
  pet_bunny:            15000,
  pet_bunny_cocoa:      19000,
  pet_turtle:           20000,
  pet_turtle_sapphire:  26000,
  pet_dragon:           30000,
  pet_dragon_crimson:   38000,
  pet_dragon_obsidian:  45000,
};

// ── Pet accessories catalog ──────────────────────────────────────────────────
// Cosmetic add-ons drawn ON the active pet (one slot). Ownership shares the
// same cosmetics array — the 'petacc_' prefix keeps the id space disjoint from
// both wearables (SHOP) and pets (PETS), so every other equip handler rejects
// these ids for free and vice versa. The worn accessory lives in
// jpo_players.equipped_pet_acc ('' = bare pet); it applies to whichever pet is
// out, and owning one with no pet out is fine — it shows when a pet is out.
// Priced as a follow-up treat, deliberately well under the pets themselves.
// Ids MUST match the client PET_ACCESSORIES catalog in public/index.html.
const PET_ACCESSORIES = {
  petacc_bow:    2000,
  petacc_bell:   2500,
  petacc_tophat: 6000,
  petacc_crown:  8000,
};
// Retired accessories (user call, July 2026: headwear only — scarf/shades
// made no sense hovering on heads). A startup nudge refunds owners the full
// price, strips the id from cosmetics, and bares any pet still wearing one —
// idempotent, so prod self-heals on first boot after deploy (prod DB can't be
// migrated by hand). Never reuse these ids.
const RETIRED_PET_ACCS = { petacc_scarf: 3500, petacc_shades: 4500 };

// ── Live price overrides (admin superpower, July 2026) ──────────────────────
// The owner can change any SHOP/PETS/PET_ACCESSORIES price live from the F8
// panel — no redeploy. Overrides persist in jpo_shop_prices (created at boot,
// same self-healing policy as the other schema nudges) and are folded into
// the in-memory catalogs on startup, so every buy handler keeps reading the
// same maps it always did. DEFAULT_PRICES snapshots the shipped prices so the
// panel can show "default" and setting an item back to it deletes the row.
const DEFAULT_PRICES = { ...SHOP, ...PETS, ...PET_ACCESSORIES };
const PRICE_MIN = 1, PRICE_MAX = 1_000_000;
function catalogOf(item) {
  if (Object.hasOwn(SHOP, item)) return SHOP;
  if (Object.hasOwn(PETS, item)) return PETS;
  if (Object.hasOwn(PET_ACCESSORIES, item)) return PET_ACCESSORIES;
  return null;
}
function allPrices() { return { ...SHOP, ...PETS, ...PET_ACCESSORIES }; }

// ── Coin gifting (July 2026) ─────────────────────────────────────────────────
// Player→player coin sends. Per-sender daily cap keeps "send me coins"
// pressure and funneling in check. The cap ledger is in-memory (resets on
// restart) — it's a soft social guardrail, not a financial invariant; the
// transfer itself reuses the rpsSettle atomic pattern so a partial move is
// impossible.
const GIFT_DAILY_CAP = 5000;
const giftLedger = new Map();   // senderKey (email or socket id) → { day, sent }
function giftRoomToday(key) {
  const day = new Date().toISOString().slice(0, 10);
  const e = giftLedger.get(key);
  if (!e || e.day !== day) return GIFT_DAILY_CAP;
  return Math.max(0, GIFT_DAILY_CAP - e.sent);
}
function giftRecord(key, amount) {
  const day = new Date().toISOString().slice(0, 10);
  const e = giftLedger.get(key);
  if (!e || e.day !== day) giftLedger.set(key, { day, sent: amount });
  else e.sent += amount;
}

// ── Pet trades (July 2026) ───────────────────────────────────────────────────
// Direct offers only (no open marketplace): "my cat + 2000 coins for your
// dragon". Both sides must be email-backed (a trade must persist), the
// settle is ONE SQL transaction with ownership/coins guards re-checked
// inside it, and each received pet auto-adopts — same feel as buying.
const TRADE_ACCEPT_MS = 60_000;
let tradeSeq = 0;
const tradeBySocket = new Map();   // socketId → trade (both parties point at the same object)
function clearTrade(t, notifyMsg) {
  if (!t || t.state === "done") return;
  t.state = "done";
  clearTimeout(t.timer);
  tradeBySocket.delete(t.fromId);
  tradeBySocket.delete(t.toId);
  if (notifyMsg) {
    io.to(t.fromId).emit("tradeEnded", { tradeId: t.id, message: notifyMsg });
    io.to(t.toId).emit("tradeEnded",   { tradeId: t.id, message: notifyMsg });
  }
}

// ── Bid stores / office market (July 2026) ──────────────────────────────────
// Ragnarok-style persistent player stores: list a pet/wearable/accessory at a
// minimum bid, collect bids while you're online OR offline, accept the one
// you like. Money safety rules:
//   • Bids are ESCROWED — the coins leave the bidder's balance the moment the
//     bid lands (one guarded UPDATE), so a winning bid can never bounce.
//     Raising your bid refunds the old escrow and takes the new one in the
//     same transaction; withdrawing/losing/unlisting refunds it.
//   • Accepting settles in ONE transaction: item leaves the seller (un-equips
//     if worn), joins the winner (who must not already own it), the escrow
//     credits the seller, every other bid refunds, listing dies. Any guard
//     failing rolls the whole thing back.
//   • Offline parties get their outcome queued in jpo_store_msgs and toasted
//     on next login (the DB is the store; sockets are just the storefront).
const STORE_BID_MIN = 1, STORE_BID_MAX = 1_000_000;
// Strict integer parse for market payloads: decimals, huge values, and
// non-numeric junk become NaN (rejected) instead of silently rounding.
function storeInt(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : NaN;
}
// Human label for a catalog id in server-side toasts (the pretty names live
// in the client catalogs; the server only has price maps).
function itemLabel(id) {
  return String(id).replace(/^(petacc_|pet_)/, "").replace(/_/g, " ");
}

function socketIdByEmail(email) {
  // Grace-window trap: a player who just closed the tab lingers in `players`
  // for ~10s (reconnect grace). Only a socket that is actually CONNECTED can
  // receive a toast — anyone else must get their outcome queued as mail, or
  // it's silently lost to a dead socket.
  for (const [id, p] of Object.entries(players))
    if (p.email === email && io.sockets.sockets.has(id)) return id;
  return null;
}
async function queueStoreMsg(email, message) {
  try {
    await pool.query(`INSERT INTO jpo_store_msgs (email, message) VALUES ($1, $2)`, [email, message]);
  } catch (err) { console.error("queueStoreMsg failed:", err); }
}
// Toast an outcome to a live socket, or park it for their next login.
async function storeNotify(email, message) {
  const id = socketIdByEmail(email);
  if (id) io.to(id).emit("storeOk", { message });
  else await queueStoreMsg(email, message);
}
// Keep a live player's cached balance honest after an escrow/refund/credit
// touched their row (wager caps and shop affordability read the cache).
async function syncCoins(email) {
  const id = socketIdByEmail(email);
  if (!id) return;
  try {
    const { rows } = await pool.query(`SELECT coins FROM jpo_players WHERE email = $1`, [email]);
    if (rows[0] && players[id]) {
      players[id].coins = rows[0].coins;
      io.to(id).emit("coinUpdate", { coins: rows[0].coins });
    }
  } catch (err) { console.error("syncCoins failed:", err); }
}

// Full market snapshot for one viewer. Own listings include the whole bid
// list (with bidder names); everyone else's show min/top/count + your bid.
async function marketSnapshot(myEmail) {
  const { rows: listings } = await pool.query(
    `SELECT l.id, l.seller_email, l.item_id, l.min_bid, p.name AS seller_name
       FROM jpo_store_listings l JOIN jpo_players p ON p.email = l.seller_email
      ORDER BY l.id DESC`);
  const { rows: bids } = await pool.query(
    `SELECT b.id, b.listing_id, b.bidder_email, b.amount, p.name AS bidder_name
       FROM jpo_store_bids b JOIN jpo_players p ON p.email = b.bidder_email
      ORDER BY b.amount DESC, b.id ASC`);
  const byListing = new Map();
  for (const b of bids) {
    if (!byListing.has(b.listing_id)) byListing.set(b.listing_id, []);
    byListing.get(b.listing_id).push(b);
  }
  return listings.map((l) => {
    const lb = byListing.get(l.id) || [];
    const mine = l.seller_email === myEmail;
    const my = lb.find((b) => b.bidder_email === myEmail);
    return {
      id: l.id, item: l.item_id, minBid: l.min_bid,
      sellerName: l.seller_name, mine,
      topBid: lb.length ? lb[0].amount : 0, bidCount: lb.length,
      myBid: my ? my.amount : 0,
      bids: mine ? lb.map((b) => ({ bidId: b.id, name: b.bidder_name, amount: b.amount })) : undefined,
    };
  });
}

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
  // (coffee_machine2 removed July 2026 — the counter object at c171-172 r70-71
  // reads as a plant/lamp beside the fruit basket, not a coffee maker, per
  // owner; don't re-add it. The art stays as pure decoration.)
  // White cabinet coffee makers (Interiors 2669/2685 units) around the office.
  // EVERY id starting with "coffee_machine" is one station of the same brew
  // system: interact matches on the prefix and they ALL share the single
  // per-person coffeeMachineReadyAt cooldown — more machines are a walk-distance
  // convenience, never a faster refill. Coords MUST match OFFICE_OBJECTS.
  coffee_machine3:  { x: 2016, y: 1440, r: 150 }, // West Office pair (c41-42, r28-29)
  coffee_machine4:  { x: 7056, y: 1584, r: 150 }, // East Office pair (c146-147, r31-32)
  coffee_machine5:  { x: 4800, y: 1776, r: 150 }, // Central Office pair (c99-100, r35-36)
  coffee_machine6:  { x: 3600, y: 3840, r: 150 }, // Lounge/Market pair (c74-75, r78-79)
  // (coffee_machine7 removed July 2026 — the 2669/2685 unit at c183 r64-65 sits in
  // the QA manager's room and its art reads as a blender cabinet there, per owner.)
  coffee_machine8:  { x: 8904, y: 3648, r: 150 }, // Library single (c185, r74-75)
  coffee_machine9:  { x: 3768, y: 5088, r: 150 }, // IT Office single (c78, r104-105)
  coffee_machine10: { x: 3768, y: 5616, r: 150 }, // Dev Room single (c78, r115-116)
  coffee_machine11: { x: 8952, y: 5712, r: 150 }, // Training Room single (c186, r117-118)
  water_cooler:    { x: 1800, y: 3816, r: 150 }, // water dispenser, Market north wall (c37, r78-79)
  arcade:          { x: 5280, y: 6000, r: 170 }, // arcade cabinets, Break Room basement corner (c108-111, r123-127)
  // Game Room tables (Basement tileset art, c194-198): each starts its game
  // with the nearest free player — same friendly-duel flow as the arcade.
  pool_table:      { x: 9408, y: 3336, r: 170 }, // green billiard table (c194-197, r68-70) → Billiards
  pool_table2:     { x: 9408, y: 3096, r: 170 }, // blue billiard table (c194-197, r63-65) → Billiards
  pingpong_table:  { x: 9480, y: 2760, r: 170 }, // ping pong table (c196-198, r56-58) → Ping Pong
  fridge:          { x: 5592, y: 4008, r: 190 }, // drink-cooler stack, cafeteria serving area (c116, r82-84)
  kitchen_island:  { x: 5232, y: 3624, r: 240 }, // cafeteria serving line: display cases + checkout counter (c104-113, r74-75)
  snack_counter:   { x: 9048, y: 1968, r: 220 }, // twin snack displays, Gym (c186-187 + c189-190, r38-43; one shared anchor)
  // ── Gym animated equipment (LimeZu animation strips) ────────────────────
  // Pure flavor — no coins, no boost, so no cooldown map either (interactBucket
  // is the spam guard). interact re-checks proximity, then broadcasts gymFx so
  // EVERY client plays the strip (bag punch / belt run). Coords MUST match
  // OFFICE_OBJECTS; the client replaces the static Furniture tiles with the
  // animated sprites at create() (see the gym block in index.html).
  punch_bag1:      { x: 9432, y: 888, r: 100 },  // hanging bag (c196, r16-18)
  punch_bag2:      { x: 9576, y: 888, r: 100 },  // hanging bag (c199, r16-18)
  punch_bag3:      { x: 9720, y: 888, r: 100 },  // hanging bag (c202, r16-18)
  punch_bag4:      { x: 9864, y: 888, r: 100 },  // hanging bag (c205, r16-18)
  treadmill1:      { x: 9336, y: 1656, r: 150 }, // treadmill (c193-195, r33-35)
  treadmill2:      { x: 9480, y: 1656, r: 150 }, // treadmill (c196-198, r33-35)
  treadmill3:      { x: 9624, y: 1656, r: 150 }, // treadmill (c199-201, r33-35)
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
// conference tables, checkouts), 2628 = the
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
// (2763/2764 were removed July 2026: on this map every instance is the pedestal
// row of the 2-wide white lectern/front-desk unit 2731/2747/2763 — not chairs.)
const WORK_SEAT_GIDS = new Set([2231, 2628, 2600, 5033]);
// Jail-tileset computer-desk chairs live on the WALL layer (their cells hold no
// Furniture gid at all) — the work-seat mask below ORs these in from the Wall
// layer. MUST stay in lockstep with the client's WALL_SEATS table.
const WALL_WORK_SEAT_GIDS = new Set([5533, 5564, 5565]);
const { WORLD_W, WORLD_H, MAP_W, MAP_H, OUTDOOR, FLOORED, PAINTED, WALKABLE, WORK_SEATS, FOOD_TABLES } = (() => {
  try {
    const tmj = JSON.parse(readFileSync(path.join(__dirname, "public", "assets", "JPO_HQ.tmj"), "utf8"));
    const w = tmj.width * tmj.tilewidth * RENDER_SCALE;
    const h = tmj.height * tmj.tileheight * RENDER_SCALE;
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      let outdoor = null;
      let floored = null;
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
      // Painted-floor mask: FLOORED[i] === true where ANY Floor tile is painted.
      // Everything walkable in the office (interior floors AND the grass) has
      // floor art; the black void around/above the building has gid 0. Used to
      // rescue restored players whose saved position predates a map change and
      // now lands in the void (the July 2026 "respawning outside the map"
      // production report — positions saved on the old layout restored into
      // nothingness after publish).
      if (floor) floored = floor.data.map((g) => (g & GID_MASK) !== 0);
      // Painted-ANY-layer mask: PAINTED[i] === true where Floor, Wall or
      // Furniture has art. The true void around the building has nothing on
      // any layer. Used by the playerMove void rejection — deliberately
      // BROADER than FLOORED: players legitimately stand in opened wall-notch
      // cells that carry Wall art with no Floor painted under it, so the
      // restore rescue stays floor-only while movement blocking uses the
      // any-layer rule (the client's _paintedWorldAt mirrors it exactly).
      let painted = null;
      let walkable = null;
      if (floor) {
        painted = floor.data.map((g) => (g & GID_MASK) !== 0);
        // Huddles' stroll mask: NPC-walkable = painted Floor art with NOTHING
        // on Wall/Furniture — plain corridor/room floor only. Deliberately
        // conservative (wall-notch doorway cells that carry Wall art are
        // excluded); the NPC's BFS router only ever routes through these, and
        // an unreachable tour stop is dropped with a boot log line.
        walkable = floor.data.map((g) => (g & GID_MASK) !== 0);
        for (const ln of ["Wall", "Furniture"]) {
          const l = tmj.layers?.find((x) => x.name === ln && Array.isArray(x.data));
          if (l) l.data.forEach((g, i) => { if ((g & GID_MASK) !== 0) { painted[i] = true; walkable[i] = false; } });
        }
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
      return { WORLD_W: w, WORLD_H: h, MAP_W: tmj.width, MAP_H: tmj.height, OUTDOOR: outdoor, FLOORED: floored, PAINTED: painted, WALKABLE: walkable, WORK_SEATS: workSeats, FOOD_TABLES: foodTables };
    }
  } catch (err) {
    console.error("map bounds load failed, using fallback:", err);
  }
  // Fallback: 210×128 tiles · 16px · scale 3, no outdoor/work/floor masks (smoking + work bonus + void rescue + NPC wandering disabled).
  return { WORLD_W: 10080, WORLD_H: 6144, MAP_W: 210, MAP_H: 128, OUTDOOR: null, FLOORED: null, PAINTED: null, WALKABLE: null, WORK_SEATS: null, FOOD_TABLES: [] };
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

// Grass spawn point: tile (26, 47) — the lawn just west of the building's
// main (west) entrance corridor at rows 44-50, verified all Ext grass with no
// Wall/Furniture for several tiles around. Serves double duty: void-rescue
// respawn for bad saved positions AND the new-registrant spawn (the DB column
// defaults in lib/db/src/schema/jpoPlayers.ts and the client's SPAWN_X/SPAWN_Y
// fallback carry the same coords — keep all three in lockstep). World px follow
// the client's position convention (x = col*48+24, y = row*48+24-BODY_DY).
const GRASS_SPAWN = { x: 26 * TILE_PX + TILE_PX / 2, y: 47 * TILE_PX + TILE_PX / 2 - BODY_DY };
// A restored position is "in the void" when its FEET tile has no painted Floor
// art at all (the black nothing around the building) or is outside the map.
// Deliberately conservative: ONLY unpainted tiles count — never walls or
// furniture — so it can't misfire on seated players (workstation cells carry
// Wall-layer monitor tiles) or anyone standing somewhere unusual but real.
function isVoidPosition(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
  const col = Math.floor(x / TILE_PX), row = Math.floor((y + BODY_DY) / TILE_PX);
  if (col < 0 || row < 0 || col >= MAP_W || row >= MAP_H) return true;
  if (!FLOORED) return false;   // no mask (map load failed) → never relocate anyone
  return !FLOORED[row * MAP_W + col];
}

// Movement void gate: TRUE when the feet tile has no art on ANY layer — the
// true nothing outside the drawn world (the map's west courtyard edge has no
// fence, so without this anyone could stroll off the grass into blackness).
// Deliberately BROADER than isVoidPosition: players legitimately stand in
// opened wall-notch cells (Wall art, no Floor painted), so the restore rescue
// stays floor-only while movement rejection uses the any-layer rule. The
// client's _paintedWorldAt clamp mirrors this exactly (that's the UX half;
// this is the anti-cheat half).
function isUnpaintedPosition(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return true;
  const col = Math.floor(x / TILE_PX), row = Math.floor((y + BODY_DY) / TILE_PX);
  if (col < 0 || row < 0 || col >= MAP_W || row >= MAP_H) return true;
  if (!PAINTED) return false;   // no mask (map load failed) → never block movement
  return !PAINTED[row * MAP_W + col];
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

// ── Huddles, the walking connection coach (server-driven NPC) ───────────────
// A real character everyone sees at the same spot, strolling a tour of the
// office's social hotspots. Deliberately NOT in `players`: dedicated npc*
// events keep it out of the whisper roster, duel/profile target scans, After
// Dark rounds, leaderboards and group payouts. Clients render it purely from
// npcState (full snapshot, pulled via npcSync at scene create + pushed on
// approval) and npcMoved ticks.
const NPC = {
  id: "npc:huddles", name: "Huddles", character: "amelia",
  hairIdx: 3, skinIdx: 1, shirtIdx: 5, pantsIdx: 2,
  x: GRASS_SPAWN.x, y: GRASS_SPAWN.y, dir: "down", anim: "idle",
};
const NPC_SPEED       = 110;      // px/s — a relaxed stroll (players run 195)
const NPC_TICK_MS     = 100;
const NPC_TALK_RADIUS = 200;      // server-side E-press proximity check, px
const NPC_DWELL_MIN_MS = 20_000, NPC_DWELL_MAX_MS = 45_000;
// Tour stops (ids in OBJECTS): the anchor is the machine/table itself; the
// router walks to the nearest WALKABLE tile beside it. Order ≈ a loop around
// the office; unreachable stops are skipped at runtime (logged once at boot).
const NPC_STOPS = ["coffee_machine5", "water_cooler", "coffee_machine6", "kitchen_island", "arcade", "pool_table", "snack_counter"];

const npcTileOf = (x, y) => [Math.floor(x / TILE_PX), Math.floor((y + BODY_DY) / TILE_PX)];
const npcTileWalkable = (c, r) => c >= 0 && r >= 0 && c < MAP_W && r < MAP_H && !!(WALKABLE && WALKABLE[r * MAP_W + c]);

// Nearest walkable tile to (c,r): ring-expanding BFS over the 4-neighbourhood,
// ignoring walkability while searching (the anchor itself sits ON furniture).
function npcNearestWalkable(c, r) {
  const seen = new Set([c + "," + r]);
  const q = [[c, r]];
  for (let i = 0; i < q.length && i < 900; i++) {
    const [cc, rr] = q[i];
    if (npcTileWalkable(cc, rr)) return [cc, rr];
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = (cc + dc) + "," + (rr + dr);
      if (!seen.has(k)) { seen.add(k); q.push([cc + dc, rr + dr]); }
    }
  }
  return null;
}

// BFS shortest tile path (4-dir) across WALKABLE. Runs per leg (~27k tiles,
// sub-millisecond) so the route self-heals across map edits — no baked paths.
function npcPath(from, to) {
  const key = (c, r) => r * MAP_W + c;
  const prev = new Map([[key(from[0], from[1]), -1]]);
  const q = [from];
  for (let i = 0; i < q.length; i++) {
    const [c, r] = q[i];
    if (c === to[0] && r === to[1]) {
      const path = [];
      let k = key(c, r);
      while (k !== -1) { path.push([k % MAP_W, Math.floor(k / MAP_W)]); k = prev.get(k); }
      return path.reverse();
    }
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc, nr = r + dr;
      if (!npcTileWalkable(nc, nr) || prev.has(key(nc, nr))) continue;
      prev.set(key(nc, nr), key(c, r));
      q.push([nc, nr]);
    }
  }
  return null;
}

// Park Huddles at the first reachable tour stop on boot (before any client
// connects), so the office never opens with the coach standing on the lawn.
if (WALKABLE) {
  for (const id of NPC_STOPS) {
    const o = OBJECTS[id];
    const t = o && npcNearestWalkable(...npcTileOf(o.x, o.y));
    if (t) { NPC.x = t[0] * TILE_PX + TILE_PX / 2; NPC.y = t[1] * TILE_PX + TILE_PX / 2 - BODY_DY; break; }
  }
} else {
  console.error("Huddles: no walkable mask (map load failed) — the coach stands still");
}

const npcSnapshot = () => ({
  id: NPC.id, name: NPC.name, character: NPC.character,
  hairIdx: NPC.hairIdx, skinIdx: NPC.skinIdx, shirtIdx: NPC.shirtIdx, pantsIdx: NPC.pantsIdx,
  x: Math.round(NPC.x), y: Math.round(NPC.y), dir: NPC.dir, anim: NPC.anim,
});

let npcLeg = null, npcLegIdx = 0, npcStopIdx = 0;
let npcDwellUntil = Date.now() + 10_000;
let npcLastTick = Date.now();

// Build the next leg from the CURRENT position to the next reachable stop.
// Recomputed live (not baked) so a skipped stop never strands the route.
function npcNextLeg() {
  if (!WALKABLE) return null;
  const from = npcNearestWalkable(...npcTileOf(NPC.x, NPC.y));
  if (!from) return null;
  for (let tries = 0; tries < NPC_STOPS.length; tries++) {
    npcStopIdx = (npcStopIdx + 1) % NPC_STOPS.length;
    const o = OBJECTS[NPC_STOPS[npcStopIdx]];
    if (!o) continue;
    const to = npcNearestWalkable(...npcTileOf(o.x, o.y));
    if (!to || (to[0] === from[0] && to[1] === from[1])) continue;
    const p = npcPath(from, to);
    if (p && p.length > 1) return p;
    console.error(`Huddles: no walkable path toward ${NPC_STOPS[npcStopIdx]} — stop skipped`);
  }
  return null;
}

setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.5, (now - npcLastTick) / 1000);
  npcLastTick = now;
  if (Object.keys(players).length === 0) return;   // empty office — the coach waits (and no pointless broadcasts)
  if (now < npcDwellUntil) return;
  if (!npcLeg) {
    npcLeg = npcNextLeg();
    npcLegIdx = 1;
    if (!npcLeg) { npcDwellUntil = now + 60_000; return; }   // nowhere to go — nap, retry later
  }
  const t = npcLeg[npcLegIdx];
  if (!t) {   // leg finished → dwell at this stop
    npcLeg = null;
    NPC.anim = "idle";
    npcDwellUntil = now + NPC_DWELL_MIN_MS + Math.random() * (NPC_DWELL_MAX_MS - NPC_DWELL_MIN_MS);
    io.emit("npcMoved", { x: Math.round(NPC.x), y: Math.round(NPC.y), dir: NPC.dir, anim: "idle" });
    return;
  }
  const tx = t[0] * TILE_PX + TILE_PX / 2, ty = t[1] * TILE_PX + TILE_PX / 2 - BODY_DY;
  const dx = tx - NPC.x, dy = ty - NPC.y;
  const dist = Math.hypot(dx, dy);
  const step = NPC_SPEED * dt;
  if (dist <= step) { NPC.x = tx; NPC.y = ty; npcLegIdx++; }
  else { NPC.x += (dx / dist) * step; NPC.y += (dy / dist) * step; }
  NPC.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
  NPC.anim = "walk";
  io.emit("npcMoved", { x: Math.round(NPC.x), y: Math.round(NPC.y), dir: NPC.dir, anim: "walk" });
}, NPC_TICK_MS);

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

// ── Huddles' daily connection missions ───────────────────────────────────────
// One mission per player per UTC day, aimed at creating NEW connections
// (v1: first-time pairings — the rematch/rivalry ladder is deliberately out).
// Every mission is SERVER-VERIFIABLE: duels settle through finishMatch, the
// whisper handler counts exchange facts (never content), coffee/snack moments
// reuse the group-radius scan. The AI only PICKS from this template allowlist
// using roster facts (index + first name + department + played-before flag —
// emails never leave the server); anything off-menu falls back to a
// deterministic mission so the coach keeps working with the AI down.
const MISSION_REWARD = 50;
const MISSION_TYPES = new Set(["play_new", "play_dept", "play_person", "whisper_person", "coffee_crowd"]);
const COACH_GOALS = {
  meet_new: "meet new people",
  more_games: "play more mini-games with coworkers",
  cross_team: "get to know other departments",
  coffee_buddies: "more coffee-break company",
};

let _openaiClient = null;   // lazy singleton; false = env vars missing (fallback-only mode)
function coachAiClient() {
  if (_openaiClient !== null) return _openaiClient;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL, apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  _openaiClient = baseURL && apiKey ? new OpenAI({ baseURL, apiKey }) : false;
  if (!_openaiClient) console.error("Huddles: AI integration env vars missing — deterministic fallback missions only");
  return _openaiClient;
}

function liveSocketIdByEmail(email) {
  for (const [sid, q] of Object.entries(players)) if (q.email === email) return sid;
  return null;
}

// Roster facts for mission generation: recently-active approved coworkers
// (entered the office within 14 days — last_daily_bonus is set on every
// first-entry-of-day) plus a played-before flag from the pair history.
async function coachCandidates(email) {
  const { rows } = await pool.query(
    `SELECT email, COALESCE(NULLIF(nickname,''), NULLIF(first_name,''), name) AS display, department
       FROM jpo_players
      WHERE approved = true AND dismissed = false AND email <> $1
        AND last_daily_bonus IS NOT NULL AND last_daily_bonus > CURRENT_DATE - 14
      ORDER BY last_daily_bonus DESC, updated_at DESC
      LIMIT 30`, [email]);
  const { rows: pairs } = await pool.query(
    `SELECT email_a, email_b FROM jpo_pair_plays WHERE email_a = $1 OR email_b = $1`, [email]);
  const played = new Set(pairs.map((r) => (r.email_a === email ? r.email_b : r.email_a)));
  return rows.map((r) => ({ email: r.email, name: r.display, dept: r.department || "", playedBefore: played.has(r.email) }));
}

function missionLabel(m) {
  switch (m?.type) {
    case "play_new":       return "Play a mini-game with someone you've never played before";
    case "play_dept":      return `Finish a mini-game with someone from ${m.dept}`;
    case "play_person":    return `Play a mini-game with ${m.target_name}`;
    case "whisper_person": return `Trade whispers with ${m.target_name} (one each way)`;
    case "coffee_crowd":   return `Have a coffee or snack with ${m.n}+ coworkers around you`;
    default:               return "";
  }
}

function missionClientView(mission, done, rerolled) {
  if (!mission) return null;
  return {
    label: missionLabel(mission), flavor: mission.flavor || "", type: mission.type,
    targetName: mission.target_name || null, dept: mission.dept || null, n: mission.n || null,
    reward: mission.reward || MISSION_REWARD, done: !!done, canReroll: !rerolled && !done,
  };
}

// Deterministic mission when the AI is down/slow/off-menu — same catalog,
// simple priority: fresh pairing > department mixer > whisper > coffee crowd.
function coachFallbackMission(cands, avoid) {
  const fresh = cands.filter((c) => !c.playedBefore);
  const options = [];
  if (fresh.length) options.push({ type: "play_new", flavor: "Break the ice — challenge someone brand new to a game today!" });
  const deptCount = {};
  for (const c of cands) if (c.dept) deptCount[c.dept] = (deptCount[c.dept] || 0) + 1;
  const bestDept = Object.keys(deptCount).sort((a, b) => deptCount[b] - deptCount[a])[0];
  if (bestDept) options.push({ type: "play_dept", dept: bestDept, flavor: `The ${bestDept} crew loves a challenger — go finish a game with one of them!` });
  const t = fresh[0] || cands[0];
  if (t) options.push({ type: "whisper_person", target_email: t.email, target_name: t.name, flavor: `Psst — ${t.name} could use a hello today. Trade whispers!` });
  options.push({ type: "coffee_crowd", n: 2, flavor: "Coffee tastes better together — grab one with at least 2 coworkers around you!" });
  const pick = options.find((o) => o.type !== avoid?.type) || options[options.length - 1];
  return { ...pick, reward: MISSION_REWARD, by: "fallback" };
}

// Ask the AI to pick ONE mission from the allowlist using facts only. The
// server rebuilds the mission from validated parts — the AI's only free text
// is `flavor`, which is control-stripped and length-capped. Throws on any
// off-menu answer; callers fall back deterministically.
async function coachAiMission(player, intake, cands, avoid) {
  const client = coachAiClient();
  if (!client || !cands.length) return null;
  const facts = {
    player: {
      name: player.name, department: player.department || "unknown",
      wants: COACH_GOALS[intake?.goal] || COACH_GOALS.meet_new,
      curiousAboutDepartments: Array.isArray(intake?.depts) ? intake.depts.slice(0, 3) : [],
    },
    coworkers: cands.map((c, i) => ({ i, name: c.name, department: c.dept || "unknown", playedBefore: c.playedBefore })),
    missionTypes: {
      play_new: "finish any mini-game duel with a coworker they have NEVER played before (no specific person)",
      play_dept: "finish a mini-game duel with anyone from one department (set dept)",
      play_person: "finish a mini-game duel with one specific coworker (set i)",
      whisper_person: "exchange private whispers with one specific coworker, one message each way (set i)",
      coffee_crowd: "have a coffee/snack moment while at least n coworkers stand nearby (set n: 2 or 3)",
    },
    ...(avoid ? { avoid: { type: avoid.type, name: avoid.target_name || null } } : {}),
  };
  const rsp = await Promise.race([
    client.chat.completions.create({
      model: "gpt-5.6-terra",
      max_completion_tokens: 8192,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You are Huddles, the upbeat connection coach in a virtual office. Pick ONE daily mission for this player that is most likely to spark a NEW coworker connection. Strongly prefer never-played pairings; respect what the player wants and the departments they're curious about; never pick the 'avoid' entry. Reply with ONLY a JSON object: {\"type\": string, \"i\": number?, \"dept\": string?, \"n\": number?, \"flavor\": string}. flavor = ONE friendly sentence (max 110 chars, at most 1 emoji) telling the player why this mission — mention only names from the coworkers list.",
        },
        { role: "user", content: JSON.stringify(facts) },
      ],
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("coach AI timeout (9s)")), 9000)),
  ]);
  const raw = rsp?.choices?.[0]?.message?.content || "";
  const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  if (!MISSION_TYPES.has(parsed.type)) throw new Error(`off-menu type ${parsed.type}`);
  const flavor = String(parsed.flavor || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 140);
  const m = { type: parsed.type, flavor, reward: MISSION_REWARD, by: "ai" };
  if (parsed.type === "play_person" || parsed.type === "whisper_person") {
    const c = cands[Number(parsed.i)];
    if (!c) throw new Error("candidate index out of range");
    m.target_email = c.email; m.target_name = c.name;
  } else if (parsed.type === "play_dept") {
    if (!DEPARTMENTS.includes(parsed.dept) || !cands.some((c) => c.dept === parsed.dept)) throw new Error("bad dept");
    m.dept = parsed.dept;
  } else if (parsed.type === "play_new") {
    if (!cands.some((c) => !c.playedBefore)) throw new Error("play_new impossible — everyone already played");
  } else if (parsed.type === "coffee_crowd") {
    m.n = Math.min(3, Math.max(2, Math.round(Number(parsed.n) || 2)));
  }
  if (!m.flavor) m.flavor = missionLabel(m);
  return m;
}

async function coachRow(email) {
  const { rows } = await pool.query(
    `SELECT intake, mission, rerolled,
            (mission_date = CURRENT_DATE) AS is_today,
            (mission_done_at IS NOT NULL) AS done
       FROM jpo_coach WHERE email = $1`, [email]);
  return rows[0] || null;
}

// Generate (or re-roll, when `avoid` is passed) today's mission. The
// conditional UPDATE is the farm-proof day gate — double E-presses, duplicate
// connections and restarts all funnel into ONE winning generation per day;
// losers read back whatever won. In-flight set stops duplicate AI calls.
const coachGenInFlight = new Set();

// Defense-in-depth damper on AI spend: even a modified client replaying coach
// events can burn at most COACH_AI_DAILY_CAP model calls per email per UTC day
// (legit use is 2: initial + re-roll). Over cap → deterministic fallback, so a
// real player is never blocked. In-memory on purpose — it is a cost damper,
// not a correctness gate (the day-gate UPDATE below is the correctness gate),
// and the map stays tiny (one entry per coach-curious email per process).
const coachAiSpend = new Map();   // email → { day, n }
const COACH_AI_DAILY_CAP = 6;

// coachIntake/coachReroll are follow-up form events, not E-presses — the NPC
// keeps strolling while the player fills the form, so a raw distance re-check
// would reject honest submits. Instead they require a recent proximity-verified
// talk (coachInteract stamps p.coachTalkAt only AFTER its distance check), which
// a remote script can't forge without actually walking to Huddles.
const COACH_SESSION_MS = 120000;
const coachSessionOk = (p) => p?.coachTalkAt && Date.now() - p.coachTalkAt < COACH_SESSION_MS;
function coachAiBudgetOk(email) {
  const today = new Date().toISOString().slice(0, 10);   // UTC, like mission_date
  const s = coachAiSpend.get(email);
  if (!s || s.day !== today) { coachAiSpend.set(email, { day: today, n: 1 }); return true; }
  if (s.n >= COACH_AI_DAILY_CAP) return false;
  s.n++;
  return true;
}

async function coachGenerateToday(p, avoid = null) {
  if (!p?.email || coachGenInFlight.has(p.email)) return;
  coachGenInFlight.add(p.email);
  try {
    const cur = await coachRow(p.email);
    if (!cur?.intake) return;   // no intake row — the panel will re-ask
    // Cheap idempotent path BEFORE any AI/candidate work: if today's mission
    // already stands (and this isn't a claimed re-roll), just re-emit it.
    // Replayed coachIntake/coachInteract events cost a SELECT, not a model call.
    if (!avoid && cur.is_today && cur.mission) {
      const sid0 = liveSocketIdByEmail(p.email);
      const live0 = sid0 ? players[sid0] : null;
      if (live0) { live0.coachMission = cur.mission; live0.coachDone = cur.done; }
      if (sid0) io.to(sid0).emit("coachMission", { mission: missionClientView(cur.mission, cur.done, cur.rerolled) });
      return;
    }
    const intake = cur.intake || {};
    const cands = await coachCandidates(p.email);
    let mission = null;
    if (cands.length && coachAiBudgetOk(p.email)) {
      try { mission = await coachAiMission(p, intake, cands, avoid); }
      catch (err) { console.error("Huddles AI generation failed — deterministic fallback:", err?.message || err); }
    }
    if (!mission) mission = coachFallbackMission(cands, avoid);
    const q = avoid
      ? `UPDATE jpo_coach SET mission = $2::jsonb, mission_date = CURRENT_DATE
          WHERE email = $1 AND mission_date = CURRENT_DATE AND mission_done_at IS NULL
          RETURNING mission, rerolled`
      : `UPDATE jpo_coach SET mission = $2::jsonb, mission_date = CURRENT_DATE, mission_done_at = NULL, rerolled = false
          WHERE email = $1 AND (mission_date IS DISTINCT FROM CURRENT_DATE OR mission IS NULL)
          RETURNING mission, rerolled`;
    const { rows } = await pool.query(q, [p.email, JSON.stringify(mission)]);
    let winner = rows[0]?.mission || null;
    let done = false, rerolled = rows[0] ? rows[0].rerolled : !!avoid;
    if (!winner) {   // lost the day-gate race (or a completion landed mid-reroll) — read what stands
      const cur = await coachRow(p.email);
      winner = cur?.is_today ? cur.mission : null;
      done = !!cur?.done; rerolled = !!cur?.rerolled;
    }
    const sid = liveSocketIdByEmail(p.email);
    const live = sid ? players[sid] : null;
    if (live && winner) { live.coachMission = winner; live.coachDone = done; }
    if (sid && winner) io.to(sid).emit("coachMission", { mission: missionClientView(winner, done, rerolled) });
    if (winner) console.log(`🎯 Huddles' mission for ${p.name} (${winner.by}): ${missionLabel(winner)}`);
  } catch (err) {
    console.error("coach mission generation failed:", err);
    const sid = liveSocketIdByEmail(p.email);
    if (sid) io.to(sid).emit("interactError", { message: "Huddles fumbled his clipboard — press E to try again." });
  } finally {
    coachGenInFlight.delete(p.email);
  }
}

// Atomic completion: the CTE flips mission_done_at (once — the WHERE guard
// makes replays no-ops) and pays the reward in the SAME statement, so a crash
// can never award twice or mark-done without paying.
async function coachComplete(email) {
  const { rows } = await pool.query(
    `WITH m AS (
       UPDATE jpo_coach SET mission_done_at = now()
        WHERE email = $1 AND mission_date = CURRENT_DATE AND mission IS NOT NULL AND mission_done_at IS NULL
        RETURNING email, mission
     )
     UPDATE jpo_players p SET coins = coins + $2, updated_at = now()
       FROM m WHERE p.email = m.email
       RETURNING p.coins, m.mission`,
    [email, MISSION_REWARD]);
  if (!rows[0]) return;
  const sid = liveSocketIdByEmail(email);
  const p = sid ? players[sid] : null;
  if (!p) return;   // reward is banked; they'll see it next login
  p.coins = rows[0].coins;
  p.coachDone = true;
  io.to(sid).emit("coinUpdate", { coins: p.coins });
  io.to(sid).emit("missionComplete", { label: missionLabel(rows[0].mission), reward: MISSION_REWARD, coins: p.coins });
  // Celebration over their head for everyone — with After Dark isolation
  // (a lit outsider's confetti must not reach alive crew in the dark; same
  // matching-light rule as chat/emotes/gymFx).
  const cheer = { id: sid, name: p.name };
  if (round && round.state === "active") {
    const dark = inTheDark(sid);
    for (const pid of Object.keys(players)) if (inTheDark(pid) === dark) io.to(pid).emit("missionCheer", cheer);
  } else {
    io.emit("missionCheer", cheer);
  }
  console.log(`🎯 ${p.name} completed Huddles' mission (+${MISSION_REWARD} coins)`);
}

// finishMatch hook (non-forfeit settles + draws): record the pair in the
// lifetime play history, then check both sides' play missions. Forfeits are
// deliberately NOT "playing together" — a dodged loss builds no connection.
async function coachDuelPlayed(aId, bId) {
  const a = players[aId], b = players[bId];
  if (!a?.email || !b?.email || a.email === b.email) return;
  const [ea, eb] = [a.email, b.email].sort();
  let gamesAfter = 0;
  try {
    const { rows } = await pool.query(
      `INSERT INTO jpo_pair_plays (email_a, email_b, games) VALUES ($1, $2, 1)
       ON CONFLICT (email_a, email_b) DO UPDATE SET games = jpo_pair_plays.games + 1, last_played_at = now()
       RETURNING games`, [ea, eb]);
    gamesAfter = rows[0]?.games || 0;
  } catch (err) { console.error("pair-play record failed:", err); return; }
  for (const [pl, opp] of [[a, b], [b, a]]) {
    const m = pl.coachMission;
    if (!m || pl.coachDone) continue;
    const hit = (m.type === "play_new" && gamesAfter === 1)
      || (m.type === "play_dept" && m.dept && opp.department === m.dept)
      || (m.type === "play_person" && m.target_email && opp.email === m.target_email);
    if (hit) coachComplete(pl.email).catch((err) => console.error("mission complete failed:", err));
  }
}

// Whisper-mission facts: per-day per-pair exchange counters, IN MEMORY ONLY —
// the content promise stays absolute (nothing about whispers is ever stored;
// a restart forgets today's counts and the pair just whispers again).
const whisperFacts = new Map();   // "YYYY-MM-DD|emailA|emailB" → {ab, ba}
function coachWhisperExchanged(senderId, targetId) {
  const s = players[senderId], t = players[targetId];
  if (!s?.email || !t?.email || s.email === t.email) return;
  const day = new Date().toISOString().slice(0, 10);
  const [ea, eb] = [s.email, t.email].sort();
  const key = `${day}|${ea}|${eb}`;
  if (whisperFacts.size > 4000) {
    for (const k of whisperFacts.keys()) if (!k.startsWith(day)) whisperFacts.delete(k);
  }
  const f = whisperFacts.get(key) || { ab: 0, ba: 0 };
  if (s.email === ea) f.ab++; else f.ba++;
  whisperFacts.set(key, f);
  if (f.ab < 1 || f.ba < 1) return;   // needs one message EACH way
  for (const [pl, other] of [[s, t], [t, s]]) {
    const m = pl.coachMission;
    if (m && !pl.coachDone && m.type === "whisper_person" && m.target_email === other.email)
      coachComplete(pl.email).catch((err) => console.error("mission complete failed:", err));
  }
}

// Coffee/snack-moment hook (machine brews, coffee items, rounds, free snacks,
// paid food): completes coffee_crowd when ≥n OTHER coworkers stand within the
// group radius — the same scan group consumables use.
function coachCoffeeMoment(socketId) {
  const p = players[socketId];
  const m = p?.coachMission;
  if (!p?.email || !m || p.coachDone || m.type !== "coffee_crowd") return;
  if (nearbyIds(socketId, GROUP_RADIUS).length - 1 >= (m.n || 2))
    coachComplete(p.email).catch((err) => console.error("mission complete failed:", err));
}

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
    petAcc:    row.equipped_pet_acc || "",
    items:     row.items || {},
    isAnnouncer: row.is_announcer,
    department:  row.department || "",
    // Lifetime per-game win counts (jsonb) + free-text hobby, both shown on
    // the profile card. Wins are updated via recordWin's RETURNING value.
    wins:        row.wins || {},
    hobby:       row.hobby || "",
    // Epoch ms of account creation, for the profile card's "joined" line.
    createdAt:   row.created_at ? new Date(row.created_at).getTime() : null,
  };
}

// Valid win-counter keys: the duel game ids + 'dark' for Office After
// Dark. An allowlist (not free-form) so a future typo can't mint a new
// untranslatable counter in everyone's rows.
const WIN_KEYS = new Set(["rps", "ttt", "qd", "ib", "wr", "trivia", "c4", "pool", "pong", "dark"]);

// Record one win. Email-backed → atomic jsonb increment in the DB (RETURNING
// refreshes the in-memory copy, so concurrent wins can't clobber each other);
// session-only → in-memory bump (same policy as their coins). `emailFallback`
// mirrors the After Dark payout's captured-email pattern: a winner who
// disconnects between the winners snapshot and this call still gets the win
// counted, exactly like they still get the coins. Fire-and-forget from
// settlement paths: a failed count must never block a payout, so callers
// .catch(log) instead of awaiting into their flow.
async function recordWin(socketId, gameKey, emailFallback = null) {
  if (!WIN_KEYS.has(gameKey)) return;
  const p = players[socketId];
  if (p && !p.email) {
    p.wins = p.wins || {};
    p.wins[gameKey] = (p.wins[gameKey] || 0) + 1;
    return;
  }
  const email = (p && p.email) || emailFallback;
  if (!email) return;
  const { rows } = await pool.query(
    `UPDATE jpo_players
        SET wins = jsonb_set(wins, ARRAY[$2], (COALESCE((wins->>$2)::int, 0) + 1)::text::jsonb),
            updated_at = now()
      WHERE email = $1
      RETURNING wins`,
    [email, gameKey],
  );
  const live = players[socketId];
  if (rows[0] && live && live.email === email) live.wins = rows[0].wins || {};
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
    // Settle any match the dropped session was in: an ACTIVE match is a
    // forfeit (the refresh-to-dodge-the-wager seam — the new session dropping
    // this old socket IS the refresh case). Usually the disconnect below
    // fires this anyway, but if the socket object is already gone there is
    // no disconnect event — this call is the safety net.
    forfeitMatchForLeave(id);
    // Same grace as a disconnect: the successor session for this email is
    // about to restore (login/resume/register all call restorePlayer next),
    // which rebinds the round spot. Paths with NO successor restore must call
    // roundLeaveGoneByEmail themselves (password reset, pending-queue exits).
    if (!roundDeferLeave(id)) roundHandleLeave(id);
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

  // Void rescue: a saved position that lands on an unpainted map tile (e.g. a
  // position stored under an older layout, restored after a map change went
  // live) would strand the player in the black nothing outside the building.
  // Respawn them on the grass by the west entrance instead, standing.
  if (isVoidPosition(state.x, state.y)) {
    state.x = GRASS_SPAWN.x; state.y = GRASS_SPAWN.y;
    state.dir = "down"; state.anim = "idle";
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
    petAcc:    state.petAcc || "",
    items:     state.items || {},
    x:         state.x,
    y:         state.y,
    // Restored pose: the client re-enters the seated pose from these instead of
    // spawning fresh — without them every refresh/build-stamp reload stood the
    // player up at spawn (and un-seated them for everyone watching).
    dir:       state.dir,
    anim:      state.anim === "sit" ? "sit" : "idle",
  });
  socket.emit("currentPlayers", players);
  socket.emit("announcerStatus", { canPost: state.isAnnouncer });
  socket.emit("announcements", await fetchAnnouncements());
  // Huddles: current NPC snapshot (the scene also pulls via npcSync at create,
  // covering the game-boots-after-this-emit ordering) + today's mission for
  // the HUD chip, so a refresh never loses the mission display.
  socket.emit("npcState", npcSnapshot());
  if (state.email) {
    coachRow(state.email).then((row) => {
      if (players[socket.id] !== state) return;   // already reconnected as a new socket
      if (row?.is_today && row.mission) {
        state.coachMission = row.mission;
        state.coachDone = row.done;
        socket.emit("coachStatus", { mission: missionClientView(row.mission, row.done, row.rerolled) });
      }
    }).catch((err) => console.error("coach status load failed:", err));
  }

  // Bid-store mail: deliver queued outcomes (won/refunded while offline) and
  // nudge sellers whose stalls collected bids overnight. Fire-and-forget —
  // login must never block on market bookkeeping.
  if (state.email) {
    (async () => {
      const { rows: msgs } = await pool.query(
        `DELETE FROM jpo_store_msgs WHERE email = $1 RETURNING message`, [state.email]);
      const { rows: cnt } = await pool.query(
        `SELECT count(*)::int AS n FROM jpo_store_bids b
           JOIN jpo_store_listings l ON l.id = b.listing_id
          WHERE l.seller_email = $1`, [state.email]);
      const messages = msgs.map((m) => m.message);
      if (cnt[0]?.n > 0) messages.push(`🏪 Your store has ${cnt[0].n} bid${cnt[0].n === 1 ? "" : "s"} waiting — check the Market tab!`);
      if (messages.length && players[socket.id] === state) socket.emit("storeToasts", { messages });
      // A queued "you won X" means the DB row gained an item while this
      // client was away — refresh its collection cache so the shop/market
      // tabs reflect it without a re-login.
      if (msgs.length) {
        const { rows } = await pool.query(`SELECT coins, cosmetics FROM jpo_players WHERE email = $1`, [state.email]);
        if (rows[0] && players[socket.id] === state) {
          state.coins = rows[0].coins; state.cosmetics = rows[0].cosmetics || [];
          socket.emit("coinUpdate", { coins: state.coins });
          socket.emit("collectionUpdate", { cosmetics: state.cosmetics });
        }
      }
    })().catch((err) => console.error("store mail failed:", err));
  }

  // Issue a resume token so this browser can auto-rejoin later (email-backed only).
  if (state.email) {
    const token = signToken(state.email);
    if (token) socket.emit("sessionToken", { token });
  }

  for (const pid in players) {
    if (pid !== socket.id) io.to(pid).emit("playerJoined", { id: socket.id, ...state });
  }

  // After Dark grace rebind: if this email holds a spot in the ACTIVE round
  // (marked `gone` by roundDeferLeave, or still keyed under an older socket id
  // that dropLiveByEmail just replaced), move the membership — role, aliveness,
  // per-killer cooldown — onto the new socket, tell every participant the id
  // swapped (roundRebind), and privately resend the full round state
  // (roundResume) so the refreshed client walks straight back into the dark.
  if (state.email && round && round.state === "active") {
    for (const [oldId, m] of round.members) {
      if (m.email !== state.email || oldId === socket.id) continue;
      round.members.delete(oldId);
      delete m.gone;
      round.members.set(socket.id, m);
      if (round.killerIds.delete(oldId)) round.killerIds.add(socket.id);
      if (round.killerNameOf?.has(oldId)) {
        round.killerNameOf.set(socket.id, round.killerNameOf.get(oldId));
        round.killerNameOf.delete(oldId);
      }
      // Swap broadcast FIRST (members now holds the new id, so the resumer
      // gets it too — harmless no-op there), then the private full state.
      roundEmitMembers("roundRebind", { oldId, newId: socket.id });
      const isKiller = round.killerIds.has(socket.id);
      socket.emit("roundResume", {
        role: isKiller ? "killer" : "crew",
        alive: !!m.alive,
        accomplices: isKiller
          ? [...round.killerIds].filter((k) => k !== socket.id).map((k) => ({ id: k, name: round.members.get(k)?.name || "?" }))
          : undefined,
        speedMult: isKiller ? ROUND_KILLER_SPEED_MULT : undefined,
        endsInMs: Math.max(0, round.endsAt - Date.now()),
        killCooldownMs: ROUND_KILL_COOLDOWN_MS,
        killRangePx: ROUND_KILL_RANGE_PX,
        players: roundRoster(),
        prize: ROUND_PRIZE,
      });
      console.log(`Office After Dark: ${m.name} resumed their round spot`);
      break;
    }
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
const GAMES      = new Set(["rps", "ttt", "qd", "ib", "wr", "trivia", "c4", "pool", "pong"]);
const GAME_NAMES = { rps: "Rock-Paper-Scissors", ttt: "Tic-Tac-Toe", qd: "Quick Draw", ib: "Icebreakers", wr: "Word Race", trivia: "Trivia Duel", c4: "Connect Four", pool: "Billiards", pong: "Ping Pong" };
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
const POOL_TARGET      = 5;      // Billiards: balls to sink to win
const POOL_TURN_MS     = 9_000;  // shot clock — the slow side forfeits (mirrors TTT)
const POOL_PERIOD_MS   = 1_150;  // one full meter sweep, 0 → 100 → 0
const POOL_SPOT_HW     = 9;      // sweet-spot half-width with 0 balls sunk…
const POOL_SPOT_MIN_HW = 5;      // …shrinking by 1 per sunk ball down to this
const POOL_BEAT_MS     = 900;    // result-flash pause between shots
const POOL_SKEW_MS     = 1_500;  // client-vs-server elapsed sanity window
const PONG_TARGET    = 5;        // Ping Pong: points to win
const PONG_TICK_MS   = 33;       // server sim/broadcast rate (~30 Hz)
const PONG_W         = 100;      // court units (client scales to pixels)
const PONG_H         = 60;
const PONG_PAD_X     = 4;        // paddle line inset (challenger left, target right)
const PONG_PAD_HH    = 7;        // paddle half-height
const PONG_PAD_SPEED = 115;      // paddle units/s toward the client's target y
const PONG_BALL_V0   = 58;       // serve speed, units/s…
const PONG_BALL_VMAX = 130;      // …capped here after per-hit speedups
const PONG_SPEEDUP   = 1.08;     // speed multiplier per paddle hit
const PONG_SERVE_MS  = 600;      // freeze after each point before the serve
const PONG_MAX_MS    = 240_000;  // hard cap: leader wins, tie = draw

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
  clearInterval(m.pongInterval);   // Ping Pong's sim loop rides the same seam
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

// A player LEFT (refresh, tab close, network drop, kick) with a match at
// stake. A pending challenge just cancels (nothing locked yet), but an ACTIVE
// match (picking/playing) settles as a FORFEIT by the leaver — the opponent
// takes the wager, exactly like the move-timeout forfeits. Without this, a
// losing player could refresh to dodge paying (live exploit, July 2026).
// Callers must invoke this BEFORE deleting players[id]: rpsSettle captures
// both player objects synchronously, so the coins move even though the
// leaver's session is being torn down. Deliberate-cancel paths (nobody
// picked / nobody drew / nobody answered) keep calling cancelMatchFor —
// those are mutual no-shows, not a leaver dodging a loss.
function forfeitMatchForLeave(id) {
  const m = rpsBySocket.get(id);
  if (!m) return;
  if (m.state === "pending") {
    cancelMatchFor(id, "They left the office — challenge cancelled.");
    return;
  }
  if (m.state !== "picking" && m.state !== "playing") return;   // settling/done: result stands
  finishMatch(m, {
    winnerId: rpsOtherId(m, id), loserId: id, forfeit: true,
    extras: () => ({ left: true }),
  }).catch((err) => console.error("leave-forfeit settle failed:", err));
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
    // A draw still counts as "played together" for pair history + missions
    // (the connection happened; only forfeits are excluded).
    coachDuelPlayed(cId, tId).catch((err) => console.error("coach duel hook failed:", err));
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
  // Lifetime win counter (profile card / leaderboard). Fire-and-forget: a
  // failed count must never affect the already-settled match.
  recordWin(winnerId, m.game).catch((err) => console.error("recordWin failed:", err));
  // Pair history + play missions — NOT on forfeits (dodging a loss by leaving
  // or timing out is no connection; see task rules). Win, lose or draw count.
  if (!forfeit) coachDuelPlayed(winnerId, loserId).catch((err) => console.error("coach duel hook failed:", err));
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

// ── Billiards helpers ────────────────────────────────────────────────────────
// Turn-based trick shots: the server picks a sweet spot on a 0–100 meter, the
// shooter's client animates the SAME triangle-wave sweep (poolMeterPos must
// stay in lockstep with the client's copy) and reports its elapsed ms at tap
// time. Client elapsed is trusted inside POOL_SKEW_MS of the server's own
// clock — outside the window the server's elapsed is used instead, so lag
// never punishes, and a hacked client could at worst aim perfectly (accepted
// for an office game; same residual class as banked-teleport movement).
// Sink = shoot again (like real pool); miss = the cue passes. Shot-clock
// expiry = forfeit by the slow side (TTT pattern).
function poolMeterPos(elapsedMs) {
  const phase = (elapsedMs % POOL_PERIOD_MS) / POOL_PERIOD_MS;
  return (phase < 0.5 ? phase * 2 : 2 - phase * 2) * 100;
}
function poolHalfWidth(score) { return Math.max(POOL_SPOT_MIN_HW, POOL_SPOT_HW - score); }
function poolExtras(m) {
  return (me, them) => ({ scores: { you: m.poolScores[me] ?? 0, them: m.poolScores[them] ?? 0 } });
}
function poolTimeout(m) {
  if (m.state !== "playing" || m.game !== "pool") return;
  const slow = m.poolTurn, fast = rpsOtherId(m, slow);
  finishMatch(m, { winnerId: fast, loserId: slow, forfeit: true, extras: poolExtras(m) })
    .catch((err) => console.error("pool timeout resolve failed:", err));
}
// Arm the next shot: new sweet spot, fresh shot clock, new meter epoch.
// poolTurn is null during the between-shots beat (set in the poolShot
// handler), so a spammed tap can't double-fire before the next arm.
function poolNextTurn(m, shooterId) {
  if (m.state !== "playing" || m.game !== "pool") return;
  m.poolTurn = shooterId;
  m.poolTurnAt = Date.now();
  m.poolSpot = 20 + Math.floor(Math.random() * 61);   // center ∈ [20, 80]
  m.moveTimer = setTimeout(() => poolTimeout(m), POOL_TURN_MS);
  for (const id of [m.challengerId, m.targetId]) {
    io.to(id).emit("poolState", {
      challengeId: m.id, yourTurn: id === shooterId,
      scores: { you: m.poolScores[id] ?? 0, them: m.poolScores[rpsOtherId(m, id)] ?? 0 },
      spotCenter: m.poolSpot, spotHalf: poolHalfWidth(m.poolScores[shooterId] ?? 0),
      periodMs: POOL_PERIOD_MS, turnMs: POOL_TURN_MS, target: POOL_TARGET,
    });
  }
}

// ── Ping Pong helpers ────────────────────────────────────────────────────────
// The only real-time duel: the server runs an authoritative ~30 Hz sim per
// match (pongInterval — cleared by clearMatchTimers like every other match
// timer) and broadcasts the full court each tick (2 players, tiny payload).
// Clients only send a target paddle y; the server walks the paddle toward it
// at a capped speed, so no input can teleport a paddle. First to PONG_TARGET
// wins; PONG_MAX_MS is a hard cap (leader wins, tie = draw) so an idle match
// can't run forever. Serve goes toward the player who just conceded.
function pongExtras(m) {
  return (me, them) => ({ scores: { you: m.pongScore[me] ?? 0, them: m.pongScore[them] ?? 0 } });
}
function pongServe(m, towardId) {
  m.pongBall = { x: PONG_W / 2, y: PONG_H / 2 };
  const dir = towardId === m.challengerId ? -1 : 1;
  const angle = (Math.random() * 0.6 - 0.3) * Math.PI;   // up to ±54° off horizontal
  m.pongVel = { x: dir * PONG_BALL_V0 * Math.cos(angle), y: PONG_BALL_V0 * Math.sin(angle) };
  m.pongFreezeUntil = Date.now() + PONG_SERVE_MS;
}
function pongPoint(m, scorerId, concederId) {
  const s = (m.pongScore[scorerId] ?? 0) + 1;
  m.pongScore[scorerId] = s;
  if (s >= PONG_TARGET) {
    finishMatch(m, { winnerId: scorerId, loserId: concederId, extras: pongExtras(m) })
      .catch((err) => console.error("pong resolve failed:", err));
    return;
  }
  pongServe(m, concederId);
}
function pongTick(m) {
  // Belt-and-braces: finishMatch/cancelMatchFor already clear the interval.
  if (m.state !== "playing" || m.game !== "pong") { clearInterval(m.pongInterval); return; }
  const now = Date.now();
  const dt = Math.min(0.1, (now - m.pongLastTick) / 1000);
  m.pongLastTick = now;
  if (now - m.pongStartAt > PONG_MAX_MS) {
    const c = m.pongScore[m.challengerId] ?? 0, t = m.pongScore[m.targetId] ?? 0;
    const opts = c === t ? { draw: true, extras: pongExtras(m) }
      : c > t ? { winnerId: m.challengerId, loserId: m.targetId, extras: pongExtras(m) }
              : { winnerId: m.targetId, loserId: m.challengerId, extras: pongExtras(m) };
    finishMatch(m, opts).catch((err) => console.error("pong cap resolve failed:", err));
    return;
  }
  // Paddles glide toward each side's latest requested y at a capped speed.
  for (const id of [m.challengerId, m.targetId]) {
    const cur = m.pongPad[id], tgt = m.pongPadTarget[id];
    const maxStep = PONG_PAD_SPEED * dt;
    m.pongPad[id] = Math.abs(tgt - cur) <= maxStep ? tgt : cur + Math.sign(tgt - cur) * maxStep;
  }
  const b = m.pongBall, v = m.pongVel;
  if (now >= m.pongFreezeUntil) {
    b.x += v.x * dt; b.y += v.y * dt;
    if (b.y < 0)      { b.y = -b.y;            v.y = Math.abs(v.y); }
    if (b.y > PONG_H) { b.y = 2 * PONG_H - b.y; v.y = -Math.abs(v.y); }
    const speedUp = () => {
      const s = Math.min(PONG_BALL_VMAX, Math.hypot(v.x, v.y) * PONG_SPEEDUP);
      const a = Math.atan2(v.y, v.x);
      v.x = s * Math.cos(a); v.y = s * Math.sin(a);
    };
    // Reach zone scales with per-tick travel so a fast ball can't tunnel
    // through the paddle line between ticks.
    const reach = Math.max(4, Math.abs(v.x) * dt + 1);
    const padC = m.pongPad[m.challengerId], padT = m.pongPad[m.targetId];
    const rightX = PONG_W - PONG_PAD_X;
    if (v.x < 0 && b.x <= PONG_PAD_X && b.x > PONG_PAD_X - reach &&
        Math.abs(b.y - padC) <= PONG_PAD_HH + 1.5) {
      b.x = PONG_PAD_X + (PONG_PAD_X - b.x);
      v.x = Math.abs(v.x);
      v.y += (b.y - padC) * 2.5;   // edge hits add spin, center hits return flat
      speedUp();
    } else if (v.x > 0 && b.x >= rightX && b.x < rightX + reach &&
        Math.abs(b.y - padT) <= PONG_PAD_HH + 1.5) {
      b.x = rightX - (b.x - rightX);
      v.x = -Math.abs(v.x);
      v.y += (b.y - padT) * 2.5;
      speedUp();
    } else if (b.x < -3) {
      pongPoint(m, m.targetId, m.challengerId);
    } else if (b.x > PONG_W + 3) {
      pongPoint(m, m.challengerId, m.targetId);
    }
  }
  if (m.state !== "playing") return;   // pongPoint may have settled the match
  const r1 = (n) => Math.round(n * 10) / 10;
  const state = {
    challengeId: m.id, bx: r1(b.x), by: r1(b.y),
    pl: r1(m.pongPad[m.challengerId]), pr: r1(m.pongPad[m.targetId]),
    sl: m.pongScore[m.challengerId] ?? 0, sr: m.pongScore[m.targetId] ?? 0,
    frozen: now < m.pongFreezeUntil,
  };
  io.to(m.challengerId).emit("pongState", state);
  io.to(m.targetId).emit("pongState", state);
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
          [p.email, Math.round(p.x ?? GRASS_SPAWN.x), Math.round(p.y ?? GRASS_SPAWN.y), p.dir || "down", p.anim === "sit" ? "sit" : "idle", rate],
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
// Round state references LIVE SOCKETS, but email-backed members of the ACTIVE
// round get the SAME ~10s grace as the player session: a refresh/blip marks
// them `gone` (roundDeferLeave) and restorePlayer rebinds the spot onto the
// new socket — only grace EXPIRY (or an explicit exit: kick, purge, password
// reset, pending-queue ends) applies the leave rules. The lobby ('joining')
// and session-only players keep the immediate-leave rule. Nothing is
// persisted: a server restart cancels the round harmlessly (clients clear all
// round UI on the socket 'disconnect' event, so no stuck darkness).
// SECRECY RULE: the killer's identity is sent ONLY to the killer (their own
// `role` in roundBegin) until roundEnd reveals it to all participants. Kill
// broadcasts carry only the victim. Keep it that way.
// ROUND_JOIN_MS / ROUND_DURATION_MS accept env overrides — TEST KNOBS ONLY
// (headless integration tests can't wait 3 real minutes); never set in prod.
const ROUND_JOIN_MS          = Math.max(3_000,  Number(process.env.ROUND_JOIN_MS) || 30_000);
const ROUND_DURATION_MS      = Math.max(10_000, Number(process.env.ROUND_DURATION_MS) || 360_000);
// Total hold on a gone member's round spot, measured from the disconnect. Must
// exceed GRACE_MS: a real browser reload gates `resumeSession` on the Phaser
// scene being up (map + 13 tilesets), which on slow machines takes longer than
// the 10s session grace — exactly the deploy force-reload case the round-grace
// seam exists for. The sprite still vanishes at GRACE_MS (session UX is
// unchanged); only the round MEMBERSHIP survives until this deadline.
const ROUND_REJOIN_MS        = Math.max(12_000, Number(process.env.ROUND_REJOIN_MS) || 45_000);
const ROUND_MIN_PLAYERS      = 3;
const ROUND_KILL_RANGE_PX    = 200;     // ~4 tiles at render scale 3 (well under RPS_RANGE_PX)
// Desync slack for the server-side kill check ONLY (never advertised to the
// client). The killer's server position is fed by throttled playerMoves, so it
// lags their on-screen position while they're walking; without slack, a kill
// the client's own range check legitimately offered gets rejected "Get
// closer…" mid-chase. The client still targets at ROUND_KILL_RANGE_PX.
const ROUND_KILL_SLACK_PX    = 80;
// Between kills AND the arm delay before the first one. 0 = strike instantly
// (owner-requested); the roundBucket token limiter still caps kill spam, and
// the client-side `|| fallback` seams must treat 0 as a real value.
const ROUND_KILL_COOLDOWN_MS = 0;
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
const ROUND_KILLER_SPEED_MULT = 1.3;

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
// need it for the kill affordance, 💀 flashes, and spectator rendering).
// Grace-window ghosts (members marked `gone`) stay listed on purpose: their
// frozen avatar is still visible AND killable (roundKill falls back to the
// grace-entry position), so disconnecting can't dodge the knife.
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
  // Email from the member record first: a grace-window survivor (disconnected
  // but holding their spot) has no players[] entry left, yet still earned the
  // payout — the UPDATE-by-email path pays them while offline.
  const winners = winnerPairs.map(([id, m]) => ({ id, name: m.name, email: m.email || players[id]?.email || null }));

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
    // After Dark win counter ('dark') — same fire-and-forget policy as duels;
    // w.email lets a winner who just disconnected still get the win counted.
    recordWin(w.id, "dark", w.email).catch((err) => console.error("recordWin (dark) failed:", err));
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

// Round grace: an email-backed participant of the ACTIVE round who disconnects
// keeps their spot for the same ~10s window the player session gets — a
// refresh, a network blip, or the BUILD_STAMP force-reload every publish
// triggers must never hand the killers a win (the "killers won while crew
// survived" report: the last crew member's reload counted as an instant
// leave). The member is marked `gone` (still in members, still counted alive
// by aliveCrewCount, frozen sprite still visible via the session grace);
// restorePlayer rebinds the spot onto the new socket, and grace expiry
// applies the old leave rules (the grace timer calls roundHandleLeave).
// Session-only players and the 'joining' lobby keep the immediate-leave rule.
function roundDeferLeave(id) {
  if (!round || round.state !== "active" || !round.members.has(id)) return false;
  const m = round.members.get(id);
  if (!m.email) return false;         // session-only: no durable identity to rebind
  m.gone = true;
  return true;
}

// Session grace expired without a resume, but a slow reload may STILL be
// booting (resumeSession waits for the Phaser scene). Hold the round spot for
// the remainder of ROUND_REJOIN_MS, then apply the old leave rules. The stale
// timer is harmless by construction: socket ids are unique per connection, so
// a later round can never key a member under this oldId — the `gone` check on
// the CURRENT round's member is the only guard needed (a rebound member sits
// under a new id; a settled round fails the members lookup).
function roundScheduleGoneLeave(oldId) {
  const m = round?.members?.get(oldId);
  if (!m || !m.gone) { roundHandleLeave(oldId); return; }
  setTimeout(() => {
    const cur = round?.members?.get(oldId);
    if (cur && cur.gone) roundHandleLeave(oldId);
  }, Math.max(0, ROUND_REJOIN_MS - GRACE_MS));
}

// Cleanup hook for every path that cancels a grace hold WITHOUT a restore
// following (admin password reset, auth flows that end back in the pending
// queue, purge): the deferred member is never coming back — leave NOW.
function roundLeaveGoneByEmail(email) {
  if (!round || !email) return;
  for (const [id, m] of round.members) {
    if (m.email === email && m.gone) { roundHandleLeave(id); return; }
  }
}

// ── Push-to-talk proximity voice (WebRTC signaling switchboard) ──────────────
// Voice audio NEVER touches this server: peers stream directly to each other
// (STUN-only WebRTC, same privacy stance as whispers — nothing recorded,
// nothing stored). The server is a validating relay for the SDP/ICE handshake
// plus the 🎙 talking badge, and that validation IS the anti-cheat: it refuses
// to introduce two players who aren't actually within earshot on the same side
// of the After Dark light/dark split, so a modified client can't broker itself
// an ear across the map. Handshake payloads are relayed opaquely (never parsed
// as SDP) under a hard size cap. The NPC can never join a call: it lives
// outside `players`, so voicePairOk fails on it by construction.
const VOICE_RANGE_PX = 480;     // earshot — same "walk up to someone" reach as RPS_RANGE_PX
const VOICE_SLACK_PX = 260;     // relay slack: two 50ms position streams + the client's 620px drop hysteresis
const VOICE_SIG_MAX  = 40_000;  // bytes (JSON-encoded) — a full SDP offer runs ~4-8KB
const VOICE_ICE_MAX  = 4_000;   // bytes — a single ICE candidate runs well under 1KB

function voicePairOk(aId, bId) {
  const a = players[aId], b = players[bId];
  if (!a || !b) return false;
  // Voice is BIDIRECTIONAL, so unlike chat's one-way rule the pair must sit on
  // the SAME side of the light/dark split — a lit observer paired with an
  // alive member would be a live position-callout channel into the dark.
  if (inTheDark(aId) !== inTheDark(bId)) return false;
  const dx = (a.x ?? 0) - (b.x ?? 0), dy = (a.y ?? 0) - (b.y ?? 0);
  const r = VOICE_RANGE_PX + VOICE_SLACK_PX;
  return dx * dx + dy * dy <= r * r;
}

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  // Build handshake — how "everyone gets the fix" works without chasing
  // people down: the client compares this stamp to the one baked into its
  // page and reloads itself on mismatch (new-code tabs). Tabs too old to
  // even KNOW the handshake can't self-reload, so after a grace period
  // they get a visible nag toast instead (re-armed on every reconnect, so
  // it keeps nudging until they refresh). Once every tab has handshake
  // code this toast becomes dead weight that never fires — by design.
  let clientBuildSeen = false, staleNagRepeat = null;
  socket.emit("buildStamp", { stamp: String(BUILD_STAMP) });
  socket.on("clientBuild", () => { clientBuildSeen = true; if (staleNagRepeat) clearInterval(staleNagRepeat); });
  const nagStale = () => {
    if (clientBuildSeen || !socket.connected) { if (staleNagRepeat) clearInterval(staleNagRepeat); return; }
    socket.emit("interactError", { message: "🎙️ The office got an update — press F5 / refresh this page to grab it!" });
  };
  // One toast is easy to miss mid-game: nag at 5s, then once a minute until
  // they actually refresh (a handshaking client never sees any of this).
  const staleNag = setTimeout(() => { nagStale(); staleNagRepeat = setInterval(nagStale, 60000); }, 5000);
  socket.once("disconnect", () => { clearTimeout(staleNag); if (staleNagRepeat) clearInterval(staleNagRepeat); });

  // Live prices: send the full current price map on every connect so the
  // shop labels are right even after an admin price change (drift only ever
  // mislabels the UI — the server stays authoritative on every buy).
  socket.emit("priceList", allPrices());

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
  const voiceSigBucket  = makeBucket(80, 150); // WebRTC handshakes burst (~15 msgs × several peers entering a crowd), then go quiet
  const voiceTalkBucket = makeBucket(8, 600);  // 🎙 badge flips + the 4s keepalive while the key is held
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
    let em = "";   // hoisted: the failure exits below need it for round-spot cleanup
    try {
      const { firstName, lastName, nickname, email, password, character, hairIdx, skinIdx, shirtIdx, pantsIdx, clothesIdx, department } = payload || {};
      const fn   = (firstName || "").trim().slice(0, 20) || "Guest";
      const ln   = (lastName  || "").trim().slice(0, 20);
      const nick = (nickname  || "").trim().slice(0, 16) || fn;
      em = (email || "").trim().slice(0, 80).toLowerCase();
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
            // dropLiveByEmail above parked the old session's round spot as
            // `gone` expecting OUR restore to rebind it — this exit has no
            // successor, so apply the old leave rules now (no-op if none).
            roundLeaveGoneByEmail(em);
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
      // If dropLiveByEmail already parked a round spot as `gone`, no restore
      // is coming — release it under the old leave rules (no-op otherwise).
      roundLeaveGoneByEmail(em);
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
    let em = "";   // hoisted: the catch below needs it for round-spot cleanup
    try {
      em = (email || "").trim().slice(0, 80).toLowerCase();
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
        roundLeaveGoneByEmail(em);   // ends in the pending queue, not a restore — the deferred round spot leaves now
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
      // If dropLiveByEmail already parked a round spot as `gone` (e.g.
      // restorePlayer threw), no rebind is coming — release it now.
      roundLeaveGoneByEmail(em);
      socket.emit("loginFailed", { message: "Something went wrong — try again." });
    }
  });

  // ── Resume (auto-rejoin with a signed token) ──────────────────────────
  // A returning browser sends its stored token instead of re-filling the form.
  // We validate it, look up the durable row, and either drop them straight back
  // into the office (approved) or back into the waiting queue (not approved).
  socket.on("resumeSession", async (payload) => {
    const { token } = payload || {};
    let em = "";   // hoisted: the catch below needs it for round-spot cleanup
    try {
      const data = verifyToken(token);
      if (!data) { socket.emit("resumeFailed"); return; }
      em = data.email;

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
        roundLeaveGoneByEmail(em);   // ends in the pending queue, not a restore — the deferred round spot leaves now
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
      // If dropLiveByEmail already parked a round spot as `gone` (e.g.
      // restorePlayer threw), no rebind is coming — release it now.
      roundLeaveGoneByEmail(em);
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
    // A refreshed host (silent re-auth) gets their bingo host controls back.
    if (bingo && bingo.state === "active") {
      socket.emit("adminBingoResult", { ok: true, mode: bingo.mode, active: true, message: `Bingo is live (${bingo.mode} calling).` });
    }
  });

  // ── Admin: live shop price control ───────────────────────────────────
  // Persists to jpo_shop_prices, updates the in-memory catalog (every buy
  // handler reads it), and broadcasts the new label to every open client.
  // Setting an item back to its shipped default deletes the override row.
  socket.on("adminSetPrice", async (payload) => {
    if (!admins.has(socket.id)) return;
    const { item, price } = payload || {};
    if (typeof item !== "string") return;
    const cat = catalogOf(item);
    if (!cat) { socket.emit("adminPriceResult", { ok: false, message: "Unknown item." }); return; }
    const p = Math.round(Number(price));
    if (!Number.isInteger(p) || p < PRICE_MIN || p > PRICE_MAX) {
      socket.emit("adminPriceResult", { ok: false, message: `Price must be ${PRICE_MIN}–${PRICE_MAX.toLocaleString()} coins.` });
      return;
    }
    try {
      if (p === DEFAULT_PRICES[item]) {
        await pool.query(`DELETE FROM jpo_shop_prices WHERE item_id = $1`, [item]);
      } else {
        await pool.query(
          `INSERT INTO jpo_shop_prices (item_id, price) VALUES ($1, $2)
           ON CONFLICT (item_id) DO UPDATE SET price = $2`,
          [item, p],
        );
      }
      cat[item] = p;
      io.emit("priceUpdate", { item, price: p });
      socket.emit("adminPriceResult", { ok: true, message: `${item} is now ${p.toLocaleString()} coins${p === DEFAULT_PRICES[item] ? " (default)" : ""}.` });
      console.log(`ADMIN price change: ${item} → ${p}`);
    } catch (err) {
      console.error("adminSetPrice failed:", err);
      socket.emit("adminPriceResult", { ok: false, message: "Saving the price failed — try again." });
    }
  });

  // ── Admin: office-wide banner ─────────────────────────────────────────
  // Set = replaces the current banner on every screen (until each person
  // dismisses it); empty text = clear it everywhere.
  socket.on("adminBanner", (payload) => {
    if (!admins.has(socket.id)) return;
    const text = String(payload?.text ?? "").trim().slice(0, 300);
    if (!text) {
      adminBanner = null;
      io.emit("bannerUpdate", { banner: null });
      socket.emit("adminPriceResult", { ok: true, message: "Banner cleared." });
      console.log("ADMIN banner cleared");
      return;
    }
    adminBanner = { id: ++bannerSeq, text, ts: Date.now() };
    io.emit("bannerUpdate", { banner: adminBanner });
    socket.emit("adminPriceResult", { ok: true, message: "Banner is up on every screen." });
    console.log(`ADMIN banner: ${text.slice(0, 60)}`);
  });

  // Client asks for current office state on (re)connect: banner + a bingo
  // card resync if their email is already in the running game.
  socket.on("uiSync", () => {
    if (!takeToken(profileBucket)) return;   // cheap, but don't let a hacked client turn it into a broadcast pump
    socket.emit("bannerUpdate", { banner: adminBanner });
    const em = players[socket.id]?.email;
    if (bingo && em && bingo.players.has(em)) {
      const bp = bingo.players.get(em);
      socket.emit("bingoCard", { gameId: bingo.id, card: bp.card, daubs: [...bp.daubs], called: bingo.called, prize: bingo.prize, state: bingo.state, mode: bingo.mode, msLeft: bingo.state === "joining" ? Math.max(0, bingo.joinDeadline - Date.now()) : 0 });
      if (admins.has(socket.id)) {
        socket.emit("adminBingoResult", { ok: true, mode: bingo.mode, active: true, phase: bingo.state, message: bingo.state === "active" ? `Bingo is live (${bingo.mode} calling).` : "Bingo lobby is open — game starts soon." });
      }
    } else if (bingo && bingo.state === "joining") {
      socket.emit("bingoLobby", { gameId: bingo.id, prize: bingo.prize, msLeft: Math.max(0, bingo.joinDeadline - Date.now()) });
    }
  });

  // ── Admin: Office Bingo ───────────────────────────────────────────────
  socket.on("adminBingoStart", (payload) => {
    if (!admins.has(socket.id)) return;
    if (bingo) { socket.emit("adminBingoResult", { ok: false, message: "A bingo game is already running." }); return; }
    if (round) { socket.emit("adminBingoResult", { ok: false, message: "Office After Dark is running — wait for the round to end." }); return; }
    const prize = Math.round(Number(payload?.prize));
    if (!Number.isSafeInteger(prize) || prize < BINGO_PRIZE_MIN || prize > BINGO_PRIZE_MAX) {
      socket.emit("adminBingoResult", { ok: false, message: `Prize must be ${BINGO_PRIZE_MIN}–${BINGO_PRIZE_MAX.toLocaleString()} coins.` });
      return;
    }
    const mode = payload?.mode === "manual" ? "manual" : "auto";
    const pool = Array.from({ length: 75 }, (_, i) => i + 1);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    bingo = {
      id: ++bingoGameSeq, state: "joining", mode, prize, players: new Map(), pool, called: [],
      joinDeadline: Date.now() + BINGO_JOIN_MS,
      joinTimer: setTimeout(bingoBegin, BINGO_JOIN_MS), callTimer: null,
    };
    io.emit("bingoLobby", { gameId: bingo.id, prize, msLeft: BINGO_JOIN_MS });
    socket.emit("adminBingoResult", { ok: true, mode, active: true, phase: "joining", message: `Bingo announced (${mode === "manual" ? "YOU call the numbers" : "auto-calling"}) — ${prize.toLocaleString()} coin prize, ${BINGO_JOIN_MS / 1000}s to join.` });
    console.log(`ADMIN bingo start: prize ${prize}, ${mode}`);
  });
  socket.on("adminBingoCancel", () => {
    if (!admins.has(socket.id) || !bingo) return;
    const gameId = bingo.id;
    bingoStop();
    io.emit("bingoOver", { gameId, winnerName: null, message: "Bingo was cancelled by the office." });
    socket.emit("adminBingoResult", { ok: true, message: "Bingo cancelled." });
    console.log("ADMIN bingo cancelled");
  });
  // Host mode: the admin deals the next ball by hand.
  socket.on("adminBingoCall", () => {
    if (!admins.has(socket.id)) return;
    if (!bingo || bingo.state !== "active") { socket.emit("adminBingoResult", { ok: false, message: "No active game to call for." }); return; }
    if (bingo.mode !== "manual") { socket.emit("adminBingoResult", { ok: false, message: "Auto-calling is on — switch to manual first." }); return; }
    bingoCallNext();
    if (bingo) {
      const last = bingo.called[bingo.called.length - 1];
      socket.emit("adminBingoResult", { ok: true, mode: "manual", active: true, phase: "active", message: `Called ${"BINGO"[Math.floor((last - 1) / 15)]}-${last} (${bingo.called.length}/75).` });
    }
  });
  // Flip auto ↔ manual mid-game (e.g. host goes AFK → let it run itself).
  socket.on("adminBingoMode", (payload) => {
    if (!admins.has(socket.id) || !bingo) return;
    const mode = payload?.mode === "manual" ? "manual" : "auto";
    bingoSetMode(mode);
    socket.emit("adminBingoResult", { ok: true, mode, active: true, phase: bingo.state, message: mode === "auto" ? "Auto-calling ON — a ball every few seconds." : "Manual mode — press “Call next ball” to deal." });
    console.log(`ADMIN bingo mode: ${mode}`);
  });

  socket.on("bingoJoin", () => {
    const p = players[socket.id];
    if (!p?.email || !bingo || bingo.state !== "joining") return;
    if (!takeToken(interactBucket)) return;
    if (bingo.players.has(p.email)) return;
    const card = makeBingoCard();
    bingo.players.set(p.email, { name: p.name, card, daubs: new Set() });
    socket.emit("bingoCard", { gameId: bingo.id, card, daubs: [], called: [], prize: bingo.prize, state: "joining", mode: bingo.mode, msLeft: Math.max(0, bingo.joinDeadline - Date.now()) });
    console.log(`BINGO join: ${p.name} (${bingo.players.size} in)`);
  });

  // Manual daub only — no auto-marking. A daub must be a number that's on
  // YOUR card and has actually been called.
  socket.on("bingoDaub", (payload) => {
    const p = players[socket.id];
    const em = p?.email;
    if (!em || !bingo || bingo.state !== "active" || !bingo.players.has(em)) return;
    const n = Math.round(Number(payload?.n));
    if (!Number.isSafeInteger(n)) return;
    const bp = bingo.players.get(em);
    if (!bingo.called.includes(n) || !bp.card.some((row) => row.includes(n))) return;
    bp.daubs.add(n);
    socket.emit("bingoDaubOk", { n });
  });

  socket.on("bingoClaim", async () => {
    const p = players[socket.id];
    const em = p?.email;
    if (!em || !bingo || bingo.state !== "active" || !bingo.players.has(em)) return;
    if (!takeToken(interactBucket)) return;
    const bp = bingo.players.get(em);
    const line = bingoHasLine(bp.card, bp.daubs);
    if (!line) { socket.emit("bingoError", { message: "Not a bingo yet — keep daubing!" }); return; }
    // Winner! Freeze the game synchronously (no await before bingoStop) so a
    // racing second claim loses. Capture what we need, then pay, THEN announce
    // — the announcement must reflect what actually happened in the DB, and it
    // carries the gameId so it can never clobber a newer game's UI.
    const { prize, id: gameId } = bingo;
    const winnerName = bp.name;
    bingoStop();
    let paid = false;
    for (let attempt = 0; attempt < 2 && !paid; attempt++) {
      try {
        const { rows } = await pool.query(
          `UPDATE jpo_players SET coins = coins + $2, updated_at = now() WHERE email = $1 RETURNING coins`,
          [em, prize]);
        if (rows.length) {
          paid = true;
          if (players[socket.id]?.email === em) {
            players[socket.id].coins = rows[0].coins;
            socket.emit("coinUpdate", { coins: rows[0].coins });
          }
        }
      } catch (err) { console.error(`bingo payout attempt ${attempt + 1} failed:`, err); }
    }
    if (paid) {
      io.emit("bingoOver", { gameId, winnerName, prize, line, message: `🎉 BINGO! ${winnerName} wins ${prize.toLocaleString()} coins (${line})!` });
      console.log(`BINGO winner: ${winnerName} +${prize} (${line})`);
    } else {
      io.emit("bingoOver", { gameId, winnerName: null, message: `${winnerName} hit a valid bingo, but the prize payout failed — an admin needs to award the ${prize.toLocaleString()} coins manually.` });
      console.error(`BINGO PAYOUT FAILED for ${em} (+${prize}) — award manually`);
    }
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
          x: GRASS_SPAWN.x, y: GRASS_SPAWN.y, dir: "down", anim: "idle",
          name: reg.nickname || reg.firstName || reg.name, fullName: reg.name,
          email: "", character: reg.character,
          hairIdx: reg.hairIdx, skinIdx: reg.skinIdx, shirtIdx: reg.shirtIdx, pantsIdx: reg.pantsIdx,
          coins: 50, cosmetics: [], equipped: "", pet: "", petAcc: "", items: {}, isAnnouncer: false,
          department: reg.department || "", wins: {}, hobby: "", createdAt: Date.now(),
        };
        players[targetId] = state;
        io.to(targetId).emit("approved", {
          name: state.name, character: state.character,
          hairIdx: state.hairIdx, skinIdx: state.skinIdx, shirtIdx: state.shirtIdx, pantsIdx: state.pantsIdx,
          coins: state.coins, cosmetics: state.cosmetics, equipped: state.equipped, pet: state.pet, petAcc: state.petAcc, items: state.items,
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
    // match cleanup would not fire — settle their match explicitly (an active
    // match is a forfeit: being kicked mid-match pays the opponent).
    forfeitMatchForLeave(targetId);
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
      roundLeaveGoneByEmail(em);   // no successor session is coming — the round spot leaves NOW
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
    // Void containment: a position whose feet tile has no art on ANY layer is
    // outside the drawn world — silently dropped like every other rejection
    // (the client clamps at the border for UX; this is the anti-cheat half).
    if (isUnpaintedPosition(x, y)) return;

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
    // Same After Dark isolation as public chat: a lit outsider's emote must
    // not reach alive participants (a pre-arranged emote code could call out
    // positions just like a chat message would).
    if (round && round.state === "active" && !inTheDark(socket.id)) {
      for (const id of Object.keys(players)) if (!inTheDark(id)) io.to(id).emit("playerEmote", { id: socket.id, emote });
    } else {
      io.emit("playerEmote", { id: socket.id, emote });
    }
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
    // Mission fact only — the COUNT of an exchange, never the content.
    coachWhisperExchanged(socket.id, targetId);
  });

  // ── Push-to-talk voice: opaque signaling relay (see voicePairOk block) ──
  // Every relay is re-validated HERE, per message — sender live, target live,
  // within earshot + slack, same side of the After Dark split. Failures are
  // silent drops, the same policy as chat/emote throttling: an error reply
  // would hand a probing client a distance oracle for other players.
  socket.on("voiceSignal", (payload) => {
    const { targetId, data } = payload || {};
    if (!players[socket.id]) return;
    if (!takeToken(voiceSigBucket)) return;
    if (typeof targetId !== "string" || targetId === socket.id || !data) return;
    let size = 0;
    try { size = JSON.stringify(data).length; } catch { return; }
    if (!size || size > VOICE_SIG_MAX) return;
    // ICE candidates are tiny (<1KB); a 40KB "candidate" is only useful as a
    // memory-flood against the receiving browser. Per-kind cap, still opaque.
    if (data.k === "ice" && size > VOICE_ICE_MAX) return;
    if (!voicePairOk(socket.id, targetId)) return;
    io.to(targetId).emit("voiceSignal", { fromId: socket.id, data });
  });

  // The 🎙 talking badge. Mirrors public chat's After Dark isolation exactly:
  // a LIT player's badge must never reach alive round members (a pre-arranged
  // "I hold the mic when the killer nears you" is a position call-out), while
  // a dark player's badge is public drama like their chat. Client badges
  // self-expire (~6.5s) and the sender re-asserts every 4s while holding, so
  // a throttled/lost `off` can never wedge a badge on.
  socket.on("voiceTalking", (payload) => {
    if (!players[socket.id]) return;
    if (!takeToken(voiceTalkBucket)) return;
    const msg = { id: socket.id, on: !!(payload && payload.on) };
    if (round && round.state === "active" && !inTheDark(socket.id)) {
      for (const id of Object.keys(players)) if (!inTheDark(id)) io.to(id).emit("voiceTalking", msg);
    } else {
      io.emit("voiceTalking", msg);
    }
  });

  // ── Huddles the coach: talk / intake / mission re-roll ────────────────
  const coachBucket = makeBucket(3, 1200);   // guards E-mash / reroll spam

  // Scene-create pull for the NPC snapshot (the restorePlayer push can land
  // before the Phaser scene registers its listeners — pull covers that).
  socket.on("npcSync", () => socket.emit("npcState", npcSnapshot()));

  socket.on("coachInteract", async () => {
    const p = players[socket.id];
    if (!p || !takeToken(coachBucket)) return;
    const dx = (p.x ?? 0) - NPC.x, dy = (p.y ?? 0) - NPC.y;
    if (dx * dx + dy * dy > NPC_TALK_RADIUS * NPC_TALK_RADIUS) {
      socket.emit("interactError", { message: "Walk over to Huddles first!" });
      return;
    }
    p.coachTalkAt = Date.now();   // proximity verified — opens the intake/reroll window
    if (!p.email) { socket.emit("coachPanel", { guest: true }); return; }   // session-only: no durable identity to coach
    try {
      const row = await coachRow(p.email);
      if (!row?.intake) { socket.emit("coachPanel", { needIntake: true, departments: DEPARTMENTS }); return; }
      if (row.is_today && row.mission) {
        p.coachMission = row.mission;
        p.coachDone = row.done;
        socket.emit("coachPanel", { mission: missionClientView(row.mission, row.done, row.rerolled) });
        return;
      }
      socket.emit("coachPanel", { generating: true });
      await coachGenerateToday(p);   // emits coachMission when done (AI or fallback)
    } catch (err) {
      console.error("coachInteract failed:", err);
      socket.emit("interactError", { message: "Huddles is lost in thought — try again in a moment." });
    }
  });

  socket.on("coachIntake", async (payload) => {
    const p = players[socket.id];
    if (!p?.email || !takeToken(coachBucket)) return;
    if (!coachSessionOk(p)) { socket.emit("interactError", { message: "Walk over to Huddles first!" }); return; }
    p.coachTalkAt = Date.now();   // keep the window open for the re-roll decision
    const { goal, depts } = payload || {};
    // Structured multi-choice only — nothing free-form reaches the AI prompt.
    const g = Object.hasOwn(COACH_GOALS, goal) ? goal : "meet_new";
    const ds = (Array.isArray(depts) ? depts : []).filter((d) => DEPARTMENTS.includes(d)).slice(0, 3);
    try {
      await pool.query(
        `INSERT INTO jpo_coach (email, intake, intake_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (email) DO UPDATE SET intake = $2::jsonb, intake_at = now()`,
        [p.email, JSON.stringify({ goal: g, depts: ds })]);
      socket.emit("coachPanel", { generating: true });
      await coachGenerateToday(p);
    } catch (err) { console.error("coachIntake failed:", err); }
  });

  socket.on("coachReroll", async () => {
    const p = players[socket.id];
    if (!p?.email || !takeToken(coachBucket)) return;
    if (!coachSessionOk(p)) { socket.emit("interactError", { message: "Walk over to Huddles first!" }); return; }
    try {
      // Atomic once-a-day flip: only the FIRST reroll of the day matches.
      const { rows } = await pool.query(
        `UPDATE jpo_coach SET rerolled = true
          WHERE email = $1 AND mission_date = CURRENT_DATE AND rerolled = false
            AND mission_done_at IS NULL AND mission IS NOT NULL
          RETURNING mission`, [p.email]);
      if (!rows[0]) { socket.emit("interactError", { message: "No re-roll left today — see you tomorrow!" }); return; }
      socket.emit("coachPanel", { generating: true });
      await coachGenerateToday(p, rows[0].mission || {});
    } catch (err) { console.error("coachReroll failed:", err); }
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
      wins:       p.wins || {},
      hobby:      p.hobby || "",
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

  // Free-text hobby, editable ANY time from your own card (unlike the set-once
  // department). Server-side hygiene: trim, strip control chars, cap length;
  // '' clears it. Rendered client-side with textContent only, so the text is
  // display-safe by construction.
  socket.on("setHobby", async (payload) => {
    const { hobby } = payload || {};
    const me = players[socket.id];
    if (!me) return;
    if (!takeToken(profileBucket)) return;           // shares the profile throttle
    if (typeof hobby !== "string") return;
    const clean = hobby.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
    if (!me.email) {
      me.hobby = clean;                              // session-only: memory
      socket.emit("hobbySet", { hobby: clean });
      return;
    }
    try {
      await pool.query(
        `UPDATE jpo_players SET hobby = $2, updated_at = now() WHERE email = $1`,
        [me.email, clean],
      );
      me.hobby = clean;
      socket.emit("hobbySet", { hobby: clean });
    } catch (err) {
      console.error("setHobby failed:", err);
      socket.emit("profileError", { message: "Something went wrong — try again." });
    }
  });

  // Office-wide all-time leaderboard: top 10 approved accounts by TOTAL wins
  // across every game (duels + After Dark), from the DB so offline champions
  // still rank. Zero-win rows are excluded — an empty board reads better than
  // a wall of zeros. Read-only, shares the profile throttle.
  socket.on("getLeaderboard", async () => {
    if (!players[socket.id]) return;                 // must be in the office
    if (!takeToken(profileBucket)) return;
    try {
      const { rows } = await pool.query(
        `SELECT * FROM (
           SELECT COALESCE(NULLIF(nickname, ''), NULLIF(first_name, ''), name) AS display,
                  wins,
                  (SELECT COALESCE(SUM(v.value::int), 0)::int FROM jsonb_each_text(wins) v) AS total
             FROM jpo_players
            WHERE approved = true
         ) t
         WHERE total > 0
         ORDER BY total DESC, display ASC
         LIMIT 10`,
      );
      socket.emit("leaderboardData", {
        rows: rows.map((r) => ({ name: r.display, total: r.total, wins: r.wins || {} })),
      });
    } catch (err) {
      console.error("getLeaderboard failed:", err);
      socket.emit("leaderboardData", { rows: [] });
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

    if (m.game === "pool") {
      // Turn-based meter shots — protocol in the Billiards helpers. rpsStart
      // just opens the panel; the first poolState arms the opening shot.
      m.state = "playing";
      m.poolScores = { [m.challengerId]: 0, [m.targetId]: 0 };
      io.to(m.challengerId).emit("rpsStart", { ...base(m.targetId, tg.name),     target: POOL_TARGET });
      io.to(m.targetId).emit("rpsStart",     { ...base(m.challengerId, ch.name), target: POOL_TARGET });
      poolNextTurn(m, Math.random() < 0.5 ? m.challengerId : m.targetId);
      return;
    }

    if (m.game === "pong") {
      // Real-time rally — sim loop in the Ping Pong helpers. Challenger
      // defends the LEFT paddle line, target the right; the client renders
      // whichever side rpsStart names.
      m.state = "playing";
      m.pongScore = { [m.challengerId]: 0, [m.targetId]: 0 };
      m.pongPad = { [m.challengerId]: PONG_H / 2, [m.targetId]: PONG_H / 2 };
      m.pongPadTarget = { [m.challengerId]: PONG_H / 2, [m.targetId]: PONG_H / 2 };
      m.pongStartAt = Date.now();
      m.pongLastTick = Date.now();
      pongServe(m, Math.random() < 0.5 ? m.challengerId : m.targetId);
      const court = { w: PONG_W, h: PONG_H, padX: PONG_PAD_X, padHalf: PONG_PAD_HH };
      io.to(m.challengerId).emit("rpsStart", { ...base(m.targetId, tg.name),     side: "left",  court, target: PONG_TARGET, maxMs: PONG_MAX_MS });
      io.to(m.targetId).emit("rpsStart",     { ...base(m.challengerId, ch.name), side: "right", court, target: PONG_TARGET, maxMs: PONG_MAX_MS });
      m.pongInterval = setInterval(() => pongTick(m), PONG_TICK_MS);
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

  // Billiards shot intent. The meter position derives from elapsed-ms since
  // the shot was armed — client-measured, sanity-clamped to the server clock
  // (see the Billiards helpers for the trust tradeoff). Bad payloads drop
  // silently, same policy as a bad tttMove.
  socket.on("poolShot", (payload) => {
    const { challengeId, elapsedMs } = payload || {};
    const m = rpsBySocket.get(socket.id);
    if (!m || m.id !== challengeId || m.game !== "pool" || m.state !== "playing") return;
    if (m.poolTurn !== socket.id) return;   // not your cue (or mid-beat)
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > POOL_TURN_MS + POOL_SKEW_MS) return;
    const serverElapsed = Date.now() - m.poolTurnAt;
    const e = Math.abs(serverElapsed - elapsedMs) <= POOL_SKEW_MS ? elapsedMs : serverElapsed;
    m.poolTurn = null;                      // lock the cue until the next arm
    clearTimeout(m.moveTimer);
    const pos = Math.round(poolMeterPos(e) * 10) / 10;
    const half = poolHalfWidth(m.poolScores[socket.id] ?? 0);
    const hit = Math.abs(pos - m.poolSpot) <= half;
    if (hit) m.poolScores[socket.id] = (m.poolScores[socket.id] ?? 0) + 1;
    const other = rpsOtherId(m, socket.id);
    for (const [id, oid] of [[socket.id, other], [other, socket.id]]) {
      io.to(id).emit("poolShotResult", {
        challengeId: m.id, yours: id === socket.id, pos, center: m.poolSpot, half, hit,
        scores: { you: m.poolScores[id] ?? 0, them: m.poolScores[oid] ?? 0 },
      });
    }
    if ((m.poolScores[socket.id] ?? 0) >= POOL_TARGET) {
      finishMatch(m, { winnerId: socket.id, loserId: other, extras: poolExtras(m) })
        .catch((err) => console.error("pool resolve failed:", err));
      return;
    }
    // Sink → keep the cue; miss → pass it. Short beat so the result flash
    // lands before the meter re-arms (revealTimer is on the cleared set).
    m.revealTimer = setTimeout(() => poolNextTurn(m, hit ? socket.id : other), POOL_BEAT_MS);
  });

  // Ping Pong paddle intent: just a target y — the sim loop walks the paddle
  // toward it at a capped speed each tick. Pure in-memory assignment (no
  // broadcast, no DB), so it deliberately has no token bucket; the ~30 Hz
  // client send rate is self-throttled and excess writes are harmless.
  socket.on("pongPaddle", (payload) => {
    const { challengeId, y } = payload || {};
    const m = rpsBySocket.get(socket.id);
    if (!m || m.id !== challengeId || m.game !== "pong" || m.state !== "playing") return;
    if (!Number.isFinite(y)) return;
    m.pongPadTarget[socket.id] = Math.min(PONG_H - PONG_PAD_HH, Math.max(PONG_PAD_HH, y));
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
    coachCoffeeMoment(socket.id);
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
      socket.emit("petSuccess", { item, pet: p.pet, petAcc: p.petAcc || "" });
      io.emit("playerPetUpdate", { id: socket.id, pet: p.pet, petAcc: p.petAcc || "" });
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
      socket.emit("petSuccess", { item, pet: p.pet, petAcc: p.petAcc || "" });
      io.emit("playerPetUpdate", { id: socket.id, pet: p.pet, petAcc: p.petAcc || "" });
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
      socket.emit("petUpdate", { pet: p.pet, petAcc: p.petAcc || "" });
      io.emit("playerPetUpdate", { id: socket.id, pet: p.pet, petAcc: p.petAcc || "" });
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
      socket.emit("petUpdate", { pet: p.pet, petAcc: p.petAcc || "" });
      io.emit("playerPetUpdate", { id: socket.id, pet: p.pet, petAcc: p.petAcc || "" });
    } catch (err) { console.error("equipPet failed:", err); }
  });

  // ── Pet accessories: buy one (auto-puts it on) ───────────────────────────
  // Mirrors buyPet exactly: same throttle, same mid-match/mid-round blocks
  // (coins move), and the same one-statement atomicity — the coins guard, the
  // "not already owned" guard, the ownership append (shared cosmetics array)
  // and the auto-equip into equipped_pet_acc all commit together.
  socket.on("buyPetAcc", async (payload) => {
    const { item } = payload || {};
    const p = players[socket.id], cost = PET_ACCESSORIES[item];
    if (!p || !cost) return;
    if (!takeToken(buyBucket)) return;   // shares the shop's spam throttle
    if (rpsBySocket.has(socket.id)) { socket.emit("shopError", "Finish your match first!"); return; }
    if (inActiveRound(socket.id)) { socket.emit("shopError", "The lights are out — no shopping until the round ends!"); return; }

    // Session-only players (no email): memory-only purchase.
    if (!p.email) {
      if (p.cosmetics.includes(item)) { socket.emit("shopError", "Already owned!"); return; }
      if (p.coins < cost) { socket.emit("shopError", "Not enough coins!"); return; }
      p.coins -= cost;
      p.cosmetics.push(item);
      p.petAcc = item;   // buying auto-equips
      socket.emit("coinUpdate", { coins: p.coins });
      socket.emit("petAccSuccess", { item, petAcc: p.petAcc });
      io.emit("playerPetUpdate", { id: socket.id, pet: p.pet || "", petAcc: p.petAcc });
      console.log(`${p.name} bought ${item} (session-only)`);
      return;
    }

    try {
      const { rows } = await pool.query(
        `UPDATE jpo_players
            SET coins = coins - $2,
                cosmetics = array_append(cosmetics, $3),
                equipped_pet_acc = $3,
                updated_at = now()
          WHERE email = $1 AND coins >= $2 AND NOT ($3 = ANY(cosmetics))
          RETURNING coins, cosmetics, equipped_pet_acc`,
        [p.email, cost, item],
      );
      if (rows.length === 0) {
        if (p.cosmetics.includes(item)) socket.emit("shopError", "Already owned!");
        else socket.emit("shopError", "Not enough coins!");
        return;
      }
      p.coins = rows[0].coins;
      p.cosmetics = rows[0].cosmetics || [];
      p.petAcc = rows[0].equipped_pet_acc || "";
      socket.emit("coinUpdate", { coins: p.coins });
      socket.emit("petAccSuccess", { item, petAcc: p.petAcc });
      io.emit("playerPetUpdate", { id: socket.id, pet: p.pet || "", petAcc: p.petAcc });
      console.log(`${p.name} bought ${item}`);
    } catch (err) { console.error("buyPetAcc failed:", err); }
  });

  // ── Pet accessories: put on / take off ('' = bare pet) ───────────────────
  // Free (no coin movement), so like equipPet it is NOT blocked mid-match.
  // Ownership is enforced inside the UPDATE's WHERE clause, and only
  // PET_ACCESSORIES ids pass — pet/wearable ids can't land in this slot.
  socket.on("equipPetAcc", async (payload) => {
    const raw = (payload || {}).item;
    const item = typeof raw === "string" ? raw : null;
    const p = players[socket.id];
    if (!p || item === null) return;
    if (item !== "" && !PET_ACCESSORIES[item]) return;   // unknown accessory id
    if (!takeToken(buyBucket)) return;                   // shares the shop's spam throttle
    if ((p.petAcc || "") === item) return;               // no-op

    if (!p.email) {
      if (item !== "" && !p.cosmetics.includes(item)) { socket.emit("shopError", "You don't own that!"); return; }
      p.petAcc = item;
      socket.emit("petAccUpdate", { petAcc: p.petAcc });
      io.emit("playerPetUpdate", { id: socket.id, pet: p.pet || "", petAcc: p.petAcc });
      return;
    }

    try {
      const { rows } = await pool.query(
        `UPDATE jpo_players
            SET equipped_pet_acc = $2, updated_at = now()
          WHERE email = $1 AND ($2 = '' OR $2 = ANY(cosmetics))
          RETURNING equipped_pet_acc`,
        [p.email, item],
      );
      if (rows.length === 0) { socket.emit("shopError", "You don't own that!"); return; }
      p.petAcc = rows[0].equipped_pet_acc || "";
      socket.emit("petAccUpdate", { petAcc: p.petAcc });
      io.emit("playerPetUpdate", { id: socket.id, pet: p.pet || "", petAcc: p.petAcc });
    } catch (err) { console.error("equipPetAcc failed:", err); }
  });

  // ── Coin gifting: send coins to another player ───────────────────────────
  // Same money rules as the shop: buy throttle, blocked mid-match for the
  // SENDER (spending would break the wager invariant; the receiver only
  // gains, which is always safe), blocked in an After Dark round. The move
  // itself reuses rpsSettle (receiver "wins" the amount from the sender), so
  // a partial transfer is impossible in every email/session combination.
  socket.on("sendCoins", async (payload) => {
    const { targetId, amount } = payload || {};
    const p = players[socket.id];
    const target = typeof targetId === "string" ? players[targetId] : null;
    const fail = (message) => socket.emit("giftResult", { ok: false, message });
    if (!p) return;
    if (!takeToken(buyBucket)) return;
    if (!target || targetId === socket.id) { fail("They're not in the office right now."); return; }
    // Block if EITHER side is in a challenge/match. The sender block protects
    // the wager invariant (spending mid-match); the receiver block keeps the
    // no-coin-movement-mid-match rule simple and absolute (a gift landing
    // mid-settle is harmless — coins only ADD — but "nobody's balance moves
    // during a match except the wager" is easier to reason about and test).
    if (rpsBySocket.has(socket.id)) { fail("Finish your match first!"); return; }
    if (rpsBySocket.has(targetId)) { fail(`${target.name} is mid-match — wait for it to finish.`); return; }
    if (inActiveRound(socket.id)) { fail("The lights are out — no gifting until the round ends!"); return; }
    const amt = Math.round(Number(amount));
    if (!Number.isInteger(amt) || amt < 1) { fail("Enter an amount of at least 1 coin."); return; }
    const senderKey = p.email || socket.id;
    const room = giftRoomToday(senderKey);
    if (amt > room) {
      fail(room > 0
        ? `Daily gift limit: you can still send ${room.toLocaleString()} coins today.`
        : `You've hit today's ${GIFT_DAILY_CAP.toLocaleString()}-coin gift limit — try again tomorrow.`);
      return;
    }
    if ((p.coins ?? 0) < amt) { fail("Not enough coins!"); return; }
    try {
      const moved = await rpsSettle(targetId, socket.id, amt);
      if (!moved) { fail("Not enough coins!"); return; }
      giftRecord(senderKey, moved);
      socket.emit("coinUpdate", { coins: p.coins });
      io.to(targetId).emit("coinUpdate", { coins: target.coins });
      socket.emit("giftResult", { ok: true, message: `Sent ${moved.toLocaleString()} coins to ${target.name}! 💝` });
      io.to(targetId).emit("giftReceived", { fromName: p.name, amount: moved });
      console.log(`GIFT: ${p.name} → ${target.name} (${moved} coins)`);
    } catch (err) { console.error("sendCoins failed:", err); fail("Sending failed — try again."); }
  });

  // ── Pet trades: direct offer → accept/decline ────────────────────────────
  // "My cat + N coins for your dragon." Both sides must be email-backed (the
  // swap has to persist); every ownership/coins guard is re-checked INSIDE
  // one SQL transaction at accept time, so nothing the two players do in the
  // 60s window (spend coins, buy the same pet, disconnect) can half-apply a
  // trade. Received pets auto-adopt, same feel as buying one.
  // Trade composer data: the pets each side owns RIGHT NOW (the client
  // doesn't track other players' inventories). Display-only — every id is
  // re-validated at offer time and again inside the accept transaction.
  socket.on("tradePetsOf", (payload) => {
    const { targetId } = payload || {};
    const p = players[socket.id];
    const target = typeof targetId === "string" ? players[targetId] : null;
    if (!p || !target) return;
    if (!takeToken(profileBucket)) return;
    const petsOf = (pl) => (pl.cosmetics || []).filter((c) => Object.hasOwn(PETS, c));
    socket.emit("tradePets", { targetId, targetName: target.name, mine: petsOf(p), theirs: petsOf(target) });
  });

  socket.on("tradeOffer", async (payload) => {
    const { targetId, offerPet, askPet, coins } = payload || {};
    const p = players[socket.id];
    const target = typeof targetId === "string" ? players[targetId] : null;
    const fail = (message) => socket.emit("tradeError", { message });
    if (!p) return;
    if (!takeToken(buyBucket)) return;
    if (!target || targetId === socket.id) { fail("They're not in the office right now."); return; }
    if (!p.email || !target.email) { fail("Trades need saved accounts on both sides."); return; }
    if (rpsBySocket.has(socket.id) || rpsBySocket.has(targetId)) { fail("No trading mid-match!"); return; }
    if (inActiveRound(socket.id) || inActiveRound(targetId)) { fail("The lights are out — no trading until the round ends!"); return; }
    if (tradeBySocket.has(socket.id)) { fail("You already have a trade open."); return; }
    if (tradeBySocket.has(targetId)) { fail(`${target.name} is already in a trade.`); return; }
    if (typeof offerPet !== "string" || !PETS[offerPet]) { fail("Pick one of your pets to offer."); return; }
    if (typeof askPet !== "string" || !PETS[askPet]) { fail("Pick one of their pets to ask for."); return; }
    if (!p.cosmetics.includes(offerPet)) { fail("You don't own that pet."); return; }
    if (!target.cosmetics.includes(askPet)) { fail("They don't own that pet."); return; }
    if (p.cosmetics.includes(askPet)) { fail("You already own that pet."); return; }
    if (target.cosmetics.includes(offerPet)) { fail(`${target.name} already owns that pet.`); return; }
    const c = Math.round(Number(coins ?? 0));
    if (!Number.isInteger(c) || c < 0) { fail("Coin sweetener must be 0 or more."); return; }
    if (c > (p.coins ?? 0)) { fail("Not enough coins for that sweetener."); return; }
    // A pet that's up for bids in someone's store is spoken for — trading it
    // away would strand every escrowed bid on the listing (accept-time guards
    // in BOTH settle transactions back this check up).
    try {
      const { rows: listed } = await pool.query(
        `SELECT seller_email, item_id FROM jpo_store_listings
          WHERE (seller_email = $1 AND item_id = $2) OR (seller_email = $3 AND item_id = $4)`,
        [p.email, offerPet, target.email, askPet]);
      if (listed.some((l) => l.seller_email === p.email)) { fail("That pet is listed in your store — unlist it first."); return; }
      if (listed.some((l) => l.seller_email === target.email)) { fail(`That pet is up for bids in ${target.name}'s store.`); return; }
    } catch (err) { console.error("trade listing check failed:", err); fail("Trade hiccup — try again."); return; }

    const t = {
      id: ++tradeSeq, state: "pending",
      fromId: socket.id, toId: targetId, offerPet, askPet, coins: c,
      timer: setTimeout(() => clearTrade(t, "Trade offer expired."), TRADE_ACCEPT_MS),
    };
    tradeBySocket.set(socket.id, t);
    tradeBySocket.set(targetId, t);
    io.to(targetId).emit("tradeIncoming", {
      tradeId: t.id, fromId: socket.id, fromName: p.name,
      offerPet, askPet, coins: c, timeoutMs: TRADE_ACCEPT_MS,
    });
    socket.emit("tradeSent", { tradeId: t.id, toName: target.name, offerPet, askPet, coins: c });
    console.log(`TRADE offer: ${p.name} → ${target.name} (${offerPet} + ${c} coins for ${askPet})`);
  });

  // Accept is IRREVOCABLE once pressed: the SQL transaction commits against
  // the durable rows, so a disconnect mid-settle doesn't (and must not) void
  // it — the DB is the source of truth and a reconnect restores the traded
  // state. Disconnect cleanup therefore only cancels PENDING trades.
  socket.on("tradeAccept", async () => {
    const t = tradeBySocket.get(socket.id);
    if (!t || t.state !== "pending" || t.toId !== socket.id) return;
    t.state = "settling";   // synchronous flip — a repeat tap or the timeout can't double-settle
    clearTimeout(t.timer);
    const from = players[t.fromId], to = players[t.toId];
    const abort = (msg) => {
      t.state = "done";
      tradeBySocket.delete(t.fromId);
      tradeBySocket.delete(t.toId);
      io.to(t.fromId).emit("tradeEnded", { tradeId: t.id, message: msg });
      io.to(t.toId).emit("tradeEnded",   { tradeId: t.id, message: msg });
    };
    if (!from || !to) { abort("Trade fell through — someone left the office."); return; }
    const client = await pool.connect();
    let ok = false, fromRow, toRow;
    try {
      await client.query("BEGIN");
      // Offerer: loses offerPet + coins, gains askPet (auto-adopted).
      const r1 = await client.query(
        `UPDATE jpo_players
            SET cosmetics = array_append(array_remove(cosmetics, $2), $3),
                coins = coins - $4,
                equipped_pet = $3,
                updated_at = now()
          WHERE email = $1 AND $2 = ANY(cosmetics) AND NOT ($3 = ANY(cosmetics)) AND coins >= $4
            AND NOT EXISTS (SELECT 1 FROM jpo_store_listings sl WHERE sl.seller_email = $1 AND sl.item_id = $2)
          RETURNING coins, cosmetics, equipped_pet`,
        [from.email, t.offerPet, t.askPet, t.coins],
      );
      // Accepter: loses askPet, gains offerPet (auto-adopted) + coins.
      const r2 = await client.query(
        `UPDATE jpo_players
            SET cosmetics = array_append(array_remove(cosmetics, $2), $3),
                coins = coins + $4,
                equipped_pet = $3,
                updated_at = now()
          WHERE email = $1 AND $2 = ANY(cosmetics) AND NOT ($3 = ANY(cosmetics))
            AND NOT EXISTS (SELECT 1 FROM jpo_store_listings sl WHERE sl.seller_email = $1 AND sl.item_id = $2)
          RETURNING coins, cosmetics, equipped_pet`,
        [to.email, t.askPet, t.offerPet, t.coins],
      );
      if (r1.rowCount === 1 && r2.rowCount === 1) {
        await client.query("COMMIT");
        ok = true; fromRow = r1.rows[0]; toRow = r2.rows[0];
      } else {
        await client.query("ROLLBACK");
      }
    } catch (err) {
      console.error("tradeAccept failed:", err);
      try { await client.query("ROLLBACK"); } catch {}
    } finally {
      client.release();
    }
    if (!ok) { abort("Trade fell through — a pet or the coins moved since the offer."); return; }

    for (const [id, pl, row] of [[t.fromId, from, fromRow], [t.toId, to, toRow]]) {
      pl.coins = row.coins;
      pl.cosmetics = row.cosmetics || [];
      pl.pet = row.equipped_pet || "";
      io.to(id).emit("coinUpdate", { coins: pl.coins });
      io.emit("playerPetUpdate", { id, pet: pl.pet, petAcc: pl.petAcc || "" });
      io.emit("playerCosmeticUpdate", { id, cosmetics: pl.cosmetics, equipped: pl.equipped || "" });
    }
    t.state = "done";
    tradeBySocket.delete(t.fromId);
    tradeBySocket.delete(t.toId);
    io.to(t.fromId).emit("tradeComplete", { tradeId: t.id, got: t.askPet,   gave: t.offerPet, coins: -t.coins, otherName: to.name });
    io.to(t.toId).emit("tradeComplete",   { tradeId: t.id, got: t.offerPet, gave: t.askPet,   coins: t.coins,  otherName: from.name });
    console.log(`TRADE done: ${from.name} ⇄ ${to.name} (${t.offerPet} + ${t.coins} coins ⇄ ${t.askPet})`);
  });

  socket.on("tradeDecline", () => {
    const t = tradeBySocket.get(socket.id);
    if (!t || t.state !== "pending") return;
    const who = players[socket.id];
    clearTrade(t, socket.id === t.toId
      ? `${who?.name || "They"} declined the trade.`
      : `${who?.name || "They"} withdrew the trade.`);
  });

  // ── Bid stores / office market ───────────────────────────────────────────
  // All handlers are email-backed only (stores and escrow live in the DB).
  // After any mutation: push a fresh snapshot to the actor and ping everyone
  // else with marketDirty (open market panels re-request their own snapshot).
  const storeFail = (message) => socket.emit("storeError", { message });
  async function pushMarket() {
    const p = players[socket.id];
    if (!p?.email) return;
    try { socket.emit("marketState", { listings: await marketSnapshot(p.email) }); }
    catch (err) { console.error("marketSnapshot failed:", err); }
  }
  const marketPing = () => socket.broadcast.emit("marketDirty");

  socket.on("marketOpen", async (payload) => {
    const p = players[socket.id];
    if (!p) return;
    if (!p.email) { storeFail("Sign in with your email to use the market."); return; }
    if (!takeToken(profileBucket)) return;
    // Clicked a coworker's avatar → tell the client whose stall to focus.
    const targetId = payload?.targetId;
    const filterName = targetId && players[targetId] ? players[targetId].name : null;
    try {
      socket.emit("marketState", { listings: await marketSnapshot(p.email), filterName });
    } catch (err) { console.error("marketOpen failed:", err); storeFail("The market is having a moment — try again."); }
  });

  // Put one of your items up for bids.
  socket.on("storeList", async (payload) => {
    const { item, minBid } = payload || {};
    const p = players[socket.id];
    if (!p) return;
    if (!takeToken(buyBucket)) return;
    if (!p.email) { storeFail("Sign in with your email to open a store."); return; }
    const cat = catalogOf(item);
    if (!cat) { storeFail("That item can't be listed."); return; }
    if (!(p.cosmetics || []).includes(item)) { storeFail("You don't own that."); return; }
    const min = storeInt(minBid);
    if (!Number.isFinite(min) || min < STORE_BID_MIN || min > STORE_BID_MAX) {
      storeFail(`Minimum bid must be ${STORE_BID_MIN}–${STORE_BID_MAX.toLocaleString()} coins.`); return;
    }
    try {
      // UNIQUE(seller_email, item_id) turns a double-list into a friendly error.
      await pool.query(
        `INSERT INTO jpo_store_listings (seller_email, item_id, min_bid) VALUES ($1, $2, $3)`,
        [p.email, item, min]);
      socket.emit("storeOk", { message: `${itemLabel(item)} is up for bids (min ${min.toLocaleString()}).` });
      console.log(`Market: ${p.name} listed ${item} (min ${min})`);
      await pushMarket(); marketPing();
    } catch (err) {
      if (String(err.code) === "23505") storeFail("You already have that item listed.");
      else { console.error("storeList failed:", err); storeFail("Couldn't list that — try again."); }
    }
  });

  // Close one of your listings: every escrowed bid refunds.
  socket.on("storeUnlist", async (payload) => {
    const listingId = storeInt(payload?.listingId);
    const p = players[socket.id];
    if (!p?.email || !Number.isFinite(listingId)) return;
    if (!takeToken(buyBucket)) return;
    const client = await pool.connect();
    let refunded = [];
    try {
      await client.query("BEGIN");
      const { rows: lrows } = await client.query(
        `SELECT id, item_id FROM jpo_store_listings WHERE id = $1 AND seller_email = $2 FOR UPDATE`,
        [listingId, p.email]);
      if (!lrows.length) { await client.query("ROLLBACK"); storeFail("That listing is already gone."); return; }
      const { rows: brows } = await client.query(
        `SELECT bidder_email, amount FROM jpo_store_bids WHERE listing_id = $1 FOR UPDATE`, [listingId]);
      for (const b of brows)
        await client.query(`UPDATE jpo_players SET coins = coins + $1 WHERE email = $2`, [b.amount, b.bidder_email]);
      await client.query(`DELETE FROM jpo_store_listings WHERE id = $1`, [listingId]);   // bids cascade
      await client.query("COMMIT");
      refunded = brows;
      const label = itemLabel(lrows[0].item_id);
      socket.emit("storeOk", { message: `${label} pulled from your store.` });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("storeUnlist failed:", err); storeFail("Couldn't close that listing — try again.");
      return;
    } finally { client.release(); }
    for (const b of refunded) {
      await storeNotify(b.bidder_email, `Bid refunded: ${b.amount.toLocaleString()} coins back (listing closed).`);
      await syncCoins(b.bidder_email);
    }
    await pushMarket(); marketPing();
  });

  // Place or raise a bid. Coins are escrowed NOW; raising swaps the escrow.
  socket.on("storeBid", async (payload) => {
    const listingId = storeInt(payload?.listingId);
    const amt = storeInt(payload?.amount);
    const p = players[socket.id];
    if (!p || !Number.isFinite(listingId)) return;
    if (!takeToken(buyBucket)) return;
    if (!p.email) { storeFail("Sign in with your email to bid."); return; }
    if (rpsBySocket.has(socket.id)) { storeFail("Finish your match first!"); return; }
    if (inActiveRound(socket.id)) { storeFail("The lights are out — no bidding until the round ends!"); return; }
    if (!Number.isFinite(amt) || amt < STORE_BID_MIN || amt > STORE_BID_MAX) { storeFail("That's not a valid bid."); return; }
    const client = await pool.connect();
    let outcome = null;
    try {
      await client.query("BEGIN");
      const { rows: lrows } = await client.query(
        `SELECT id, seller_email, item_id, min_bid FROM jpo_store_listings WHERE id = $1 FOR UPDATE`, [listingId]);
      if (!lrows.length) { await client.query("ROLLBACK"); storeFail("That listing just closed."); return; }
      const l = lrows[0];
      if (l.seller_email === p.email) { await client.query("ROLLBACK"); storeFail("That's your own store!"); return; }
      if (amt < l.min_bid) { await client.query("ROLLBACK"); storeFail(`Bids start at ${l.min_bid.toLocaleString()} coins.`); return; }
      // Winning would hand you the item — no point escrowing if you own it.
      const { rows: own } = await client.query(
        `SELECT 1 FROM jpo_players WHERE email = $1 AND $2 = ANY(cosmetics)`, [p.email, l.item_id]);
      if (own.length) { await client.query("ROLLBACK"); storeFail("You already own that!"); return; }
      const { rows: old } = await client.query(
        `SELECT id, amount FROM jpo_store_bids WHERE listing_id = $1 AND bidder_email = $2 FOR UPDATE`,
        [listingId, p.email]);
      const oldAmt = old.length ? old[0].amount : 0;
      // Escrow swap in one guarded update: refund the old bid, take the new.
      const { rows: paid } = await client.query(
        `UPDATE jpo_players SET coins = coins + $1 - $2 WHERE email = $3 AND coins + $1 >= $2 RETURNING coins`,
        [oldAmt, amt, p.email]);
      if (!paid.length) { await client.query("ROLLBACK"); storeFail("Not enough coins for that bid."); return; }
      if (old.length) await client.query(`UPDATE jpo_store_bids SET amount = $1, created_at = now() WHERE id = $2`, [amt, old[0].id]);
      else await client.query(`INSERT INTO jpo_store_bids (listing_id, bidder_email, amount) VALUES ($1, $2, $3)`, [listingId, p.email, amt]);
      await client.query("COMMIT");
      outcome = { l, coins: paid[0].coins, raised: !!old.length };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("storeBid failed:", err); storeFail("Bid didn't go through — try again.");
      return;
    } finally { client.release(); }
    if (p === players[socket.id]) { p.coins = outcome.coins; socket.emit("coinUpdate", { coins: outcome.coins }); }
    const label = itemLabel(outcome.l.item_id);
    socket.emit("storeOk", { message: `${outcome.raised ? "Bid raised" : "Bid placed"}: ${amt.toLocaleString()} coins on ${label}. Coins held until it settles.` });
    const sellerSock = socketIdByEmail(outcome.l.seller_email);
    if (sellerSock) io.to(sellerSock).emit("storeOk", { message: `${p.name} bid ${amt.toLocaleString()} coins on your ${label}!` });
    console.log(`Market: ${p.name} bid ${amt} on listing ${listingId}`);
    await pushMarket(); marketPing();
  });

  // Take your bid (and its escrow) back.
  socket.on("storeWithdraw", async (payload) => {
    const listingId = storeInt(payload?.listingId);
    const p = players[socket.id];
    if (!p?.email || !Number.isFinite(listingId)) return;
    if (!takeToken(buyBucket)) return;
    const client = await pool.connect();
    let coins = null;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `DELETE FROM jpo_store_bids WHERE listing_id = $1 AND bidder_email = $2 RETURNING amount`,
        [listingId, p.email]);
      if (!rows.length) { await client.query("ROLLBACK"); storeFail("No bid to withdraw."); return; }
      const { rows: paid } = await client.query(
        `UPDATE jpo_players SET coins = coins + $1 WHERE email = $2 RETURNING coins`, [rows[0].amount, p.email]);
      await client.query("COMMIT");
      coins = paid[0].coins;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("storeWithdraw failed:", err); storeFail("Couldn't withdraw — try again.");
      return;
    } finally { client.release(); }
    if (p === players[socket.id]) { p.coins = coins; socket.emit("coinUpdate", { coins }); }
    socket.emit("storeOk", { message: "Bid withdrawn — coins are back in your pocket." });
    await pushMarket(); marketPing();
  });

  // Seller picks the winning bid. One transaction settles everything.
  socket.on("storeAccept", async (payload) => {
    const listingId = storeInt(payload?.listingId);
    const bidId = storeInt(payload?.bidId);
    const p = players[socket.id];
    if (!p?.email || !Number.isFinite(listingId) || !Number.isFinite(bidId)) return;
    if (!takeToken(buyBucket)) return;
    if (rpsBySocket.has(socket.id)) { storeFail("Finish your match first!"); return; }
    if (inActiveRound(socket.id)) { storeFail("The lights are out — no deals until the round ends!"); return; }
    const client = await pool.connect();
    let done = null;
    try {
      await client.query("BEGIN");
      const { rows: lrows } = await client.query(
        `SELECT id, item_id FROM jpo_store_listings WHERE id = $1 AND seller_email = $2 FOR UPDATE`,
        [listingId, p.email]);
      if (!lrows.length) { await client.query("ROLLBACK"); storeFail("That listing is already gone."); return; }
      const item = lrows[0].item_id;
      const { rows: brows } = await client.query(
        `SELECT id, bidder_email, amount FROM jpo_store_bids WHERE listing_id = $1 FOR UPDATE`, [listingId]);
      const win = brows.find((b) => b.id === bidId);
      if (!win) { await client.query("ROLLBACK"); storeFail("That bid was withdrawn."); return; }
      // Seller + winner updates run in EMAIL ORDER (same deterministic
      // player-row lock order everywhere → no deadlocks against a concurrent
      // trade or another sale touching the same rows).
      const sellSql = () => client.query(
        `UPDATE jpo_players SET
           cosmetics = array_remove(cosmetics, $1),
           coins = coins + $2,
           equipped_cosmetic = CASE WHEN equipped_cosmetic = $1 THEN '' ELSE equipped_cosmetic END,
           equipped_pet      = CASE WHEN equipped_pet      = $1 THEN '' ELSE equipped_pet      END,
           equipped_pet_acc  = CASE WHEN equipped_pet_acc  = $1 THEN '' ELSE equipped_pet_acc  END
         WHERE email = $3 AND $1 = ANY(cosmetics)
         RETURNING coins, cosmetics, equipped_cosmetic, equipped_pet, equipped_pet_acc`,
        [item, win.amount, p.email]);
      const winSql = () => client.query(
        `UPDATE jpo_players SET cosmetics = array_append(cosmetics, $1)
         WHERE email = $2 AND NOT ($1 = ANY(cosmetics)) RETURNING coins`,
        [item, win.bidder_email]);
      const sellerFirst = p.email <= win.bidder_email;
      const rA = await (sellerFirst ? sellSql() : winSql());
      const rB = await (sellerFirst ? winSql() : sellSql());
      const sold = sellerFirst ? rA.rows : rB.rows;
      const won  = sellerFirst ? rB.rows : rA.rows;
      if (!sold.length) {
        // The item left the seller's hands since listing (e.g. a trade the
        // guards missed, or an older build). The listing is DEAD — but every
        // escrowed coin must go home IN THIS SAME TRANSACTION, or the bid
        // rows cascade away and the escrow is destroyed with them.
        for (const b of [...brows].sort((x, y) => x.bidder_email < y.bidder_email ? -1 : 1))
          await client.query(`UPDATE jpo_players SET coins = coins + $1 WHERE email = $2`, [b.amount, b.bidder_email]);
        await client.query(`DELETE FROM jpo_store_listings WHERE id = $1`, [listingId]);   // bids cascade AFTER refunds
        await client.query("COMMIT");
        storeFail("You no longer own that item — listing closed and every bid refunded.");
        for (const b of brows) {
          await storeNotify(b.bidder_email, `Bid refunded: ${b.amount.toLocaleString()} coins back (the ${itemLabel(item)} listing was voided).`);
          await syncCoins(b.bidder_email);
        }
        await pushMarket(); marketPing();
        return;
      }
      if (!won.length) { await client.query("ROLLBACK"); storeFail("The winner already owns that now — pick another bid."); return; }
      // Everyone else's escrow goes home (email order, same lock discipline).
      const losers = brows.filter((b) => b.id !== bidId).sort((x, y) => x.bidder_email < y.bidder_email ? -1 : 1);
      for (const b of losers)
        await client.query(`UPDATE jpo_players SET coins = coins + $1 WHERE email = $2`, [b.amount, b.bidder_email]);
      await client.query(`DELETE FROM jpo_store_listings WHERE id = $1`, [listingId]);   // bids cascade
      await client.query("COMMIT");
      done = { item, win, losers, sellerRow: sold[0] };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("storeAccept failed:", err); storeFail("The sale fell through — nothing changed.");
      return;
    } finally { client.release(); }

    const label = itemLabel(done.item);
    // Seller memory + broadcasts (they're online — they just clicked Accept).
    if (p === players[socket.id]) {
      p.coins = done.sellerRow.coins;
      p.cosmetics = done.sellerRow.cosmetics;
      const hadPet = p.pet, hadCos = p.equipped, hadAcc = p.petAcc;
      p.equipped = done.sellerRow.equipped_cosmetic || "";
      p.pet = done.sellerRow.equipped_pet || "";
      p.petAcc = done.sellerRow.equipped_pet_acc || "";
      socket.emit("coinUpdate", { coins: p.coins });
      if (hadCos !== p.equipped) io.emit("playerCosmeticUpdate", { id: socket.id, item: p.equipped });
      if (hadPet !== p.pet || hadAcc !== p.petAcc) io.emit("playerPetUpdate", { id: socket.id, item: p.pet, acc: p.petAcc });
    }
    socket.emit("storeOk", { message: `Sold! ${label} went for ${done.win.amount.toLocaleString()} coins.` });
    // Winner: live sync or queued note.
    const winSock = socketIdByEmail(done.win.bidder_email);
    if (winSock && players[winSock]) {
      players[winSock].cosmetics = [...(players[winSock].cosmetics || []), done.item];
      io.to(winSock).emit("storeOk", { message: `You won the ${label} for ${done.win.amount.toLocaleString()} coins — it's in your collection!` });
      io.to(winSock).emit("collectionUpdate", { cosmetics: players[winSock].cosmetics });
    } else {
      await queueStoreMsg(done.win.bidder_email, `You won the ${label} for ${done.win.amount.toLocaleString()} coins — it's in your collection!`);
    }
    for (const b of done.losers) {
      await storeNotify(b.bidder_email, `Outbid: the ${label} sold to someone else — your ${b.amount.toLocaleString()} coins are back.`);
      await syncCoins(b.bidder_email);
    }
    console.log(`Market: ${p.name} sold ${done.item} for ${done.win.amount} to ${done.win.bidder_email}`);
    await pushMarket(); marketPing();
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
      coachCoffeeMoment(socket.id);
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
      coachCoffeeMoment(socket.id);
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
      coachCoffeeMoment(socket.id);

    } else if (object === "water_cooler") {
      const key = p.email || socket.id;
      if (now < (waterReadyAt.get(key) || 0)) return;   // just sipped — quietly ignore
      pruneCooldowns(waterReadyAt, now);
      waterReadyAt.set(key, now + WATER_COOLDOWN_MS);
      const line = WATER_LINES[waterLineIdx++ % WATER_LINES.length];
      socket.emit("waterCooler", { line });
      io.emit("objectEffect", { id: socket.id, kind: "water" });

    } else if (object.startsWith("punch_bag") || object.startsWith("treadmill")) {
      // Gym equipment: pure flavor (no coins/boost), so no per-person cooldown
      // — interactBucket already throttles spam, and rapid re-punches are the
      // fun part. kind tells clients which strip to play; id drives the emote
      // bubble over the athlete. Same After Dark isolation as chat/emotes: a
      // lit outsider's 🥊/🏃 bubble is a position-anchored signal that must
      // not reach alive participants in the dark.
      const kind = object.startsWith("punch_bag") ? "punch" : "run";
      const fx = { id: socket.id, object, kind };
      if (round && round.state === "active" && !inTheDark(socket.id)) {
        for (const pid of Object.keys(players)) if (!inTheDark(pid)) io.to(pid).emit("gymFx", fx);
      } else {
        io.emit("gymFx", fx);
      }

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
      coachCoffeeMoment(socket.id);

    } else if (object === "arcade" || object.startsWith("pool_table") || object === "pingpong_table") {
      // Two-player game stations: the arcade opens the full game picker; the
      // Game Room tables are dedicated — billiard tables start Billiards, the
      // ping pong table starts Ping Pong. All reuse startRpsChallenge, so
      // every duel cleanup seam applies automatically.
      const station = object === "arcade" ? "arcade" : object.startsWith("pool_table") ? "pool" : "pong";
      if (rpsBySocket.has(socket.id)) {
        socket.emit("interactError", { message: "You're already in a match." });
        return;
      }
      if (inRound(socket.id)) {
        socket.emit("interactError", { message: "No games during Office After Dark!" });
        return;
      }
      // Needs a second player standing at the station; the nearest free one
      // gets the invite and the normal accept/decline flow takes over.
      let bestId = null, bestD = Infinity;
      for (const [oid, op] of Object.entries(players)) {
        if (oid === socket.id || rpsBySocket.has(oid) || inRound(oid)) continue;
        const ox = (op.x ?? 0) - obj.x, oy = (op.y ?? 0) - obj.y;
        const d = ox * ox + oy * oy;
        if (d <= obj.r * obj.r && d < bestD) { bestId = oid; bestD = d; }
      }
      if (!bestId) {
        const msg = station === "arcade" ? "The arcade needs two players — wave someone over! 🕹️"
                  : station === "pool"   ? "Billiards needs two players — wave someone over! 🎱"
                  :                        "Ping pong needs two players — wave someone over! 🏓";
        socket.emit("interactError", { message: msg });
        return;
      }
      // The arcade's game picker rides along on the interact intent (anything
      // off the roster falls back to RPS); the tables force their own game.
      // Always a friendly (0-wager) match.
      const g = station === "arcade"
        ? ((typeof game === "string" && GAMES.has(game)) ? game : "rps")
        : station;
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
      // email here too — the STARTER's record must carry it just like the
      // roundJoin path, or the round-grace defer/rebind seam skips them.
      members: new Map([[socket.id, { name: p.name, alive: true, email: p.email || null }]]),
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
    // email on the member record: the round-grace seam (roundDeferLeave /
    // restorePlayer rebind) and the payout both key off it — a graced
    // survivor has no players[] entry left to read the email from.
    round.members.set(socket.id, { name: p.name, alive: true, email: p.email || null });
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
    let tp = players[targetId];
    // A grace-window ghost (disconnected but holding their round spot) is
    // still a frozen, visible avatar — killable at its parked position, so
    // pulling the plug can't dodge the knife. On resume they come back dead.
    if (!tp && tm?.gone && tm.email && graceByEmail[tm.email]?.oldId === targetId) {
      const g = graceByEmail[tm.email];
      tp = { x: g.x, y: g.y };
    }
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
    // A mid-match refresh/blip settles the match immediately — even though
    // the PLAYER gets a ~10s grace window, the MATCH does not (an opponent
    // staring at a hung screen is worse than a re-challenge). An ACTIVE match
    // is a FORFEIT by the leaver: refreshing while losing used to cancel with
    // no coins moved, which let losers dodge the wager (July 2026 exploit).
    forfeitMatchForLeave(socket.id);
    // The ROUND now gets the same grace as the player: an email-backed member
    // of the ACTIVE round is marked `gone` and their spot survives until the
    // grace timer below expires (which then applies the leave rules) or a
    // resume rebinds it (restorePlayer). Everyone else leaves immediately.
    if (!roundDeferLeave(socket.id)) roundHandleLeave(socket.id);
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
            // Grace expired without a resume: the sprite is gone, but a round
            // member's SPOT gets the longer ROUND_REJOIN_MS hold (slow reloads
            // outlive the session grace) — non-members leave-check immediately.
            roundScheduleGoneLeave(socket.id);
            console.log(`${p.name} left (grace expired)`);
          }, GRACE_MS),
        };
        // Flush final position so a restore AFTER grace expiry still resumes here.
        try {
          await pool.query(
            `UPDATE jpo_players SET x = $2, y = $3, dir = $4, anim = $5, updated_at = now() WHERE email = $1`,
            [email, Math.round(p.x ?? GRASS_SPAWN.x), Math.round(p.y ?? GRASS_SPAWN.y), p.dir || "down", p.anim === "sit" ? "sit" : "idle"],
          );
        } catch (err) { console.error("disconnect flush failed:", err); }
      } else {
        // Session-only player: nothing durable to resume — remove immediately.
        console.log(`${p.name} left`);
        io.emit("playerLeft", socket.id);
      }
    }
    // A pending trade can't survive either side leaving — the accept-time SQL
    // would fail anyway (no live player), so end it cleanly and tell the peer.
    const t = tradeBySocket.get(socket.id);
    if (t && t.state === "pending") clearTrade(t, "Trade cancelled — they left the office.");
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
// Huddles' tables: CREATE IF NOT EXISTS keeps prod (whose DB is separate and
// never migrated by drizzle push) self-healing on the first boot after a
// publish — same policy as the column nudges below.
try {
  await pool.query(`CREATE TABLE IF NOT EXISTS jpo_coach (
    email text PRIMARY KEY,
    intake jsonb,
    intake_at timestamptz,
    mission_date date,
    mission jsonb,
    mission_done_at timestamptz,
    rerolled boolean NOT NULL DEFAULT false
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS jpo_pair_plays (
    email_a text NOT NULL,
    email_b text NOT NULL,
    games integer NOT NULL DEFAULT 0,
    first_played_at timestamptz NOT NULL DEFAULT now(),
    last_played_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (email_a, email_b)
  )`);
} catch (err) {
  console.error("schema nudge (coach tables) failed:", err);
}

try {
  await pool.query(`ALTER TABLE jpo_players ADD COLUMN IF NOT EXISTS dismissed boolean NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE jpo_players ADD COLUMN IF NOT EXISTS wins jsonb NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`ALTER TABLE jpo_players ADD COLUMN IF NOT EXISTS hobby text NOT NULL DEFAULT ''`);
  // Pet accessories (July 2026): the worn accessory slot ('' = bare pet).
  // Idempotent self-heal so prod gets the column on first boot after deploy.
  await pool.query(`ALTER TABLE jpo_players ADD COLUMN IF NOT EXISTS equipped_pet_acc text NOT NULL DEFAULT ''`);
  // New-registrant spawn moved to the west-entrance lawn (GRASS_SPAWN, July
  // 2026). The registration INSERT relies on these column defaults, and
  // drizzle push only runs against dev — so prod gets the new defaults here
  // (idempotent, no-op once set). Keeps the GRASS_SPAWN three-way lockstep
  // true in every environment.
  await pool.query(`ALTER TABLE jpo_players ALTER COLUMN x SET DEFAULT ${GRASS_SPAWN.x}`);
  await pool.query(`ALTER TABLE jpo_players ALTER COLUMN y SET DEFAULT ${GRASS_SPAWN.y}`);
  // Retired pet accessories: refund + strip + un-equip (see RETIRED_PET_ACCS).
  // WHERE owns the idempotency — a refunded player no longer matches.
  for (const [id, refund] of Object.entries(RETIRED_PET_ACCS)) {
    const { rowCount } = await pool.query(
      `UPDATE jpo_players
          SET coins = coins + $2,
              cosmetics = array_remove(cosmetics, $1),
              equipped_pet_acc = CASE WHEN equipped_pet_acc = $1 THEN '' ELSE equipped_pet_acc END,
              updated_at = now()
        WHERE $1 = ANY(cosmetics)`,
      [id, refund]);
    if (rowCount) console.log(`retired ${id}: refunded ${refund} coins to ${rowCount} player(s)`);
  }
} catch (err) {
  console.error("schema nudge (columns) failed:", err);
}

// Live price overrides: create the table (self-healing, same policy as the
// nudges above) and fold saved overrides into the in-memory catalogs BEFORE
// listen — every buy handler and every priceList emit then just works.
try {
  await pool.query(`CREATE TABLE IF NOT EXISTS jpo_shop_prices (
    item_id text PRIMARY KEY,
    price integer NOT NULL
  )`);
  const { rows } = await pool.query(`SELECT item_id, price FROM jpo_shop_prices`);
  for (const r of rows) {
    const cat = catalogOf(r.item_id);
    if (cat && Number.isInteger(r.price) && r.price >= PRICE_MIN && r.price <= PRICE_MAX) {
      cat[r.item_id] = r.price;
      console.log(`price override: ${r.item_id} → ${r.price}`);
    }
  }
} catch (err) {
  console.error("schema nudge (shop prices) failed:", err);
}

// Bid stores: listings + escrowed bids + queued outcome messages. Same
// self-healing CREATE IF NOT EXISTS policy — prod builds these on first boot.
try {
  await pool.query(`CREATE TABLE IF NOT EXISTS jpo_store_listings (
    id serial PRIMARY KEY,
    seller_email text NOT NULL,
    item_id text NOT NULL,
    min_bid integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (seller_email, item_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS jpo_store_bids (
    id serial PRIMARY KEY,
    listing_id integer NOT NULL REFERENCES jpo_store_listings(id) ON DELETE CASCADE,
    bidder_email text NOT NULL,
    amount integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (listing_id, bidder_email)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS jpo_store_msgs (
    id serial PRIMARY KEY,
    email text NOT NULL,
    message text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
} catch (err) {
  console.error("schema nudge (bid stores) failed:", err);
}

const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
  console.log(`JPO Huddle server running on port ${port}`);
});
