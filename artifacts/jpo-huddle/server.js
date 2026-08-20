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
import {
  GRAND_EVENT_ALLOWED_COUNTS,
  grandEventBattleDecision,
  grandEventOpeningPlan,
} from "./grand-event-rules.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";  // no insecure default: admin features stay disabled until this env/secret is set
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || "";  // OPTIONAL second key: unlocks F8 like ADMIN_PASSWORD *plus* owner-only tools (coin adjust). Disabled until set.
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
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 8_000,   // fail fast during network blips instead of hanging
  keepAlive: true,                  // ride out idle-connection resets at peak hours
});
pool.on("error", (err) => console.error("Postgres pool error:", err));

// SAFETY NET — one un-caught DB timeout must NEVER take the whole office down.
// On 2026-08-07 a peak-hour connection-timeout storm surfaced one unhandled
// promise rejection and Node killed the process, dropping ~85 players at once.
// Log loudly and keep serving; the periodic ticks re-heal any missed write.
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION (server kept alive):", err);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION (server kept alive):", err);
});

const app        = express();
const httpServer = createServer(app);
// maxHttpBufferSize: chat images arrive as base64 data URLs — a 2 MB image is
// ~2.73 MB of base64, so allow 3.5 MB per socket.io packet (default is 1 MB).
const io         = new Server(httpServer, { maxHttpBufferSize: 3_500_000 });

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
      petBattleForfeitForLeave(id);   // active pet battle → forfeit (mirrors the rps seam)
      // Round-leave seam, same as disconnect/kickPlayer/dropLiveByEmail —
      // without it a purge mid-round leaves unkillable ghost members and the
      // round zombie-runs to the timer. Keyed off round.members, so calling
      // it before/after the players[] delete both work; order matches
      // dropLiveByEmail (delete first is fine).
      roundHandleLeave(id);
      rlglHandleLeave(id);
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

// Static assets get a real cache policy. Without one, browsers fall back to
// heuristic caching (10% of file age) — right after a deploy that's ~seconds,
// so the race sprite loop (img.src swap every 130ms × N pets) turned into a
// request flood over the internet: frozen sprites + hard lag on production,
// invisible in dev where localhost round-trips are ~1ms. Art files are stable;
// when one truly changes, players pick it up within a day.
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    if (/\.(png|jpe?g|gif|webp|svg|mp3|ogg|wav)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=86400");
    }
  },
}));

// ── Live-connection cache (ephemeral, per server process) ────────────────────
const pending = {};   // socketId → { firstName, lastName, email, character, name, hairIdx, skinIdx, shirtIdx, pantsIdx }
const players = {};   // socketId → live player state (mirrors a jpo_players row for online, approved players)
const admins  = new Set();   // socketIds authenticated as admin this session (never persisted)
const owners  = new Set();   // subset of admins who entered OWNER_PASSWORD — unlocks owner-only tools
let _whisperLogN = 0;        // module-scope so the whisper-log prune counts ALL traffic, not per-connection

// ── Admin activity log ───────────────────────────────────────────────────────
// Every mutation made from the F8 panel is written to jpo_admin_log with WHO
// did it (the admin's player name+email at that moment), so the owner can see
// exactly what other password-holders touched. Fire-and-forget: a log failure
// must never break the admin action itself.
const ADMIN_LOG_MAX = 5000;   // newest rows kept; older ones pruned on write
function logAdmin(socket, action, detail = "") {
  const p = players[socket.id];
  const who = p ? `${p.name}${p.email ? ` (${p.email})` : ""}` : "Unknown admin";
  pool
    .query(`INSERT INTO jpo_admin_log (admin_name, action, detail) VALUES ($1, $2, $3)`,
      [who.slice(0, 120), String(action).slice(0, 60), String(detail).slice(0, 400)])
    .then(() => {
      // Retention: keep the newest ADMIN_LOG_MAX rows so the table can't grow
      // without bound. Cheap enough to run per write at this office's scale.
      return pool.query(
        `DELETE FROM jpo_admin_log
          WHERE id <= (SELECT id FROM jpo_admin_log ORDER BY id DESC OFFSET $1 LIMIT 1)`,
        [ADMIN_LOG_MAX],
      );
    })
    .catch((err) => console.error("admin log write failed:", err));
}

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
// Blackout rule: EVERY number on the card must be daubed (free center is free).
function bingoHasBlackout(card, daubs) {
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) {
    const n = card[r][c];
    if (n !== 0 && !daubs.has(n)) return null;
  }
  return "BLACKOUT";
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
    ? setInterval(bingoCallNext, bingo.callMs || BINGO_CALL_MS) : null;
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
  io.emit("bingoStart", { gameId: bingo.id, playerCount: bingo.players.size, prize: bingo.prize, mode: bingo.mode, rule: bingo.rule, names: [...bingo.players.values()].map((v) => v.name) });
  console.log(`BINGO active: ${bingo.players.size} players (${bingo.mode} calling)`);
  bingoSetMode(bingo.mode);
}

// ── Deal or No Deal (OWNER-hosted show, ephemeral) ──────────────────────────
// The Vince Show: the OWNER (not plain admins) opens the board, the office
// votes which briefcase opens next, and the owner drops live Banker offers.
// DEAL (majority) → every joined player gets the offer amount. Riding it to
// the final case splits that case's value between everyone. House pays; free
// to join. Players keyed by EMAIL like bingo so a refresh keeps their seat.
let deal = null;   // { id, state:'joining'|'voting'|'offer', jackpot, cases:[{v,opened}], players:Map(email->{name}), votes:Map, dealVotes:Map, round, offer, joinDeadline, phaseDeadline, joinTimer, phaseTimer }
let dealGameSeq = 0;
const DEAL_JOIN_MS   = Number(process.env.DEAL_JOIN_MS)   || 60_000;
const DEAL_VOTE_MS   = Number(process.env.DEAL_VOTE_MS)   || 20_000;
const DEAL_OFFER_MS  = Number(process.env.DEAL_OFFER_MS)  || 25_000;
const DEAL_REVEAL_MS = Number(process.env.DEAL_REVEAL_MS) || 4_000;
const DEAL_BANKER_MS = Number(process.env.DEAL_BANKER_MS) || 45_000;  // owner gets this long to make an offer before the show rolls on
// Classic show cadence: open 5 cases, offer break, 4, break, 3, 2, 1, 1, ...
// (env override like DEAL_BLOCKS=15 exists purely for fast tests)
const DEAL_BLOCKS = (process.env.DEAL_BLOCKS || "5,4,3,2,1").split(",").map(Number);
const DEAL_JACKPOT_MIN = 500, DEAL_JACKPOT_MAX = 50_000;
// 16 case values as fractions of the jackpot — a classic junk-to-jackpot ladder.
const DEAL_FRACS = [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.04, 0.06,
                    0.09, 0.13, 0.18, 0.25, 0.35, 0.5, 0.7, 1];
function dealStop() {
  if (!deal) return;
  clearTimeout(deal.joinTimer);
  clearTimeout(deal.phaseTimer);
  deal = null;
}
// Public snapshot — safe for every client (values of OPENED cases only; the
// closed cases' contents never leave the server until they're opened).
function dealSnap() {
  if (!deal) return null;
  return {
    gameId: deal.id, state: deal.state, jackpot: deal.jackpot, round: deal.round,
    ladder: deal.cases.map((c) => c.v).sort((a, b) => a - b),
    opened: deal.cases.map((c) => (c.opened ? c.v : null)),
    names: [...deal.players.values()].map((v) => v.name),
    offer: deal.state === "offer" ? deal.offer : null,
    teamCase: deal.teamCase,
    toOpen: deal.blockLeft, blockSize: deal.blockSize,
    msLeft: deal.state === "joining"
      ? Math.max(0, deal.joinDeadline - Date.now())
      : Math.max(0, (deal.phaseDeadline || 0) - Date.now()),
  };
}
function dealBegin() {
  if (!deal || deal.state !== "joining") return;
  if (deal.players.size < 2) {
    io.emit("dealOver", { gameId: deal.id, message: "Deal or No Deal cancelled — not enough players joined." });
    dealStop();
    return;
  }
  console.log(`DEAL active: ${deal.players.size} players, jackpot ${deal.jackpot}`);
  dealPickPhase();
}
// Opening act: the office picks the TEAM's briefcase. It stays sealed on the
// board; ride all the way and whatever is inside gets split between everyone.
function dealPickPhase() {
  if (!deal) return;
  deal.state = "pickcase";
  deal.votes = new Map();
  deal.phaseDeadline = Date.now() + deal.voteMs;
  clearTimeout(deal.phaseTimer);
  deal.phaseTimer = setTimeout(dealResolvePick, deal.voteMs);
  io.emit("dealPhase", dealSnap());
}
// Two-strikes rule: every vote window (team-case pick, case votes, DEAL /
// NO DEAL offers) counts. Sit out two of them total and the Banker cuts your
// line — you're out of the show and out of every payout from then on.
// Called when a vote window closes, with the map of who actually voted.
function dealTrackMisses(voted) {
  if (!deal) return;
  const booted = [];
  for (const [em, p] of deal.players) {
    if (voted.has(em)) continue;
    const n = (deal.misses.get(em) || 0) + 1;
    deal.misses.set(em, n);
    if (n >= 2) booted.push({ em, name: p.name });
  }
  if (!booted.length) return;
  for (const { em, name } of booted) {
    deal.players.delete(em);
    deal.misses.delete(em);
    const sid = liveSocketIdByEmail(em);
    if (sid) io.to(sid).emit("dealKicked", { gameId: deal.id, message: "📵 You sat out two votes — the Banker cut your line. You're out of the show (and out of the payout)." });
    console.log(`DEAL kicked ${em} (${name}) — missed 2 votes`);
  }
  const names = [...deal.players.values()].map((p) => p.name);
  io.emit("dealBooted", { gameId: deal.id, kicked: booted.map((b) => b.name), names });
  io.emit("dealNames", { gameId: deal.id, names });
  if (deal.players.size === 0) {
    // Everybody stopped voting — there's no one left to pay. End the show.
    const gameId = deal.id;
    dealStop();
    io.emit("dealOver", { gameId, mode: "cancelled", per: 0, message: "📺 The whole office stopped voting — the Banker hung up. Show over, nobody gets paid." });
    console.log("DEAL cancelled: every entrant kicked for not voting");
  }
}
function dealResolvePick() {
  if (!deal || deal.state !== "pickcase") return;
  dealTrackMisses(deal.votes);
  if (!deal) return;   // everyone kicked → show already cancelled
  const tally = new Map();
  for (const i of deal.votes.values()) tally.set(i, (tally.get(i) || 0) + 1);
  let best = [], bestN = 0;
  for (const [i, n] of tally) {
    if (n > bestN) { best = [i]; bestN = n; }
    else if (n === bestN) best.push(i);
  }
  if (best.length === 0) best = deal.cases.map((_, i) => i);
  deal.teamCase = best[Math.floor(Math.random() * best.length)];
  io.emit("dealTeamCase", { gameId: deal.id, i: deal.teamCase, votes: bestN });
  console.log(`DEAL team case picked: ${deal.teamCase + 1}`);
  clearTimeout(deal.phaseTimer);
  deal.phaseTimer = setTimeout(dealVotePhase, 2500);
}
function dealVotePhase() {
  if (!deal) return;
  // New block? Load the next chunk of the 5-4-3-2-1 cadence.
  if (deal.blockLeft <= 0) {
    deal.blockSize = DEAL_BLOCKS[Math.min(deal.blockIdx, DEAL_BLOCKS.length - 1)];
    // only the non-team cases are openable; the team case stays sealed
    const openable = deal.cases.filter((c, i) => !c.opened && i !== deal.teamCase).length;
    deal.blockSize = Math.min(deal.blockSize, Math.max(1, openable));
    deal.blockLeft = deal.blockSize;
    deal.blockIdx++;
  }
  deal.state = "voting";
  deal.round++;
  deal.votes = new Map();
  deal.phaseDeadline = Date.now() + deal.voteMs;
  clearTimeout(deal.phaseTimer);
  deal.phaseTimer = setTimeout(dealResolveVote, deal.voteMs);
  io.emit("dealPhase", dealSnap());
}
// Offer break between blocks: the floor goes quiet and the Banker's phone
// rings. The owner has DEAL_BANKER_MS to put an offer up (or skip); if they
// wander off, the show rolls on by itself.
function dealBankerPhase() {
  if (!deal) return;
  deal.state = "banker";
  deal.phaseDeadline = Date.now() + DEAL_BANKER_MS;
  clearTimeout(deal.phaseTimer);
  deal.phaseTimer = setTimeout(() => {
    if (!deal || deal.state !== "banker") return;
    io.emit("dealNoDeal", { gameId: deal.id, yes: 0, no: 0, skipped: true });
    dealVotePhase();
  }, DEAL_BANKER_MS);
  io.emit("dealPhase", dealSnap());
}
function dealResolveVote() {
  if (!deal || deal.state !== "voting") return;
  dealTrackMisses(deal.votes);
  if (!deal) return;   // everyone kicked → show already cancelled
  // Most-voted unopened case; no votes at all → random (the show must go on).
  const tally = new Map();
  for (const i of deal.votes.values()) tally.set(i, (tally.get(i) || 0) + 1);
  let best = [], bestN = 0;
  for (const [i, n] of tally) {
    if (n > bestN) { best = [i]; bestN = n; }
    else if (n === bestN) best.push(i);
  }
  if (best.length === 0) best = deal.cases.map((c, i) => (c.opened || i === deal.teamCase ? -1 : i)).filter((i) => i >= 0);
  const pick = best[Math.floor(Math.random() * best.length)];
  const c = deal.cases[pick];
  if (!c || c.opened || pick === deal.teamCase) { dealVotePhase(); return; }   // paranoia — revote
  c.opened = true;
  // Reveal window is NOT interruptible — no Banker offers until the next
  // voting round starts (and never once the final case is being paid out).
  deal.state = "revealing";
  const openable = deal.cases.filter((x, i) => !x.opened && i !== deal.teamCase).length;
  io.emit("dealOpen", { gameId: deal.id, i: pick, v: c.v, votes: bestN, casesLeft: openable + 1 });
  console.log(`DEAL open case ${pick + 1}: ${c.v} (${openable} openable left)`);
  if (openable === 0) {
    // Finale: only the TEAM's sealed case is left — crack it open and split it.
    const gameId = deal.id, teamIdx = deal.teamCase, v = deal.cases[teamIdx].v;
    const entrants = [...deal.players.keys()];
    const per = Math.max(1, Math.floor(v / entrants.length));
    const names = [...deal.players.values()].map((p) => p.name);
    clearTimeout(deal.phaseTimer);
    deal.phaseTimer = setTimeout(() => {
      dealStop();
      dealPayAll(gameId, entrants, per,
        { gameId, mode: "final", i: teamIdx, v, per, names,
          message: `💼 THE TEAM'S CASE: ${v.toLocaleString()} coins inside — split ${entrants.length} ways, ${per.toLocaleString()} each!` });
    }, DEAL_REVEAL_MS);
    return;
  }
  deal.blockLeft--;
  clearTimeout(deal.phaseTimer);
  // Block finished → Banker break. Otherwise keep opening this block's cases.
  deal.phaseTimer = setTimeout(deal.blockLeft <= 0 ? dealBankerPhase : dealVotePhase, DEAL_REVEAL_MS);
}
function dealResolveOffer() {
  if (!deal || deal.state !== "offer") return;
  // Strikes first, so the majority below is measured against who's still in.
  dealTrackMisses(deal.dealVotes);
  if (!deal) return;   // everyone kicked → show already cancelled
  const votes = [...deal.dealVotes.values()];
  const yes = votes.filter(Boolean).length, no = votes.length - yes;
  // A DEAL needs a true majority of ALL entrants — abstaining is a quiet NO.
  if (yes > deal.players.size / 2) {
    // The offer is ONE pot, split evenly — same rule as the cases themselves.
    const gameId = deal.id, total = deal.offer, entrants = [...deal.players.keys()];
    const per = Math.max(1, Math.floor(total / entrants.length));
    const names = [...deal.players.values()].map((p) => p.name);
    dealStop();
    dealPayAll(gameId, entrants, per,
      { gameId, mode: "deal", total, per, yes, no, names,
        message: `🤝 DEAL! The office takes the Banker's ${total.toLocaleString()} coins — split ${entrants.length} ways, ${per.toLocaleString()} each (${yes}–${no}).` });
  } else {
    io.emit("dealNoDeal", { gameId: deal.id, yes, no });
    console.log(`DEAL offer refused ${yes}-${no}`);
    clearTimeout(deal.phaseTimer);
    deal.phaseTimer = setTimeout(dealVotePhase, 2000);
  }
}
// Pay every entrant `per` coins (house money), then announce. Awarded by
// EMAIL like the bingo prize, so a mid-payout refresh can't dodge or double.
// ONE attempt per player on purpose: `coins = coins + N` is not idempotent,
// and a retry after an ambiguous connection error could pay someone twice.
// A failed payout is loudly flagged for a manual award instead.
async function dealPayAll(gameId, emails, per, overMsg) {
  let paid = 0;
  const failed = [];
  for (const em of emails) {
    try {
      const { rows } = await pool.query(
        `UPDATE jpo_players SET coins = coins + $2, updated_at = now() WHERE email = $1 RETURNING coins`,
        [em, per]);
      if (rows.length) {
        paid++;
        for (const [sid, lp] of Object.entries(players)) {
          if (lp.email === em) { lp.coins = rows[0].coins; io.to(sid).emit("coinUpdate", { coins: rows[0].coins }); }
        }
      } else failed.push(em);
    } catch (err) { failed.push(em); console.error(`deal payout failed for ${em}:`, err); }
  }
  for (const em of failed) console.error(`DEAL PAYOUT FAILED for ${em} (+${per}) — award manually`);
  io.emit("dealOver", paid === emails.length ? overMsg
    : { ...overMsg, message: overMsg.message + ` (⚠️ ${emails.length - paid} payout(s) failed — the owner should award those manually.)` });
  console.log(`DEAL over: ${per} coins × ${paid}/${emails.length} players`);
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
  // Aug 2026 shop cleanup: tiered pricing by category (hats / eyewear /
  // audio / accessories). Keep in lockstep with client COSMETICS labels.
  beanie:       4000,
  flatcap:      4500,
  beret:        5000,
  cap:          5500,
  chefhat:      6000,
  rangerhat:    6500,
  scifihelmet: 10000,
  crown:       12000,
  spectacles:   2500,
  sunglasses:   3000,
  shades:       3500,
  headphones:   4500,
  gamerheadset: 5500,
  catears:      6500,
  book:         3000,
  camera:       4000,
  chain:        6000,
  guitar:       7500,
  // Seasonal wearables (see SEASONAL_ITEMS below): buyable only in-season.
  // These use the NEW outfit slots (WEAR_SLOT), not the legacy single slot.
  rainboots:    3500,
  umbrella:     4000,
  raincoat:     6000,
  // Wings: 8k–30k ladder, cheapest first (fairy tops the list).
  // phoenixwings is RARE: gift-only, price 0 (see RARE_COSMETICS).
  fairywings:   8000,
  beewings:    10000,
  batwings:    12000,
  butterflywings: 14000,
  angelwings:  18000,
  devilwings:  18000,
  jetpackwings: 24000,
  goldenwings: 30000,
  phoenixwings: 0,
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
  // Seasonal pet (see SEASONAL_PETS): buyable only during rainy season.
  pet_frog:             12000,
  pet_dragon_obsidian:  45000,
  pet_unicorn:          0,
  pet_phoenix:          0,
};

// Rare pets (Aug 2026): listed in the shop so everyone can drool over them,
// but NOT buyable at any price — the only way in is an owner grant (F8 →
// OWNER_PASSWORD tier, same gate as coin adjustments; plain admins can't).
// Price 0 in PETS keeps equip/trade/anchor pipelines working untouched.
const RARE_PETS = new Set(["pet_unicorn", "pet_phoenix"]);
// Rare wearables work the same way (gift-only via the F8 owner panel).
const RARE_COSMETICS = new Set(["phoenixwings"]);
// Union used by every "rares never change hands / have no price" guard.
const RARE_IDS = new Set([...RARE_PETS, ...RARE_COSMETICS]);

// ── Seasonal calendar (owner's schedule, Aug 2026) ──────────────────────────
// Seasonal shop stock only exists while its season is on: the client hides
// off-season rows, and (authoritatively) the buy handlers below REJECT
// off-season purchases — client hiding alone is not a gate. Equip/ownership
// paths are deliberately NOT gated: you keep and can wear what you bought
// year-round; only the ability to BUY comes and goes. Keep in lockstep with
// the client's seasonNow() copy in public/index.html.
function seasonNow(d = new Date()) {
  const m = d.getMonth(), day = d.getDate();   // m is 0-based
  if (m === 7 || m === 8 || (m === 9 && day <= 10)) return "rainy";        // Aug 1 – Oct 10
  if ((m === 9 && day >= 11) || (m === 10 && day <= 4)) return "halloween"; // Oct 11 – Nov 4
  if ((m === 10 && day >= 5) || (m === 11 && day <= 26)) return "christmas";// Nov 5 – Dec 26
  if ((m === 11 && day >= 27) || (m === 0 && day <= 15)) return "newyears"; // Dec 27 – Jan 15
  if ((m === 0 && day >= 16) || (m === 1 && day <= 16)) return "valentines";// Jan 16 – Feb 16
  return null;
}
const SEASONAL_ITEMS = { raincoat: "rainy", umbrella: "rainy", rainboots: "rainy" };
const SEASONAL_PETS  = { pet_frog: "rainy" };

// ── Outfit slots (Aug 2026) ──────────────────────────────────────────────────
// Owner rule: head / neck / top / bottom wearables must all be wearable AT THE
// SAME TIME. The legacy single equipped_cosmetic slot keeps serving hats,
// eyewear, audio and hand-held extras exactly as before (zero migration);
// NEW body wearables declare a slot here and live in their own DB column, so
// they stack with the legacy slot and wings. An item absent from WEAR_SLOT
// equips into the legacy slot.
const WEAR_SLOT = { raincoat: "top", rainboots: "feet", umbrella: "held" };
const SLOT_COL  = { top: "equipped_top", bottom: "equipped_bottom", neckwear: "equipped_neckwear", held: "equipped_held", feet: "equipped_feet" };
const SLOT_KEYS = ["top", "bottom", "neckwear", "held", "feet"];
const emptySlots = () => ({ top: "", bottom: "", neckwear: "", held: "", feet: "" });
// Wings are their OWN equip slot (Aug 2026): you wear wings AND a wearable
// at the same time. Ownership still lives in the shared cosmetics array;
// only the equipped slot differs (jpo_players.equipped_wings).
const WINGS_IDS = new Set(["fairywings", "beewings", "batwings", "butterflywings",
  "angelwings", "devilwings", "jetpackwings", "goldenwings", "phoenixwings"]);

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
// NOTE: always BASE prices (overrides included, sale NOT applied). Clients
// apply the sale % themselves from saleState, so the F8 editor keeps seeing
// true base prices and can never accidentally save a discounted number.
function allPrices() { return { ...SHOP, ...PETS, ...PET_ACCESSORIES }; }

// ── Flash sale (Aug 2026) ────────────────────────────────────────────────────
// Instead of retyping every price, the owner enters "X% off for N minutes"
// (F8 → Prices). Every non-rare shop/pet/accessory price is discounted at
// BUY time via salePrice(); base prices/overrides are untouched, so when the
// timer runs out (or the owner ends it) everything snaps back automatically.
// Persisted in jpo_flash_sale so a restart mid-sale keeps the sale honest.
let sale = null;          // { percent, endsAt(ms) } or null
let _saleTimer = null;
const SALE_PCT_MIN = 1, SALE_PCT_MAX = 90, SALE_MIN_MINUTES = 1, SALE_MAX_MINUTES = 7 * 24 * 60;
function saleActive() { return !!(sale && Date.now() < sale.endsAt); }
function salePrice(c) {
  if (!c || !saleActive()) return c;   // undefined/0 stays as-is — buy gates rely on falsy cost
  return Math.max(1, Math.round(c * (100 - sale.percent) / 100));
}
function _saleState() { return saleActive() ? { percent: sale.percent, endsAt: sale.endsAt } : null; }
function _armSale(percent, endsAt) {
  sale = { percent, endsAt };
  clearTimeout(_saleTimer);
  _saleTimer = setTimeout(() => { _endSale("expired"); }, Math.max(0, endsAt - Date.now()) + 250);
}
async function _endSale(reason) {
  clearTimeout(_saleTimer); _saleTimer = null;
  if (!sale) return;
  sale = null;
  try { await pool.query(`DELETE FROM jpo_flash_sale`); }
  catch (err) { console.error("flash sale cleanup failed:", err); }
  io.emit("saleState", null);
  io.emit("priceList", allPrices());
  console.log(`Flash sale ended (${reason}).`);
}

// ── Ms. Poli, the HR librarian (Aug 2026) ────────────────────────────────────
// A STATIONARY NPC by the lounge "library" corner. Press E → one Code of
// Discipline question per person per UTC day (deterministic per email+day, so
// posting "today's answer" in chat doesn't help much). First-try correct pays
// full; getting it right after research still pays a little. Wrong answers
// nudge people to read the shelf or literally ask HR (Junell/Claire/Klynn) —
// that's the bonding part, straight from HR's own idea.
// Same NPC rules as Huddles: lives OUTSIDE `players`, own hr* events.
const HR_NPC = {
  id: "npc:hr", name: "Ms. Poli · HR", character: "amelia",
  hairIdx: 5, skinIdx: 2, shirtIdx: 3, pantsIdx: 1,
  x: 1800, y: 4488, dir: "down", anim: "idle",   // lounge corner — confirmed open floor (tile 37,93)
};
const HR_TALK_RADIUS   = 200;      // same feel as Huddles
const HR_SESSION_MS    = 120000;   // stamp window (same pattern as coachTalkAt)
const HR_QUIZ_PAY_FIRST = 100;     // first attempt correct
const HR_QUIZ_PAY_LATE  = 50;      // correct after one or more wrong tries
const HR_QUIZ_MAX_TRIES = 6;       // per day — also caps AI grading spend per player
const hrSessionOk = (p) => p?.hrTalkAt && Date.now() - p.hrTalkAt < HR_SESSION_MS;
// Hand-authored from JPO's Code of Discipline (Ver. 2023-02) — answers cite
// the section so people can verify on the shelf. `ans` = index into opts.
const COD_QUIZ = [
  { q: "Simple offenses (Verbal Reprimand / Written Warning) are disregarded after how long?", opts: ["3 months", "6 months", "1 year", "Never — they stay forever"], ans: 1, ref: "General Guidelines #3" },
  { q: "If a simple offense ever reaches suspension, how long does it stay in your 201 file?", opts: ["6 months", "1 year", "Until the end of employment", "It gets erased after promotion"], ans: 2, ref: "General Guidelines #3" },
  { q: "Who is part of a formal Investigation Committee?", opts: ["Only the HR Manager", "Co-employee(s), Dept Manager, Security Officer (if applicable), HR Manager", "The CEO and the client", "Your teammates only"], ans: 1, ref: "General Guidelines #2" },
  { q: "A Notice To Explain (NTE) should be served within how long of discovering probable cause?", opts: ["24 hours", "48 hours", "5 days", "30 days"], ans: 0, ref: "Disciplinary Actions — Process #3" },
  { q: "After receiving an NTE, how many calendar days do you have to explain your side?", opts: ["24 hours", "3 days", "5 days", "15 days"], ans: 2, ref: "Disciplinary Actions — Process #4" },
  { q: "What is the FIRST step of the progressive discipline process?", opts: ["Written Warning", "Counseling / Verbal Reprimand", "Suspension", "NTE"], ans: 1, ref: "Disciplinary Actions — Definitions #1" },
  { q: "Suspension beyond how many days is considered suspension WITH pay?", opts: ["10 days", "15 days", "30 days", "60 days"], ans: 2, ref: "Disciplinary Actions — Definitions #3" },
  { q: "Suspensions can be given in which lengths?", opts: ["1, 2, 3 days", "5, 10, 15 days (max 30)", "Only 30 days", "7 or 14 days"], ans: 1, ref: "Disciplinary Actions — Definitions #3" },
  { q: "What's the 1st-offense penalty for tardiness (without approval)?", opts: ["Verbal Reprimand", "Written Warning", "3 days suspension", "Dismissal"], ans: 1, ref: "I. Attendance #1" },
  { q: "Tardiness counts as an infraction when you're late twice in a week OR accumulate how many minutes in a week?", opts: ["30 minutes", "45 minutes", "60 minutes", "90 minutes"], ans: 2, ref: "I. Attendance #1.1" },
  { q: "You're considered AWOL if you fail to notify your superior for more than how many days?", opts: ["1 day", "2 days", "3 days", "5 days"], ans: 2, ref: "I. Attendance #2" },
  { q: "On Critical Working Days, you're considered 'Missing' if unreachable for more than…", opts: ["15 minutes", "30 minutes", "1 hour", "2 hours"], ans: 0, ref: "I. Attendance — Note" },
  { q: "Which of these is NOT a Critical Working Day?", opts: ["Every Monday", "Payday", "The day after a holiday", "Every Friday"], ans: 3, ref: "I. Attendance — Note" },
  { q: "A Sick Leave application must be submitted to HRD within how long after returning to work?", opts: ["Same day", "2 days", "5 days", "1 week"], ans: 1, ref: "I. Attendance #3.1" },
  { q: "A Leave Notification should be filed at least how long before your shift?", opts: ["30 minutes", "1 hour", "2 hours", "24 hours"], ans: 2, ref: "I. Attendance #3.2" },
  { q: "Medical certificates from Telemedicine / online consultation are…", opts: ["Accepted with a receipt", "Accepted if signed", "Accepted on holidays only", "Not accepted"], ans: 3, ref: "I. Attendance — Note" },
  { q: "Accepting gifts, tokens, or bribes from clients/customers leads to…", opts: ["A verbal warning", "Coaching", "Employee dismissal", "A fine"], ans: 2, ref: "Professionalism / VII. Terminable #4" },
  { q: "Unexcused undertime becomes an infraction when it's more than… ", opts: ["15 minutes", "30 minutes", "1 hour", "2 hours"], ans: 2, ref: "I. Attendance #3.5" },
  { q: "Changes to your records (civil status, residence, etc.) must be reported within…", opts: ["7 days", "14 days", "30 days", "90 days"], ans: 2, ref: "III. Office Protocol #7" },
  { q: "1st offense for non-adherence to the dress code (onsite) is…", opts: ["Verbal Reprimand / Counseling", "Written Warning", "Suspension", "Dismissal"], ans: 0, ref: "III. Office Protocol #5" },
  { q: "Browsing the internet for personal use during work hours becomes an offense past…", opts: ["10 minutes", "30 minutes", "1 hour", "Any amount"], ans: 1, ref: "V. Company Property #7" },
  { q: "Sharing sensitive info like passwords, log-in accounts, or salary can lead to…", opts: ["Nothing if it's a friend", "Verbal warning only", "Suspension to dismissal depending on severity", "A written apology"], ans: 2, ref: "IV. Integrity #2" },
  { q: "Two successive below-average performance appraisals with no improvement means…", opts: ["Coaching", "Final warning", "Demotion", "Dismissal"], ans: 3, ref: "VII. Terminable #1" },
  { q: "A manager/supervisor who knows about a violation must report it within…", opts: ["24 hours", "48 hours", "5 days", "1 week"], ans: 1, ref: "Managers and Supervisors" },
  { q: "If two final written warnings are issued within the same category…", opts: ["They cancel out", "The next level of sanction applies", "HR restarts the count", "Nothing happens"], ans: 1, ref: "Disciplinary Actions — Process #8" },
  { q: "In the Twin-Notice rule, what is the second notice served for a justified termination?", opts: ["Notice To Explain", "Coaching Form", "Notice of Dismissal", "Incident Report"], ans: 2, ref: "Disciplinary Actions — Process #5" },
];
// Deterministic per email+day → a stable daily question per person.
function hrQuestionIdx(email, day) {
  let h = 0;
  const s = `${day}|${email}`;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % COD_QUIZ.length;
}
function hrQuizView(row, extra = {}) {
  const item = COD_QUIZ[row.qid] || COD_QUIZ[0];
  return {
    // Typed-answer mode: the options never leave the server — opts[ans] is
    // only the grading reference for the AI. No shelf, no choices: the
    // "research" path is literally walking to HR (Vince + HR's design).
    q: item.q, attempts: row.attempts, solved: row.solved,
    triesLeft: Math.max(0, HR_QUIZ_MAX_TRIES - row.attempts),
    ref: row.solved ? item.ref : undefined,   // the citation is the reward
    paid: row.paid || 0,
    ...extra,
  };
}
// AI semantic grading: "did they capture the main point?" — not word-for-word.
// Deliberately strict-but-fair prompt; the numeric fact must match. Throws on
// AI unavailability/timeouts so the caller can tell the player to retry (a
// grading failure must never burn an attempt).
async function hrGradeAnswer(item, answer) {
  const ai = coachAiClient();
  if (!ai) throw new Error("AI unavailable");
  const rsp = await Promise.race([
    ai.chat.completions.create({
      model: "gpt-5.6-terra",
      max_completion_tokens: 2048,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You grade a workplace policy quiz. You get a question, the official correct answer, and an employee's typed answer. Mark it correct if the employee's answer expresses the SAME key fact/meaning as the official answer — wording, spelling, grammar, language mix (English/Tagalog/Taglish) and extra detail don't matter. Numbers/durations/quantities must match the official answer. Vague non-answers, guesses of a different value, or contradictions are incorrect. Reply ONLY with JSON: {\"correct\": boolean}." },
        { role: "user", content: JSON.stringify({ question: item.q, official_answer: item.opts[item.ans], employee_answer: answer }) },
      ],
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("HR grading timeout (9s)")), 9000)),
  ]);
  const raw = rsp?.choices?.[0]?.message?.content || "";
  const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  return parsed.correct === true;
}

// ── Coin gifting (July 2026) ─────────────────────────────────────────────────
// Player→player coin sends. Per-sender daily cap keeps "send me coins"
// pressure and funneling in check. The cap ledger is in-memory (resets on
// restart) — it's a soft social guardrail, not a financial invariant; the
// transfer itself reuses the rpsSettle atomic pattern so a partial move is
// impossible.
const GIFT_DAILY_CAP = 5000;
const GIFT_NOTICE_MAX = 20;   // lingering gift receipts kept per recipient
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

// ── HQ-Buddy (August 2026) ───────────────────────────────────────────────────
// Secret DAILY pairings (weekly until Aug 2026 — the boss wanted a faster
// shuffle): every email-backed player gets ONE buddy per UTC day. Only the
// pair ever learns who's who — no broadcast carries buddy info. Perks: 1.25×
// coin ticks while standing near your buddy (daily minute cap), a bonus when
// the pair finishes a duel together (daily cap), and a one-shot "get to know
// you" quiz that pays per correct guess.
// Pairing is lazy: the first player of the day gets Huddles (the NPC) as a
// placeholder buddy; the next unpaired player upgrades that placeholder into
// a real pair. Odd player out simply keeps Huddles for the day.
// NOTE: the period id is still called "week" everywhere (vars, DB column,
// jpo_buddies.week) — it now just holds a day id. Renaming the column would
// strand prod history for zero benefit.
const BUDDY_NPC             = "__huddles__";
const BUDDY_EARN_MULT       = 1.25;
const BUDDY_BUFF_DAILY_MIN  = 1440;  // boosted minutes per player per UTC day (boss call: 1.25× runs 24/7, no cap)
const BUDDY_GAME_BONUS      = 50;    // coins EACH when the pair finishes a duel
const BUDDY_GAME_DAILY_CAP  = 5;     // duel bonuses per pair per UTC day
const BUDDY_QUIZ_PAY        = 100;   // coins per correct guess (3 questions)
function buddyWeek(now = new Date()) {
  // Period id = today's UTC date — a fresh buddy every day at 00:00 UTC.
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return d.toISOString().slice(0, 10);
}
// Daily caps live in jpo_buddy_caps (day,key → n) so a server restart can't
// hand out fresh allowances (same lesson as the chore-reset task). The
// INSERT..ON CONFLICT..WHERE n < cap is a single atomic consume: rowCount 0
// means the cap is spent (or a concurrent consume beat us) — never double-pays.
async function buddyCapConsume(key, cap) {
  const day = new Date().toISOString().slice(0, 10);
  const { rowCount } = await pool.query(
    `INSERT INTO jpo_buddy_caps (day, key, n) VALUES ($1, $2, 1)
     ON CONFLICT (day, key) DO UPDATE SET n = jpo_buddy_caps.n + 1
     WHERE jpo_buddy_caps.n < $3`,
    [day, key, cap]);
  return rowCount === 1;
}
// (socketIdByEmail lives with the chore helpers below — shared here.)
// Get-or-create this week's pairing for an email. Concurrency-safe via the
// (week,email) primary key: a raced upgrade rolls back and retries as a
// placeholder insert (ON CONFLICT DO NOTHING makes even that race harmless).
async function ensureBuddy(email) {
  const week = buddyWeek();
  const { rows } = await pool.query(`SELECT * FROM jpo_buddies WHERE week=$1 AND email=$2`, [week, email]);
  if (rows[0]) return rows[0];
  // Prefer not repeating last week's buddy when there's a choice.
  const prev = await pool.query(
    `SELECT buddy_email FROM jpo_buddies WHERE email=$1 AND week<>$2 ORDER BY week DESC LIMIT 1`, [email, week]);
  const avoid = prev.rows[0]?.buddy_email || "";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Claim a Huddles-placeholder atomically: the subselect takes a row lock
    // (SKIP LOCKED — two simultaneous logins can never grab the same
    // placeholder), and the UPDATE re-checks buddy_email so a claim that
    // committed between plan and lock can't be stolen.
    const claim = await client.query(
      `UPDATE jpo_buddies SET buddy_email=$2
        WHERE week=$1 AND buddy_email=$3 AND email = (
          SELECT email FROM jpo_buddies
           WHERE week=$1 AND buddy_email=$3 AND email<>$2
           ORDER BY (email = $4) ASC, email LIMIT 1
           FOR UPDATE SKIP LOCKED)
        RETURNING email`,
      [week, email, BUDDY_NPC, avoid]);
    if (claim.rows[0]) {
      const other = claim.rows[0].email;
      await client.query(
        `INSERT INTO jpo_buddies (week, email, buddy_email) VALUES ($1,$2,$3)`, [week, email, other]);
      await client.query("COMMIT");
      // The placeholder player just got a real buddy — refresh them live.
      const sid = socketIdByEmail(other);
      if (sid) { players[sid].buddyEmail = email; sendBuddyInfo(sid).catch(() => {}); }
      return { week, email, buddy_email: other };
    }
    // No claimable placeholder — become one.
    await client.query(
      `INSERT INTO jpo_buddies (week, email, buddy_email) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [week, email, BUDDY_NPC]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  const { rows: r2 } = await pool.query(`SELECT * FROM jpo_buddies WHERE week=$1 AND email=$2`, [week, email]);
  return r2[0] || null;
}
async function buddyDisplayName(email) {
  const { rows } = await pool.query(
    `SELECT COALESCE(NULLIF(nickname,''), NULLIF(first_name,''), name) AS display FROM jpo_players WHERE email=$1`, [email]);
  return rows[0]?.display || "your buddy";
}
// Private snapshot for ONE player — never broadcast.
async function sendBuddyInfo(socketId) {
  const p = players[socketId];
  if (!p || !p.email) return;
  try {
    const row = await ensureBuddy(p.email);
    if (!row) return;
    p.buddyEmail = row.buddy_email;   // cached for the coin tick
    const isNpc = row.buddy_email === BUDDY_NPC;
    let buddyAnswered = false;
    if (!isNpc) {
      const { rows } = await pool.query(
        `SELECT (quiz_answers IS NOT NULL) AS a FROM jpo_buddies WHERE week=$1 AND email=$2`, [row.week, row.buddy_email]);
      buddyAnswered = !!rows[0]?.a;
    }
    io.to(socketId).emit("buddyInfo", {
      week: row.week,
      buddyName: isNpc ? "Huddles" : await buddyDisplayName(row.buddy_email),
      isNpc,
      myAnswers: row.quiz_answers || null,
      buddyAnswered,
      quizScore: row.quiz_score,          // null until guessed
      mult: BUDDY_EARN_MULT,
      quizPay: BUDDY_QUIZ_PAY,
      gameBonus: BUDDY_GAME_BONUS,
    });
  } catch (e) {
    console.error("buddy info failed:", e);
  }
}
// Coin-tick helper: is this player currently standing near their buddy?
// (NPC buddy counts — hang out with Huddles.) Pure position check; the daily
// minute cap is consumed separately (DB) by the tick.
function buddyNearPos(p) {
  if (!p.email || !p.buddyEmail) return false;
  let bx, by;
  if (p.buddyEmail === BUDDY_NPC) { bx = NPC.x; by = NPC.y; }
  else {
    const sid = socketIdByEmail(p.buddyEmail);
    if (!sid) return false;
    bx = players[sid].x; by = players[sid].y;
  }
  const dx = p.x - bx, dy = p.y - by;
  return dx * dx + dy * dy <= GROUP_RADIUS * GROUP_RADIUS;
}
// Duel-finish hook: if the two participants are this week's pair, pay both a
// small bonus (capped per pair per day). Fire-and-forget from finishMatch.
async function buddyGameBonus(idA, idB) {
  const a = players[idA], b = players[idB];
  if (!a?.email || !b?.email) return;
  if (a.buddyEmail !== b.email || b.buddyEmail !== a.email) return;
  const pairKey = "game|" + [a.email, b.email].sort().join("|");
  if (!(await buddyCapConsume(pairKey, BUDDY_GAME_DAILY_CAP))) return;
  for (const p of [a, b]) {
    try {
      const { rows } = await pool.query(
        `UPDATE jpo_players SET coins = coins + $2 WHERE email = $1 RETURNING coins`, [p.email, BUDDY_GAME_BONUS]);
      if (rows[0]) p.coins = rows[0].coins;
    } catch (e) { console.error("buddy game bonus failed:", e); continue; }
    const sid = socketIdByEmail(p.email);
    if (sid) {
      io.to(sid).emit("coinUpdate", { coins: p.coins });
      io.to(sid).emit("buddyBonus", { amount: BUDDY_GAME_BONUS });
    }
  }
}
// Deterministic 3 questions per pair per week, drawn from IB_PROMPTS.
function buddyQuizQs(week, e1, e2) {
  const seed = crypto.createHash("sha1").update(`${week}|${[e1, e2].sort().join("|")}`).digest();
  const picks = [];
  for (let i = 0; picks.length < 3 && i < seed.length; i++) {
    const idx = seed[i] % IB_PROMPTS.length;
    if (!picks.includes(idx)) picks.push(idx);
  }
  return picks;
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

// Avatar makeover (hair colour and/or base character). First change is FREE,
// every one after costs AVATAR_PRICE. Tracked per-account in
// jpo_players.avatar_changes; the server is authoritative, client labels are
// display-only. Name is untouchable here — identity stays locked to the login.
const AVATAR_PRICE = 100;
const AVATAR_CHARS = ["adam", "alex", "amelia", "bob"];
const HAIR_MAX = 8;   // MUST equal client HAIR_COLORS.length - 1

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
// Shared-treat EARNINGS buff (coffee_round / pizza_party only — solo coffee is
// speed-only so nobody can farm their own coin rate). Applies to the coin tick
// and only activates when the treat reached someone besides the buyer.
const EARN_MULT      = 1.5;
const EARN_COFFEE_MS = 10 * 60_000;  // coffee round → 10 min of 1.5× earnings
const EARN_PIZZA_MS  = 20 * 60_000;  // pizza party → 20 min of 1.5× earnings

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
  // ── Office chore stations (August 2026 — see CHORES below) ─────────────
  // Small repeatable jobs on real map furniture. Several stations can share
  // ONE chore (same per-person cooldown — more stations are walk-distance
  // convenience, never a faster payout), mirroring the coffee-machine rule.
  chore_plants1:  { x: 9312, y: 2640, r: 150 }, // potted palm, Game Room (c193-194, r53-54)
  chore_plants2:  { x: 9984, y: 3264, r: 150 }, // potted palm, east hallway (c207-208, r66-67)
  chore_plants3:  { x: 4992, y: 5760, r: 150 }, // potted palm, basement office (c103-104, r118-119)
  chore_couch:    { x: 1728, y: 4608, r: 200 }, // lounge sofa row (c33-38, r94-95)
  chore_weights:  { x: 9960, y: 1104, r: 170 }, // kettlebell racks, Gym (c206-208, r21-24)
  chore_board:    { x: 2064, y: 4128, r: 150 }, // whiteboard + stool (c42-43, r84-85)
  chore_meeting1: { x: 4632, y: 5376, r: 200 }, // conference table, basement meeting room (c95-97, r108-111)
  chore_meeting2: { x: 7632, y: 3600, r: 180 }, // conference table, east meeting room (c158-159, r72-74)
};

// ── Office chores ────────────────────────────────────────────────────────
// Repeatable small jobs anyone can do for coins — an ACTIVE earning floor for
// new/broke players on top of the passive tick (COIN_TICK_BASE = 2/min =
// 120/hr). Doing every chore each hour adds at most 82/hr, so it's a floor
// for the poor, never a farm for the rich. Cooldowns are per player per
// CHORE (stations sharing a chore share its cooldown), in-memory like the
// coffee cooldown — a restart forgives them, which is fine at this stakes
// level. Station ids MUST exist in OBJECTS above and in the client's
// OFFICE_OBJECTS (the usual lockstep).
const CHORES = {
  plants:  { pay: 15, cooldownMs: 60 * 60_000, emoji: "🪴", line: "You water the office plants. They perk up gratefully." },
  couch:   { pay: 12, cooldownMs: 60 * 60_000, emoji: "🛋️", line: "You fluff the lounge cushions back into shape." },
  weights: { pay: 20, cooldownMs: 60 * 60_000, emoji: "🏋️", line: "You re-rack the stray kettlebells. The gym approves." },
  board:   { pay: 10, cooldownMs: 60 * 60_000, emoji: "🧽", line: "You wipe last sprint's scribbles off the whiteboard." },
  meeting: { pay: 25, cooldownMs: 60 * 60_000, emoji: "🧹", line: "You tidy the meeting room: chairs in, table cleared." },
};
// Station object id → chore id (many-to-one, like FOOD_STATIONS).
const CHORE_STATIONS = {
  chore_plants1: "plants", chore_plants2: "plants", chore_plants3: "plants",
  chore_couch: "couch", chore_weights: "weights", chore_board: "board",
  chore_meeting1: "meeting", chore_meeting2: "meeting",
};
// `${email|socketId}|${choreId}` → ts when that chore unlocks again.
const choreReadyAt = new Map();
// Remaining ms per chore for one player — sent on office entry so the client
// can show the "available again" sparkle without guessing.
function choreStateFor(key) {
  const now = Date.now();
  const out = {};
  for (const c of Object.keys(CHORES)) out[c] = Math.max(0, (choreReadyAt.get(key + "|" + c) || 0) - now);
  return out;
}
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
// Pet evolution (owner's Pokémon idea, Aug 2026): feed your equipped pet
// treats from the cafeteria and it levels up. Stage 2 ("evolved") at 30
// treats, stage 3 ("final form") at 70. XP is per-pet in jpo_players.pet_xp.
// No daily cap on purpose (owner: rich players may speedrun it).
// The client mirrors these thresholds for its stage rendering.
const PET_EVOLVE_XP = [30, 70];
const PET_TREAT_PRICE = 150;   // one price everywhere: cafeteria menu AND the click-your-pet panel
function petStageOf(xp) { return xp >= PET_EVOLVE_XP[1] ? 3 : xp >= PET_EVOLVE_XP[0] ? 2 : 1; }
// Mythical gift pets (unicorn, phoenix): TWO forms only — baby, then straight
// to FINAL FORM (stage 3) at the FIRST treat threshold. No middle stage.
const PET_MYTHIC = new Set(["pet_unicorn", "pet_phoenix"]);
function petStageOfPet(pet, xp) {
  return PET_MYTHIC.has(pet) ? (xp >= PET_EVOLVE_XP[0] ? 3 : 1) : petStageOf(xp);
}
function petStageFor(p) { return petStageOfPet(p.pet, ((p.petXp || {})[p.pet]) || 0); }

// ── Pet XP travels WITH the pet on ownership change (trade / market sale) ────
// The receiver keeps the better of the two histories (their own old feedings
// for that species vs the incoming pet's), and the giver's history for that
// pet is wiped — so an evolved pet arrives evolved, and the seller can't
// re-buy the species later and get a free pre-evolved one.
// Must run inside the same transaction as the ownership swap.
async function transferPetXpTx(client, fromEmail, toEmail, pet) {
  const { rows } = await client.query(
    `SELECT (pet_xp->>$2)::int AS xp FROM jpo_players WHERE email = $1`, [fromEmail, pet]);
  const xp = (rows.length && rows[0].xp) || 0;
  await client.query(
    `UPDATE jpo_players SET pet_xp = coalesce(pet_xp, '{}'::jsonb) - $2::text WHERE email = $1`,
    [fromEmail, pet]);
  const { rows: r2 } = await client.query(
    `UPDATE jpo_players
        SET pet_xp = jsonb_set(coalesce(pet_xp, '{}'::jsonb), ARRAY[$2::text],
                     to_jsonb(GREATEST(coalesce((pet_xp->>$2)::int, 0), $3::int)))
      WHERE email = $1
      RETURNING (pet_xp->>$2)::int AS xp`,
    [toEmail, pet, xp]);
  return (r2.length && r2[0].xp) || xp;   // receiver's final xp for this pet
}

// Shared feed path for BOTH the cafeteria pet-treat menu item and the
// click-your-pet "Feed" button. Coins out + XP in commit in ONE statement
// for account players, so a crash can't charge without feeding (or vice
// versa). Caller has already applied buy throttle + wager/round blocks.
async function feedPetTreat(io, socket, p) {
  if (!p.pet) { socket.emit("foodError", { message: "Adopt a pet first — the treat is for THEM! 🐾" }); return; }
  const pet = p.pet;
  let xp;
  if (!p.email) {
    if ((p.coins ?? 0) < PET_TREAT_PRICE) { socket.emit("foodError", { message: "Not enough coins!" }); return; }
    p.coins -= PET_TREAT_PRICE;
    p.petXp = p.petXp || {};
    xp = p.petXp[pet] = (p.petXp[pet] || 0) + 1;
  } else {
    try {
      const { rows } = await pool.query(
        `UPDATE jpo_players
            SET coins = coins - $2,
                pet_xp = jsonb_set(coalesce(pet_xp, '{}'::jsonb), ARRAY[$3::text],
                         to_jsonb(coalesce((pet_xp->>$3)::int, 0) + 1)),
                updated_at = now()
          WHERE email = $1 AND coins >= $2
          RETURNING coins, (pet_xp->>$3)::int AS xp`,
        [p.email, PET_TREAT_PRICE, pet],
      );
      if (rows.length === 0) { socket.emit("foodError", { message: "Not enough coins!" }); return; }
      p.coins = rows[0].coins;
      p.petXp = p.petXp || {};
      xp = p.petXp[pet] = rows[0].xp;
    } catch (err) { console.error("pet treat failed:", err); return; }
  }
  const stage = petStageOfPet(pet, xp), prevStage = petStageOfPet(pet, xp - 1);
  socket.emit("coinUpdate", { coins: p.coins });
  socket.emit("petFed", { pet, xp, stage,
    next: PET_MYTHIC.has(pet)
      ? (xp >= PET_EVOLVE_XP[0] ? null : PET_EVOLVE_XP[0])
      : (PET_EVOLVE_XP.find((t) => t > xp) ?? null) });
  io.emit("objectEffect", { id: socket.id, kind: "snack", emoji: "🦴" });
  if (stage > prevStage) {
    io.emit("playerPetUpdate", { id: socket.id, pet: p.pet, petAcc: p.petAcc, petStage: stage });
    io.emit("petEvolved", { id: socket.id, name: p.name, pet, stage,
                            petName: ((p.petNames || {})[pet]) || "" });
    console.log(`${p.name}'s ${pet} evolved to stage ${stage} (${xp} treats)`);
  }
  console.log(`${p.name} fed ${pet} a treat (xp ${xp})`);
}

// ══════════════════════════════════════════════════════════════════════════
// ── Pet Battle (Aug 2026): server-authoritative 1v1 pet combat for XP ──────
// ══════════════════════════════════════════════════════════════════════════
// A SECOND, wholly separate lifecycle from the rps/race duel roster: battles
// never touch coins and never share rpsBySocket. State lives in battleBySocket
// keyed by human socket id; the training bot has NO socket (its "id" is the
// opaque string BOT_ID). Match ids are server-generated opaque uuids, so a
// client can never forge/guess another match — every handler cross-checks the
// caller's socket owns the match it names.
//
// SECURITY INVARIANTS (why the client can't cheat):
//   • The server NEVER accepts client hp / stage / xp / crit / damage. It only
//     accepts a move name from {attack,guard,special,ultimate} and re-derives
//     everything from the START snapshot (pet id + stage + build), which is
//     frozen when the match starts and never re-read from the live player.
//   • Stats come from the snapshot's build (validated & persisted separately),
//     NOT from whatever the client claims at pick time.
//   • XP is awarded in ONE atomic transaction that first claims an idempotency
//     row (jpo_pet_battles), so reconnect/retry can't double-award. No client
//     receipt is ever trusted.
const BOT_ID          = "__petbot__";      // sentinel opponent id (no real socket)
const PB_BOT_REWARD_ID = "training-bot@jpo.system"; // durable pair-ledger identity for bot cooldowns
const PB_MOVES        = new Set(["attack", "guard", "special", "ultimate"]);
const PB_ACCEPT_MS    = 30_000;            // challenged player's accept/decline window
const PB_PICK_MS      = Math.max(500, Number(process.env.PET_BATTLE_PICK_MS) || 15_000); // test-overridable; no-pick = guard
const PB_MAX_ROUNDS   = 6;                 // hard cap — a stalemate at round 6 = higher-HP wins
const PB_RANGE_PX     = 480;               // "walk up to someone" — same reach as RPS_RANGE_PX (defined later)
const PB_BOT_MIN_MS   = 500;               // bot "thinks" for a natural beat before it picks…
const PB_BOT_MAX_MS   = 1_400;             // …somewhere in [min,max]
const PB_XP_WIN       = 3;                 // completed match: winner +3
const PB_XP_LOSE      = 1;                 // completed match: loser  +1
const PB_XP_FF_WIN    = 2;                 // forfeit: the remaining side +2
const PB_XP_FF_LOSE   = 0;                 // forfeit: the leaver +0
const PB_DAILY_CAP    = 10;                // rewarded battles per pet per UTC day
const PB_REMATCH_MS   = 5 * 60_000;        // same-opponent reward cooldown (5 min)
const PB_SPECIAL_CD   = 2;                 // 'special' unusable again for this many rounds
const PB_ULT_CHARGE   = 3;                 // 'ultimate' needs this much charge (built by attack/guard)

// ── Pet Wars Grand Event ────────────────────────────────────────────────────
// One durable, owner/admin-hosted single-elimination tournament at a time.
// Entrants are keyed by email (not socket id), so refreshes and reconnects keep
// their bracket slot. Timers are env-tunable only so the socket integration
// test can exercise a full lifecycle without waiting several minutes.
const GE_MIN_PLAYERS = 8;
const GE_MAX_PLAYERS = 16;
const GE_DEFAULT_ENTRY = 150;
const GE_JOIN_MS = Number(process.env.GRAND_EVENT_JOIN_MS) || 120_000;
const GE_READY_MS = Number(process.env.GRAND_EVENT_READY_MS) || 60_000;
const GE_MAX_COINS = 100_000;
const GE_ALLOWED_COUNTS = new Set(GRAND_EVENT_ALLOWED_COUNTS);
let grandEvent = null;
let grandEventOp = Promise.resolve();

// Build attribute allowlist. Client can only ever spend into these; anything
// else in a submitted build is rejected. All non-negative, bounded by budget.
const PB_ATTRS = ["power", "vitality", "speed", "critical", "focus"];

// Every owned pet id has a real combat identity. The four wire-level move ids
// stay fixed (attack/guard/special/ultimate), but their names, stat profile,
// tactical effect and animation family come from this SERVER-owned kit. This
// keeps the client untrusted while making a different pet genuinely different.
const PB_DEFAULT_KIT = {
  id: "rookie", passive: "Steady", motion: "rush",
  attackName: "Tackle", guardName: "Brace", specialName: "Power Hit", ultimateName: "Final Rush",
  attackHint: "Reliable damage", guardHint: "Reduce incoming damage",
  specialHint: "Heavy hit", ultimateHint: "Charged finisher",
  hpMult: 1, atkMult: 1, guardBonus: 0, critBonus: 0, dodgeBonus: 0,
  attackMult: 1, specialMult: 1, ultimateMult: 1,
  specialEffect: "none", ultimateEffect: "power", guardCounter: 0,
};
const PB_KITS = {
  pet_duck: {
    id: "puddle-scout", passive: "Wake Rider", motion: "dive",
    attackName: "Bill Jab", guardName: "Float Guard", specialName: "Water Gun", ultimateName: "Hydro Blast",
    attackHint: "Fast jab", guardHint: "Softens the next hit", specialHint: "Soaks and weakens", ultimateHint: "Blast + water shield",
    hpMult: .98, atkMult: 1, guardBonus: .03, critBonus: 0, dodgeBonus: .03,
    attackMult: 1, specialMult: .9, ultimateMult: 1, specialEffect: "weaken", ultimateEffect: "shield", guardCounter: 0,
  },
  pet_duck_snow: {
    id: "snow-drifter", passive: "Cold Current", motion: "dive",
    attackName: "Ice Peck", guardName: "Snow Nest", specialName: "Snowball", ultimateName: "Blizzard",
    attackHint: "Crisp peck", guardHint: "Dense frost guard", specialHint: "Chills enemy power", ultimateHint: "Long freeze",
    hpMult: .96, atkMult: 1.01, guardBonus: .04, critBonus: 0, dodgeBonus: .02,
    attackMult: 1, specialMult: .86, ultimateMult: .96, specialEffect: "chill", ultimateEffect: "freeze", guardCounter: 0,
  },
  pet_cat: {
    id: "alley-hunter", passive: "Hunter's Instinct", motion: "pounce",
    attackName: "Quick Claw", guardName: "Cat Stance", specialName: "Claw Swipe", ultimateName: "Feral Frenzy",
    attackHint: "High crit swipe", guardHint: "Readies a sidestep", specialHint: "Leaves a bleed", ultimateHint: "Crit-fueled frenzy",
    hpMult: .92, atkMult: 1.05, guardBonus: -.02, critBonus: .06, dodgeBonus: .04,
    attackMult: .96, specialMult: .88, ultimateMult: 1.08, specialEffect: "bleed", ultimateEffect: "power", guardCounter: 0,
  },
  pet_cat_black: {
    id: "shadow-stalker", passive: "Fade Step", motion: "pounce",
    attackName: "Shade Claw", guardName: "Vanish", specialName: "Night Slash", ultimateName: "Phantom Strike",
    attackHint: "Slips through openings", guardHint: "Banks an evade", specialHint: "Exposes the target", ultimateHint: "Drains health",
    hpMult: .9, atkMult: 1.03, guardBonus: -.04, critBonus: .04, dodgeBonus: .07,
    attackMult: 1, specialMult: .94, ultimateMult: .92, specialEffect: "expose", ultimateEffect: "drain", guardCounter: 0,
  },
  pet_cat_snow: {
    id: "frost-prowler", passive: "Snow Paws", motion: "pounce",
    attackName: "Frost Claw", guardName: "Ice Curl", specialName: "Chill Claw", ultimateName: "Avalanche",
    attackHint: "Cold quick strike", guardHint: "Builds an ice shell", specialHint: "Chills enemy power", ultimateHint: "Damage + barrier",
    hpMult: .95, atkMult: 1, guardBonus: .03, critBonus: .03, dodgeBonus: .03,
    attackMult: 1, specialMult: .9, ultimateMult: 1, specialEffect: "chill", ultimateEffect: "shield", guardCounter: 0,
  },
  pet_dog: {
    id: "pack-leader", passive: "Pack Spirit", motion: "rush",
    attackName: "Shoulder Rush", guardName: "Hold Ground", specialName: "Battle Bark", ultimateName: "Earth Shaker",
    attackHint: "Strong body check", guardHint: "Firm defensive stance", specialHint: "Raises attack", ultimateHint: "Sets a counter stance",
    hpMult: 1.05, atkMult: 1, guardBonus: .02, critBonus: 0, dodgeBonus: -.01,
    attackMult: 1, specialMult: .76, ultimateMult: 1.04, specialEffect: "power", ultimateEffect: "counter", guardCounter: 0,
  },
  pet_dog_choco: {
    id: "mud-bruiser", passive: "Heavy Paws", motion: "rush",
    attackName: "Heavy Bite", guardName: "Dig In", specialName: "Mud Slap", ultimateName: "Quake",
    attackHint: "Slow heavy damage", guardHint: "Extra sturdy block", specialHint: "Muddies enemy damage", ultimateHint: "Massive direct hit",
    hpMult: 1.1, atkMult: 1.03, guardBonus: .05, critBonus: -.01, dodgeBonus: -.04,
    attackMult: 1.05, specialMult: .88, ultimateMult: 1.14, specialEffect: "weaken", ultimateEffect: "none", guardCounter: 0,
  },
  pet_dog_husky: {
    id: "tundra-runner", passive: "Trail Guard", motion: "rush",
    attackName: "Ice Fang", guardName: "Snow Brace", specialName: "Tundra Howl", ultimateName: "Whiteout Charge",
    attackHint: "Balanced fang strike", guardHint: "Raises a frost shield", specialHint: "Shield + attack boost", ultimateHint: "Charge through the cold",
    hpMult: 1.04, atkMult: .98, guardBonus: .04, critBonus: 0, dodgeBonus: .01,
    attackMult: 1, specialMult: .7, ultimateMult: 1.08, specialEffect: "rally", ultimateEffect: "chill", guardCounter: 0,
  },
  pet_bunny: {
    id: "wind-hopper", passive: "Quick Feet", motion: "hop",
    attackName: "Hop Kick", guardName: "Backstep", specialName: "Quick Kick", ultimateName: "Tornado Spin",
    attackHint: "Fast kick", guardHint: "Banks an evade", specialHint: "Evade + extra charge", ultimateHint: "Finisher refunds 1 charge",
    hpMult: .9, atkMult: .98, guardBonus: -.04, critBonus: .02, dodgeBonus: .09,
    attackMult: .95, specialMult: .88, ultimateMult: 1.05, specialEffect: "evade", ultimateEffect: "charge", guardCounter: 0,
  },
  pet_bunny_cocoa: {
    id: "burrow-boxer", passive: "Deep Burrow", motion: "burrow",
    attackName: "Burrow Jab", guardName: "Dirt Cover", specialName: "Burrow Strike", ultimateName: "Meteor Bound",
    attackHint: "Pops up beneath target", guardHint: "Gains an earth shield", specialHint: "Shield + next-hit power", ultimateHint: "Leap and recover",
    hpMult: 1, atkMult: .98, guardBonus: .04, critBonus: 0, dodgeBonus: .03,
    attackMult: 1, specialMult: .8, ultimateMult: 1.02, specialEffect: "burrow", ultimateEffect: "regen", guardCounter: 0,
  },
  pet_turtle: {
    id: "shell-warden", passive: "Spiked Shell", motion: "shell",
    attackName: "Shell Bump", guardName: "Shell Brace", specialName: "Snap Counter", ultimateName: "Nature's Wrath",
    attackHint: "Armored bump", guardHint: "Reflects guarded damage", specialHint: "Prepares a stronger counter", ultimateHint: "Fortifies the shell",
    hpMult: 1.13, atkMult: .92, guardBonus: .1, critBonus: -.02, dodgeBonus: -.06,
    attackMult: .98, specialMult: .72, ultimateMult: .94, specialEffect: "counter", ultimateEffect: "shield", guardCounter: .22,
  },
  pet_turtle_sapphire: {
    id: "tidal-bastion", passive: "Living Reef", motion: "shell",
    attackName: "Tidal Bump", guardName: "Reef Guard", specialName: "Aqua Mend", ultimateName: "Tsunami Wall",
    attackHint: "Steady water hit", guardHint: "Strongest basic guard", specialHint: "Restores health", ultimateHint: "Huge barrier",
    hpMult: 1.1, atkMult: .9, guardBonus: .12, critBonus: -.02, dodgeBonus: -.05,
    attackMult: 1, specialMult: .68, ultimateMult: .82, specialEffect: "heal", ultimateEffect: "greatShield", guardCounter: .12,
  },
  pet_dragon: {
    id: "arcane-wyrm", passive: "Rune Wings", motion: "wing",
    attackName: "Wing Cut", guardName: "Rune Guard", specialName: "Arcane Flame", ultimateName: "Dragon Nova",
    attackHint: "Wing-powered slash", guardHint: "Mystic guard", specialHint: "Exposes the target", ultimateHint: "Empowers future attacks",
    hpMult: .97, atkMult: 1.04, guardBonus: 0, critBonus: .02, dodgeBonus: .02,
    attackMult: 1, specialMult: .94, ultimateMult: 1.05, specialEffect: "expose", ultimateEffect: "power", guardCounter: 0,
  },
  pet_dragon_crimson: {
    id: "inferno-wyrm", passive: "Heat Engine", motion: "wing",
    attackName: "Flame Claw", guardName: "Heat Veil", specialName: "Ember Spit", ultimateName: "Inferno",
    attackHint: "Hot claw strike", guardHint: "Fire-hardened guard", specialHint: "Applies burn", ultimateHint: "Long, fierce burn",
    hpMult: .96, atkMult: 1.06, guardBonus: 0, critBonus: .02, dodgeBonus: .01,
    attackMult: 1, specialMult: .86, ultimateMult: .98, specialEffect: "burn", ultimateEffect: "inferno", guardCounter: 0,
  },
  pet_dragon_obsidian: {
    id: "void-wyrm", passive: "Dark Hunger", motion: "wing",
    attackName: "Void Claw", guardName: "Abyss Fold", specialName: "Dark Pulse", ultimateName: "Void Eruption",
    attackHint: "Shadow strike", guardHint: "Dense void guard", specialHint: "Drains health", ultimateHint: "Exposes and drains",
    hpMult: .95, atkMult: 1.03, guardBonus: .02, critBonus: .03, dodgeBonus: .01,
    attackMult: 1, specialMult: .82, ultimateMult: .94, specialEffect: "drain", ultimateEffect: "voidDrain", guardCounter: 0,
  },
  pet_frog: {
    id: "storm-caller", passive: "Rain Rhythm", motion: "tongue",
    attackName: "Tongue Snap", guardName: "Lily Guard", specialName: "Toxic Bubble", ultimateName: "Thunder Swamp",
    attackHint: "Long-range tongue hit", guardHint: "Slippery guard", specialHint: "Applies poison", ultimateHint: "Storm weakens the enemy",
    hpMult: .98, atkMult: .97, guardBonus: .02, critBonus: 0, dodgeBonus: .05,
    attackMult: .96, specialMult: .78, ultimateMult: 1.02, specialEffect: "poison", ultimateEffect: "storm", guardCounter: 0,
  },
  pet_unicorn: {
    id: "prism-guardian", passive: "Gentle Light", motion: "beam",
    attackName: "Horn Spark", guardName: "Prism Guard", specialName: "Healing Beam", ultimateName: "Starlight Aegis",
    attackHint: "Focused light strike", guardHint: "Clean magic guard", specialHint: "Deals damage and heals", ultimateHint: "Heal + large barrier",
    hpMult: 1.02, atkMult: .95, guardBonus: .06, critBonus: 0, dodgeBonus: 0,
    attackMult: 1, specialMult: .72, ultimateMult: .8, specialEffect: "heal", ultimateEffect: "aegis", guardCounter: 0,
  },
  pet_phoenix: {
    id: "reborn-flame", passive: "Ash Runner", motion: "wing",
    attackName: "Flame Wing", guardName: "Ash Veil", specialName: "Searing Wing", ultimateName: "Supernova",
    attackHint: "Blazing wing cut", guardHint: "Ash-softened guard", specialHint: "Burn + regeneration", ultimateHint: "Arms one rebirth",
    hpMult: .94, atkMult: 1.05, guardBonus: 0, critBonus: .03, dodgeBonus: .02,
    attackMult: 1, specialMult: .82, ultimateMult: 1, specialEffect: "phoenixBurn", ultimateEffect: "rebirth", guardCounter: 0,
  },
};
const PB_PASSIVE_HINTS = {
  "puddle-scout": "extra dodge and a firmer guard",
  "snow-drifter": "frost guards are stronger and create cover",
  "alley-hunter": "higher crit and dodge, lower durability",
  "shadow-stalker": "highest dodge; guarding banks an evade",
  "frost-prowler": "balanced crit/dodge; guarding builds ice cover",
  "pack-leader": "more HP and sturdy close-range pressure",
  "mud-bruiser": "highest raw bulk; slower to evade",
  "tundra-runner": "extra HP; guarding builds a frost shield",
  "wind-hopper": "highest speed dodge; guarding banks an evade",
  "burrow-boxer": "guarding and burrowing build cover",
  "shell-warden": "highest HP; guarded hits reflect damage",
  "tidal-bastion": "strongest guard plus minor reflection",
  "arcane-wyrm": "high attack with balanced air mobility",
  "inferno-wyrm": "high attack and crit pressure",
  "void-wyrm": "crit pressure paired with health drain",
  "storm-caller": "slippery movement and long status pressure",
  "prism-guardian": "durable guard and reliable restoration",
  "reborn-flame": "high crit/dodge; Searing Wing regenerates",
};
function petBattleKit(petId) {
  return { ...PB_DEFAULT_KIT, ...(PB_KITS[petId] || {}), petId };
}
function petBattlePublicKit(kit) {
  const visualHints = kit.motion === "wing"
    ? {
        attack: "Fly in and strike", guard: "Hold position",
        special: "Aerial strike", ultimate: "Full-speed fly-by",
      }
    : {
        attack: "Move in and strike", guard: "Brace in place",
        special: "Signature hit", ultimate: "Big finishing hit",
      };
  return {
    id: kit.id, motion: kit.motion,
    moves: {
      attack: { name: kit.attackName, hint: visualHints.attack },
      guard: { name: kit.guardName, hint: visualHints.guard },
      special: { name: kit.specialName, hint: visualHints.special },
      ultimate: { name: kit.ultimateName, hint: visualHints.ultimate },
    },
  };
}

// Training budget: points a pet may allocate across PB_ATTRS. Grows with
// feed-XP and stage so an evolved, well-fed pet is meaningfully stronger — but
// BOUNDED so form is an edge, not a runaway. Budget is derived server-side
// from authoritative pet_xp + stage; the client never sends it.
function petBattleBudget(pet, xp) {
  const stage = petStageOfPet(pet, xp);
  // 2 base + 1 per stage above 1 + 1 per 25 feed-XP, capped at 12.
  return Math.min(12, 2 + (stage - 1) + Math.floor((xp || 0) / 25));
}

// Coerce/validate a submitted build to a clean {attr:int>=0} object and confirm
// the total spent fits the pet's budget. Returns null on any violation (unknown
// attr, negative, non-int, over budget) — callers reject rather than clamp.
function sanitizePetBuild(raw, budget) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {}; let spent = 0;
  for (const k of Object.keys(raw)) {
    if (!PB_ATTRS.includes(k)) return null;            // unknown attribute → reject
    const v = raw[k];
    if (!Number.isInteger(v) || v < 0) return null;    // must be a non-negative int
    out[k] = v; spent += v;
  }
  if (spent > budget) return null;                     // over budget → reject
  for (const a of PB_ATTRS) if (!(a in out)) out[a] = 0; // fill zeros for a stable shape
  return out;
}

// The build actually IN EFFECT for a pet right now (stored allocations, or all
// zeros if none). Read only from the authoritative in-memory copy the DB
// hydrated; never from client input.
function effectivePetBuild(p, pet) {
  const stored = (p.petBuilds || {})[pet];
  const clean = sanitizePetBuild(stored, petBattleBudget(pet, ((p.petXp || {})[pet]) || 0));
  return clean || { power: 0, vitality: 0, speed: 0, critical: 0, focus: 0 };
}

// ── Combat math (pure; every species uses the same rules)
// Pet identity is animation and presentation only. Form + owner training are
// the complete source of combat numbers, so a dragon's flight never hides a
// paid/stat advantage or an extra status trick.
function petBattleStats(stage, build, kit = PB_DEFAULT_KIT) {
  const b = build || {};
  const p = b.power || 0, v = b.vitality || 0, sp = b.speed || 0, cr = b.critical || 0, fo = b.focus || 0;
  // Stage baseline (bounded): stage 1/2/3 → these anchors before build tuning.
  const hpBase   = [0, 50, 62, 74][stage] || 50;
  const atkBase  = [0, 10, 12, 14][stage] || 10;
  const formMult = [0, 1.00, 1.10, 1.22][stage] || 1.0;  // stage improves multipliers
  const attack = Math.round((atkBase + p * 3) * formMult);
  return {
    maxHp:    Math.round((hpBase + v * 6) * formMult),
    attack,
    // guard mitigation fraction (higher vitality + focus = tougher block), capped.
    guardCut: Math.min(0.75, 0.45 + v * 0.03 + fo * 0.02),
    // crit chance & multiplier from the critical attribute (bounded).
    critChance: Math.min(0.6, 0.05 + cr * 0.05),
    critMult:   1.5 + Math.min(0.5, cr * 0.05),
    // Speed is an actual combat choice: quicker pets can cleanly evade a blow.
    // It is capped well below certainty so form/build never guarantees a dodge.
    dodgeChance: Math.min(0.3, sp * 0.025),
    speed:      sp,
    focus:      fo,
    // special = a bigger, cooldown-gated hit; ultimate = charge-gated finisher.
    special:  Math.round(attack * (1.6 + fo * 0.05)),
    ultimate: Math.round(attack * (2.4 + fo * 0.06)),
  };
}

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
    { id: "pet_treat", name: "Pet Treat (+1 pet XP — evolve your pet!)", icon: "🦴", price: PET_TREAT_PRICE },
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
// Chat-log reactions (Teams-style): allowed emoji + a per-boot message id so
// clients can attach a reaction to a specific (ephemeral) message.
const CHAT_REACTS = new Set(["👍", "❤️", "😂", "😮", "😢", "🔥"]);
let chatMsgSeq = 0;

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
const WORK_SEAT_GIDS = new Set([2231, 2628, 2600, 5033,
  2605,  // L&D trainer's desk chair (also COO + Accounting desk chairs — same GID family)
  3320,  // L&D tan armchair seat (also QA tan armchair)
  7645,  // L&D green high-back reading chair seat
  7715,  // L&D classroom desk chair seat
]);
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
const DEPARTMENTS = ["HR", "IT", "Operations", "Front Desk", "CMA", "QA", "L&D", "Claims", "Accounting", "Developer"];

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
    wings:     row.equipped_wings || "",
    // Outfit slots (Aug 2026): worn alongside the legacy slot + wings.
    slots: {
      top:      row.equipped_top      || "",
      bottom:   row.equipped_bottom   || "",
      neckwear: row.equipped_neckwear || "",
      held:     row.equipped_held     || "",
      feet:     row.equipped_feet     || "",
    },
    pet:       row.equipped_pet || "",
    petAcc:    row.equipped_pet_acc || "",
    petXp:     row.pet_xp || {},
    petNames:  row.pet_names || {},
    // Pet Battle training builds (Aug 2026): per-pet stat allocations, keyed by
    // pet id ({"pet_cat": {power:2,vitality:1,...}}). Server-owned; the only
    // mutation path is petBattleSetBuild, which re-validates ownership/budget.
    petBuilds: row.pet_builds || {},
    items:     row.items || {},
    avatarChanges: row.avatar_changes ?? 0,
    // Shared-treat earnings buff survives refreshes/restarts (epoch ms, 0 = none).
    earnUntil:   row.earn_until ? new Date(row.earn_until).getTime() : 0,
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
    petBattleForfeitForLeave(id);   // same anti-dodge for an active pet battle
    // Same grace as a disconnect: the successor session for this email is
    // about to restore (login/resume/register all call restorePlayer next),
    // which rebinds the round spot. Paths with NO successor restore must call
    // roundLeaveGoneByEmail themselves (password reset, pending-queue exits).
    if (!roundDeferLeave(id)) roundHandleLeave(id);
    rlglHandleLeave(id);
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
    wings:     state.wings || "",
    slots:     state.slots || emptySlots(),
    pet:       state.pet || "",
    petAcc:    state.petAcc || "",
    petXp:     state.petXp || {},      // without these, a refresh rendered an
    petNames:  state.petNames || {},   // evolved pet as a nameless baby again
    petBuilds: state.petBuilds || {},  // per-pet Pet Battle training allocations
    items:     state.items || {},
    avatarChanges: state.avatarChanges ?? 0,
    x:         state.x,
    y:         state.y,
    // Restored pose: the client re-enters the seated pose from these instead of
    // spawning fresh — without them every refresh/build-stamp reload stood the
    // player up at spawn (and un-seated them for everyone watching).
    dir:       state.dir,
    anim:      state.anim === "sit" ? "sit" : "idle",
  });
  socket.emit("currentPlayers", phMaskedPlayers(socket.id));
  // Prop Hunt for late joiners: vanish the hider's (masked) entry, share the
  // prop if the hunt is on, and re-offer the invite so a refreshed seeker
  // (new socket id — the old seeker spot is gone) can jump back in.
  if (propHunt && propHunt.hiderId !== socket.id) {
    socket.emit("phVanish", { id: propHunt.hiderId });
    socket.emit("phInvite", { hiderName: propHunt.hiderName, hideEndsAt: propHunt.hideEndsAt, hiderId: propHunt.hiderId });
    if (propHunt.state === "hunting") {
      const hp = players[propHunt.hiderId];
      if (hp) socket.emit("phHunt", { prop: { x: Math.round(hp.x), y: Math.round(hp.y), disguise: propHunt.disguise }, endsAt: propHunt.endsAt });
    }
  }
  socket.emit("announcerStatus", { canPost: state.isAnnouncer });
  socket.emit("announcements", await fetchAnnouncements());
  // Huddles: current NPC snapshot (the scene also pulls via npcSync at create,
  // covering the game-boots-after-this-emit ordering) + today's mission for
  // the HUD chip, so a refresh never loses the mission display.
  socket.emit("npcState", npcSnapshot());
  socket.emit("hrNpcState", HR_NPC);   // Ms. Poli is stationary — one snapshot is enough
  // Office chores: remaining cooldown per chore, so the client's "available
  // again" sparkle is right from the first frame (not just after a chore).
  socket.emit("choreState", { chores: choreStateFor(state.email || socket.id) });
  // HQ-Buddy: pair (or restore) this week's secret buddy and tell ONLY this
  // socket. Fire-and-forget — a pairing hiccup must never block login.
  if (state.email) sendBuddyInfo(socket.id).catch((err) => console.error("buddy pairing failed:", err));
  // Restore a still-running shared-treat earnings buff (paid minutes survive
  // refreshes and server restarts).
  if ((state.earnUntil || 0) > Date.now())
    socket.emit("earnBoost", { until: state.earnUntil, mult: EARN_MULT });
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

  // Lingering gift receipts — includes gifts that arrived while offline.
  // They stay on screen until the player hits ✕ on each one.
  if (state.email) {
    pool.query(
      `SELECT id, from_name, amount, ts FROM jpo_gift_notices WHERE email = $1 ORDER BY id DESC`,
      [state.email])
      .then(({ rows }) => {
        if (rows.length && players[socket.id] === state)
          socket.emit("giftNotices", { notices: rows.map((r) => ({ id: r.id, fromName: r.from_name, amount: r.amount, ts: r.ts })) });
      }).catch((err) => console.error("gift notices load failed:", err));
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
  // Durable Grand Event lobby/bracket follows the account across socket ids.
  // This direct push covers reconnects even before the client sends uiSync.
  grandEventSyncToSocket(socket.id);

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
const GAMES      = new Set(["rps", "ttt", "qd", "ib", "wr", "trivia", "c4", "pool", "pong", "race"]);
const GAME_NAMES = { rps: "Rock-Paper-Scissors", ttt: "Tic-Tac-Toe", qd: "Quick Draw", ib: "Icebreakers", wr: "Word Race", trivia: "Trivia Duel", c4: "Connect Four", pool: "Billiards", pong: "Ping Pong", race: "Pet Race" };
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
  // Pet battles occupy the same person even though their state map is
  // intentionally separate. Re-check here because station/direct callers
  // historically only knew about rpsBySocket.
  if (battleBySocket.has(challengerId) || battleBySocket.has(targetId)) {
    io.to(challengerId).emit("rpsChallengeFailed", { message: "Finish the active pet battle first." });
    return;
  }
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

// ══════════════════════════════════════════════════════════════════════════
// ── Pet Battle engine ──────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════
// battleBySocket maps a HUMAN socket id → the shared battle object. A bot match
// stores only the challenger under their id (the bot has no socket). One active
// battle per human socket is enforced by battleBySocket.has() at challenge time.
const battleBySocket = new Map();
let petBattleSeq = 0;   // human-readable counter for logs only; the real id is a uuid
function inAnyMatch(id) { return rpsBySocket.has(id) || battleBySocket.has(id); }

// Clear every timer a battle object can own so no orphaned callback fires on a
// dead battle. Mirrors clearMatchTimers for the rps roster.
function clearBattleTimers(b) {
  clearTimeout(b.acceptTimer);
  clearTimeout(b.pickTimer);
  clearTimeout(b.botTimer);
}

function petBattleOtherId(b, id) { return id === b.challengerId ? b.opponentId : b.challengerId; }
function petBattleIsBot(b) { return b.opponentId === BOT_ID; }

// Delete a battle from the map for both sides (the bot slot is never in the map).
function petBattleUnmap(b) {
  battleBySocket.delete(b.challengerId);
  if (b.opponentId !== BOT_ID) battleBySocket.delete(b.opponentId);
}

// Build the SAFE, client-ready view of a combatant. NEVER leaks server-only
// internals (RNG seeds, the other side's pending pick, cooldown timers). The
// bot is deliberately anonymized: no socket id, no player identity — a fixed
// display name and id so a modified client can't target/track it as a player.
function petBattleCombatantView(b, side) {
  const c = b.sides[side];
  return {
    id:       c.isBot ? "bot" : c.id,
    name:     c.name,
    petId:    c.petId,
    stage:    c.stage,
    build:    { ...c.build },
    hp:       c.hp,
    maxHp:    c.stats.maxHp,
    charge:   c.charge,
    kit:      petBattlePublicKit(c.kit),
    statuses: petBattleStatusView(c),
    isBot:    !!c.isBot,
  };
}

function petBattleStatusView(side) {
  return [];
}

// The full pair of combatant views, from the perspective label the client wants.
function petBattleView(b) {
  return { challenger: petBattleCombatantView(b, "challenger"),
           opponent:   petBattleCombatantView(b, "opponent") };
}

// Snapshot one side's immutable battle build at START. After this the live
// player object is never consulted again for combat — the frozen snapshot is
// the single source of truth (so evolving/retraining mid-battle can't change
// an in-flight fight, and a client can't inject stats).
function petBattleSnapshot(id, name, petId, stage, build, isBot) {
  const kit = petBattleKit(petId);
  const stats = petBattleStats(stage, build, kit);
  return {
    id, name, petId, stage, build: { ...build }, isBot: !!isBot,
    kit, stats,
    hp: stats.maxHp,        // both sides start at form-scaled full HP
    charge: 0,              // ultimate charge, built by attack/guard
    specialCd: 0,           // rounds remaining before 'special' is usable again
    status: {
      shield: 0, dot: null, weaken: 0, exposed: 0, power: 0,
      evade: 0, counter: 0, regen: 0, regenAmount: 0, rebirth: false,
    },
    pick: null,             // this round's chosen move (server-locked)
  };
}

// Legal-move check for a side THIS round (server-authoritative gating):
//   attack — always legal (reliable).
//   guard  — always legal.
//   special— legal only when off cooldown.
//   ultimate—legal only when fully charged.
function petBattleMoveLegal(side, move) {
  if (move === "attack" || move === "guard") return true;
  if (move === "special")  return side.specialCd <= 0;
  if (move === "ultimate") return side.charge >= PB_ULT_CHARGE;
  return false;
}

// The bot's server-side move choice. Scales to the challenger's form/training
// (it fights at the human's own snapshot build/stage), and plays a simple but
// sane policy: ultimate when charged, special when off cooldown and healthy,
// occasional guard when low, else attack. Deterministic-ish with light RNG so
// it isn't fully predictable.
function petBattleBotMove(bot, foe) {
  if (petBattleMoveLegal(bot, "ultimate")) return "ultimate";
  const lowHp = bot.hp <= bot.stats.maxHp * 0.35;
  if (lowHp && Math.random() < 0.5) return "guard";
  if (petBattleMoveLegal(bot, "special") && Math.random() < 0.6) return "special";
  if (Math.random() < 0.15) return "guard";
  return "attack";
}

// Resolve ONE round from both locked picks. Returns the per-side resolved
// results (move, damage dealt to the OTHER side, crit flag, whether the
// attacker's blow was guarded) plus post-round hp/charge. Simultaneous
// resolution: both damages are computed against pre-round HP, then applied —
// so a mutual finisher can KO both (→ higher-remaining-HP / draw logic in the
// caller). All RNG is server-side.
function petBattleResolveRound(b) {
  const A = b.sides.challenger, D = b.sides.opponent;
  const picks = { challenger: A.pick, opponent: D.pick };
  const notes = { challenger: [], opponent: [] };

  // Compute the outgoing blow from one attacker against a defender's stance.
  function blow(atk, def) {
    const move = atk.pick;
    if (move === "guard") {
      return { move, moveName: atk.kit.guardName, damage: 0, crit: false, guarded: false, dodged: false, absorbed: 0 };
    }
    // Guard and dodge are distinct defensive choices. A guarding pet plants
    // its feet and mitigates the hit; otherwise Speed may evade it completely.
    const guarded = def.pick === "guard";
    const bankedEvade = !guarded && def.status.evade > 0;
    const dodged = bankedEvade || (!guarded && Math.random() < def.stats.dodgeChance);
    if (dodged) {
      return {
        move, moveName: move === "attack" ? atk.kit.attackName
          : move === "special" ? atk.kit.specialName : atk.kit.ultimateName,
        damage: 0, crit: false, guarded: false, dodged: true, absorbed: 0,
      };
    }
    let base = move === "attack" ? atk.stats.attack
             : move === "special" ? atk.stats.special
             : atk.stats.ultimate;
    // Species never changes combat numbers; the kit only names and animates
    // the same four fair move types.
    if (atk.status.weaken > 0) base *= 0.78;
    if (atk.status.power > 0) base *= 1.18;
    if (def.status.exposed > 0) base *= 1.18;
    // server RNG crit
    const crit = Math.random() < atk.stats.critChance;
    if (crit) base = Math.round(base * atk.stats.critMult);
    // guard mitigation if the defender chose to guard this round
    let dmg = base;
    if (guarded) dmg = Math.round(base * (1 - def.stats.guardCut));
    // small ±10% variance so identical builds aren't perfectly deterministic
    dmg = Math.round(dmg * (0.9 + Math.random() * 0.2));
    dmg = Math.max(guarded ? 0 : 1, dmg);
    const absorbed = Math.min(def.status.shield, dmg);
    if (absorbed > 0) {
      def.status.shield -= absorbed;
      dmg -= absorbed;
    }
    return {
      move,
      moveName: move === "attack" ? atk.kit.attackName
        : move === "special" ? atk.kit.specialName : atk.kit.ultimateName,
      damage: dmg, crit, guarded, dodged: false, absorbed,
    };
  }

  const aBlow = blow(A, D);   // challenger hits opponent
  const dBlow = blow(D, A);   // opponent hits challenger

  // Apply simultaneously against pre-round HP.
  D.hp = Math.max(0, D.hp - aBlow.damage);
  A.hp = Math.max(0, A.hp - dBlow.damage);

  const extra = {
    challenger: { healed: 0, statusDamage: 0, counterDamage: 0, revived: false },
    opponent: { healed: 0, statusDamage: 0, counterDamage: 0, revived: false },
  };

  function addShield(side, pct, label, sideName) {
    const amount = Math.max(4, Math.round(side.stats.maxHp * pct));
    side.status.shield = Math.min(Math.round(side.stats.maxHp * .55), side.status.shield + amount);
    notes[sideName].push(`${label}: +${amount} shield`);
  }
  function heal(side, pct, label, sideName) {
    // Ordinary healing/regen can recover a living pet, never resurrect a pet
    // that has already reached 0. Rebirth is the one explicit exception below.
    if (side.hp <= 0) return;
    const before = side.hp;
    side.hp = Math.min(side.stats.maxHp, side.hp + Math.max(3, Math.round(side.stats.maxHp * pct)));
    const amount = side.hp - before;
    extra[sideName].healed += amount;
    if (amount > 0) notes[sideName].push(`${label}: +${amount} HP`);
  }
  function setDot(target, kind, turns, pct, targetName) {
    const damage = Math.max(2, Math.round(target.stats.maxHp * pct));
    if (!target.status.dot || damage * turns >= target.status.dot.damage * target.status.dot.turns) {
      target.status.dot = { kind, turns, damage };
    }
    notes[targetName].push(`${kind} applied`);
  }
  function applyEffect(actor, target, effect, blowRes, actorName, targetName) {
    // Debuffs and damage-over-time are on-hit effects. A true dodge avoids the
    // whole payload; a shield still counts as a landed hit and may absorb only
    // its direct damage. Self-only setup/recovery effects remain usable if the
    // attached strike is dodged.
    const onHitTargetEffects = new Set([
      "weaken", "chill", "freeze", "bleed", "burn", "inferno",
      "poison", "expose", "voidDrain", "storm",
    ]);
    if (blowRes.dodged && onHitTargetEffects.has(effect)) {
      notes[actorName].push(`${blowRes.moveName} missed`);
      return;
    }
    switch (effect) {
      case "weaken":
        target.status.weaken = Math.max(target.status.weaken, 3);
        notes[targetName].push("Damage weakened");
        break;
      case "chill":
        target.status.weaken = Math.max(target.status.weaken, 3);
        actor.status.shield += Math.max(2, Math.round(actor.stats.maxHp * .06));
        notes[targetName].push("Chilled");
        break;
      case "freeze":
        target.status.weaken = Math.max(target.status.weaken, 4);
        target.status.exposed = Math.max(target.status.exposed, 2);
        notes[targetName].push("Frozen and exposed");
        break;
      case "bleed":
        setDot(target, "Bleed", 3, .045, targetName);
        break;
      case "burn":
        setDot(target, "Burn", 3, .04, targetName);
        break;
      case "inferno":
        setDot(target, "Inferno", 4, .055, targetName);
        break;
      case "poison":
        setDot(target, "Poison", 4, .035, targetName);
        break;
      case "expose":
        target.status.exposed = Math.max(target.status.exposed, 3);
        notes[targetName].push("Defense exposed");
        break;
      case "power":
        actor.status.power = Math.max(actor.status.power, 3);
        notes[actorName].push("Attack powered up");
        break;
      case "counter":
        actor.status.counter = Math.max(actor.status.counter, 3);
        notes[actorName].push("Counter stance ready");
        break;
      case "shield":
        addShield(actor, .22, actor.kit.ultimateName, actorName);
        break;
      case "greatShield":
        addShield(actor, .38, actor.kit.ultimateName, actorName);
        break;
      case "heal":
        heal(actor, .18, actor.kit.specialName, actorName);
        break;
      case "aegis":
        heal(actor, .16, actor.kit.ultimateName, actorName);
        addShield(actor, .3, actor.kit.ultimateName, actorName);
        break;
      case "drain":
        heal(actor, Math.min(.18, (blowRes.damage * .45) / actor.stats.maxHp), actor.kit.specialName, actorName);
        break;
      case "voidDrain":
        target.status.exposed = Math.max(target.status.exposed, 3);
        heal(actor, Math.min(.25, (blowRes.damage * .55) / actor.stats.maxHp), actor.kit.ultimateName, actorName);
        break;
      case "rally":
        actor.status.power = Math.max(actor.status.power, 3);
        addShield(actor, .12, actor.kit.specialName, actorName);
        break;
      case "evade":
        actor.status.evade = Math.max(actor.status.evade, 2);
        actor.charge = Math.min(PB_ULT_CHARGE, actor.charge + 1);
        notes[actorName].push("Evade banked; +1 charge");
        break;
      case "charge":
        // Applied after this ultimate is spent by the bookkeeping block.
        actor.postUltimateCharge = 1;
        notes[actorName].push("1 ultimate charge refunded");
        break;
      case "burrow":
        addShield(actor, .16, actor.kit.specialName, actorName);
        actor.status.power = Math.max(actor.status.power, 2);
        break;
      case "regen":
        actor.status.regen = Math.max(actor.status.regen, 3);
        actor.status.regenAmount = Math.max(actor.status.regenAmount, Math.round(actor.stats.maxHp * .07));
        notes[actorName].push("Regeneration started");
        break;
      case "storm":
        target.status.weaken = Math.max(target.status.weaken, 4);
        setDot(target, "Storm", 3, .03, targetName);
        break;
      case "phoenixBurn":
        if (blowRes.dodged) {
          notes[actorName].push(`${blowRes.moveName} missed`);
        } else {
          setDot(target, "Burn", 3, .04, targetName);
        }
        actor.status.regen = Math.max(actor.status.regen, 3);
        actor.status.regenAmount = Math.max(actor.status.regenAmount, Math.round(actor.stats.maxHp * .05));
        notes[actorName].push("Flames begin healing");
        break;
      case "rebirth":
        actor.status.rebirth = true;
        notes[actorName].push("Rebirth armed");
        break;
    }
  }

  // A few identities alter Guard itself, so defensive pets and evasive pets
  // do not share the same animation-only button.
  function applyGuardIdentity(side, sideName) {
    if (side.pick !== "guard") return;
    if (["shadow-stalker", "wind-hopper"].includes(side.kit.id)) {
      side.status.evade = Math.max(side.status.evade, 2);
      notes[sideName].push("Evade banked");
    } else if (["snow-drifter", "frost-prowler", "tundra-runner", "burrow-boxer"].includes(side.kit.id)) {
      addShield(side, .08, side.kit.guardName, sideName);
    }
  }
  // Intentionally no kit-specific status dispatch. Pet identity is expressed
  // by its movement and hit animation, not hidden shields/burns/heals/etc.

  // Turtle-style guarded counters apply after simultaneous direct damage.
  function applyCounter(def, atk, incoming, defName, atkName) {
    if (def.pick !== "guard" || !incoming.guarded || incoming.damage <= 0) return;
    const pct = Math.min(.5, (def.kit.guardCounter || 0) + (def.status.counter > 0 ? .24 : 0));
    if (pct <= 0) return;
    const reflected = Math.max(1, Math.round(incoming.damage * pct));
    atk.hp = Math.max(0, atk.hp - reflected);
    extra[defName].counterDamage += reflected;
    notes[atkName].push(`Countered for ${reflected}`);
  }

  // Ongoing effects tick once per completed round, then duration counters fall.
  function tick(side, sideName) {
    if (side.status.dot?.turns > 0) {
      const dmg = Math.min(side.hp, side.status.dot.damage);
      side.hp = Math.max(0, side.hp - dmg);
      extra[sideName].statusDamage += dmg;
      notes[sideName].push(`${side.status.dot.kind} -${dmg}`);
      side.status.dot.turns -= 1;
      if (side.status.dot.turns <= 0) side.status.dot = null;
    }
    if (side.status.regen > 0 && side.hp > 0) {
      const before = side.hp;
      side.hp = Math.min(side.stats.maxHp, side.hp + side.status.regenAmount);
      const amount = side.hp - before;
      extra[sideName].healed += amount;
      if (amount > 0) notes[sideName].push(`Regen +${amount}`);
      side.status.regen -= 1;
      if (side.status.regen <= 0) side.status.regenAmount = 0;
    }
    for (const key of ["weaken", "exposed", "power", "evade", "counter"]) {
      if (side.status[key] > 0) side.status[key] -= 1;
    }
    if (side.hp <= 0 && side.status.rebirth) {
      side.status.rebirth = false;
      side.hp = Math.max(1, Math.round(side.stats.maxHp * .34));
      extra[sideName].revived = true;
      notes[sideName].push(`Reborn at ${side.hp} HP`);
    }
  }

  // Charge/cooldown bookkeeping, per side, from THIS round's move.
  for (const side of [A, D]) {
    if (side.pick === "attack") side.charge = Math.min(PB_ULT_CHARGE, side.charge + 1);
    else if (side.pick === "guard") side.charge = Math.min(PB_ULT_CHARGE, side.charge + 1);
    else if (side.pick === "special") side.specialCd = PB_SPECIAL_CD;
    else if (side.pick === "ultimate") {
      side.charge = Number.isInteger(side.postUltimateCharge) ? side.postUltimateCharge : 0;
      delete side.postUltimateCharge;
    }
    if (side.specialCd > 0 && side.pick !== "special") side.specialCd -= 1;
  }

  return {
    picks,
    challenger: {
      move: aBlow.move, moveName: aBlow.moveName, damageDealt: aBlow.damage,
      crit: aBlow.crit, guarded: aBlow.guarded, dodged: aBlow.dodged, absorbed: aBlow.absorbed,
      hp: A.hp, charge: A.charge, notes: notes.challenger, ...extra.challenger,
    },
    opponent: {
      move: dBlow.move, moveName: dBlow.moveName, damageDealt: dBlow.damage,
      crit: dBlow.crit, guarded: dBlow.guarded, dodged: dBlow.dodged, absorbed: dBlow.absorbed,
      hp: D.hp, charge: D.charge, notes: notes.opponent, ...extra.opponent,
    },
  };
}

// Emit a semantic event to both human sides of a battle (bot side is skipped).
function petBattleEmitBoth(b, event, payloadFor) {
  for (const side of ["challenger", "opponent"]) {
    const id = b.sides[side].id;
    if (id === BOT_ID) continue;
    io.to(id).emit(event, payloadFor(side));
  }
}

// Award battle XP idempotently and (for account players) persist it in ONE
// atomic transaction: claim the (match_id, email) ledger row AND increment
// jpo_players.pet_xp together, so a retry after an ambiguous COMMIT can never
// double-award. Also enforces the persistent per-pet daily cap and the
// same-opponent rematch cooldown (both make the award 0 without failing the
// match). Session-only players are not eligible to enter XP-bearing battles.
// Returns the pet's post-award xp (or null if nothing to show), and emits
// evolution/update if a stage boundary was crossed. Never trusts a client.
async function petBattleAwardXp(matchId, side, amount, opponentEmail) {
  const p = players[side.id];
  const pet = side.petId;
  if (!p || !pet) return;
  if (amount <= 0) {
    petBattleEmitNoXp(p, side.id, pet, "forfeit");
    return;
  }
  // Battles are restricted to approved email-backed accounts. Keep this guard
  // here too so an old/in-flight session-only battle can never bypass the
  // durable cap, cooldown, and idempotency ledgers.
  if (!p.email) {
    petBattleEmitNoXp(p, side.id, pet, "accountRequired");
    return null;
  }
  const day = new Date().toISOString().slice(0, 10);   // UTC YYYY-MM-DD
  let cl;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      cl = await pool.connect();
      await cl.query("BEGIN");
      // Idempotency claim: if this (match_id, email) already settled, skip.
      const claim = await cl.query(
        `INSERT INTO jpo_pet_battles (match_id, email, pet, xp, outcome)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING 1`,
        [matchId, p.email, pet, amount, amount === PB_XP_WIN || amount === PB_XP_FF_WIN ? "win" : "lose"]);
      if (!claim.rows[0]) { await cl.query("ROLLBACK"); return null; }   // already awarded

      // Same-opponent rematch cooldown. Bot matches pass a stable synthetic
      // identity, so repeatedly rematching Training Bot cannot farm XP either.
      let overCooldown = false;
      let pairEmails = null;
      if (opponentEmail) {
        const a = p.email < opponentEmail ? p.email : opponentEmail;
        const bEm = p.email < opponentEmail ? opponentEmail : p.email;
        pairEmails = [a, bEm];
        const pr = await cl.query(
          `SELECT last_at, last_match_id FROM jpo_pet_battle_pairs WHERE email_a=$1 AND email_b=$2`, [a, bEm]);
        // Both participants settle separately. The second credit from THIS
        // match must remain eligible; only a different recent match is cooled.
        if (pr.rows[0] && pr.rows[0].last_match_id !== matchId
            && (Date.now() - new Date(pr.rows[0].last_at).getTime()) < PB_REMATCH_MS) {
          overCooldown = true;
        }
      }

      // A cooldown-blocked rematch is not a rewarded battle and therefore must
      // not consume one of today's cap slots.
      if (overCooldown) {
        await cl.query(
          `UPDATE jpo_pet_battles SET xp=0, outcome='rematch_cooldown'
            WHERE match_id=$1 AND email=$2`, [matchId, p.email]);
        await cl.query("COMMIT");
        petBattleEmitNoXp(p, side.id, pet, "rematchCooldown");
        return null;
      }

      // Daily per-pet cap: bump only reward-eligible battles. If it now exceeds
      // the cap, this match remains claimed but its ledger records zero XP.
      const cap = await cl.query(
        `INSERT INTO jpo_pet_battle_caps (day, email, pet, n) VALUES ($1,$2,$3,1)
         ON CONFLICT (day, email, pet) DO UPDATE SET n = jpo_pet_battle_caps.n + 1
         RETURNING n`, [day, p.email, pet]);
      const overCap = (cap.rows[0]?.n || 0) > PB_DAILY_CAP;
      if (overCap) {
        await cl.query(
          `UPDATE jpo_pet_battles SET xp=0, outcome='daily_cap'
            WHERE match_id=$1 AND email=$2`, [matchId, p.email]);
        await cl.query("COMMIT");
        petBattleEmitNoXp(p, side.id, pet, "dailyCap");
        return null;
      }

      // Record the pair only after this match has actually earned a reward.
      // last_match_id lets the second participant's separate settlement from
      // this same match pass while a different recent rematch is blocked.
      if (pairEmails) {
        await cl.query(
          `INSERT INTO jpo_pet_battle_pairs (email_a, email_b, last_at, last_match_id)
           VALUES ($1,$2, now(),$3)
           ON CONFLICT (email_a, email_b) DO UPDATE SET last_at = now(), last_match_id = $3`,
          [pairEmails[0], pairEmails[1], matchId]);
      }

      const { rows } = await cl.query(
        `UPDATE jpo_players
            SET pet_xp = jsonb_set(coalesce(pet_xp, '{}'::jsonb), ARRAY[$2::text],
                         to_jsonb(coalesce((pet_xp->>$2)::int, 0) + $3::int)),
                updated_at = now()
          WHERE email = $1
          RETURNING (pet_xp->>$2)::int AS xp`,
        [p.email, pet, amount]);
      await cl.query("COMMIT");
      const xp = (rows[0] && rows[0].xp) || 0;
      const prev = xp - amount;
      // Sync the live copy only after a confirmed commit (never before).
      if (players[side.id] && players[side.id].email === p.email) {
        players[side.id].petXp = players[side.id].petXp || {};
        players[side.id].petXp[pet] = xp;
      }
      petBattleEmitXpAndEvolve(players[side.id] || p, side.id, pet, prev, xp, amount);
      return xp;
    } catch (err) {
      try { await cl?.query("ROLLBACK"); } catch {}
      console.error(`pet battle XP award attempt ${attempt}/3 failed:`, err.message || err);
      if (attempt < 3) await new Promise(r => setTimeout(r, 400 * attempt));
    } finally { cl?.release(); cl = null; }
  }
  return null;
}

// Emit the safe petBattleXp event plus the standard evolution/update broadcasts
// if a feed-XP stage boundary was crossed (reuses the same events the cafeteria
// feed path uses, so the client's stage rendering stays consistent everywhere).
function petBattleEmitXpAndEvolve(p, sid, pet, prevXp, xp, delta) {
  io.to(sid).emit("petBattleXp", {
    pet, xp, delta, stage: petStageOfPet(pet, xp),
    next: PET_MYTHIC.has(pet)
      ? (xp >= PET_EVOLVE_XP[0] ? null : PET_EVOLVE_XP[0])
      : (PET_EVOLVE_XP.find((t) => t > xp) ?? null),
  });
  const stage = petStageOfPet(pet, xp), prevStage = petStageOfPet(pet, prevXp);
  if (stage > prevStage && p) {
    io.emit("playerPetUpdate", { id: sid, pet: p.pet, petAcc: p.petAcc, petStage: petStageFor(p) });
    io.emit("petEvolved", { id: sid, name: p.name, pet, stage,
                            petName: ((p.petNames || {})[pet]) || "" });
    console.log(`${p.name}'s ${pet} evolved to stage ${stage} (battle XP, now ${xp})`);
  }
}

function petBattleEmitNoXp(p, sid, pet, reason) {
  const xp = ((p?.petXp || {})[pet]) || 0;
  io.to(sid).emit("petBattleXp", {
    pet, xp, delta: 0, reason, stage: petStageOfPet(pet, xp),
    next: PET_MYTHIC.has(pet)
      ? (xp >= PET_EVOLVE_XP[0] ? null : PET_EVOLVE_XP[0])
      : (PET_EVOLVE_XP.find((t) => t > xp) ?? null),
  });
}

// Finish a battle: decide the winner from remaining HP (or an explicit
// forfeit), award XP, emit the safe petBattleResult to both humans, and tear
// the battle down. `reason` is one of "ko" | "rounds" | "forfeit" | "draw".
// SETTLE-ONCE: guarded by the state flip so a timer + a pick racing to finish,
// or a disconnect mid-settle, resolve exactly once.
async function petBattleFinish(b, { reason, winnerSide = null, forfeit = false } = {}) {
  if (b.state === "settling" || b.state === "done") return;
  b.state = "settling";
  b.finishReason = reason || "";
  b.finishWasForfeit = !!forfeit;
  clearBattleTimers(b);

  const A = b.sides.challenger, D = b.sides.opponent;
  // Decide winner if not dictated by a forfeit.
  if (!winnerSide && !forfeit) {
    if (A.hp <= 0 && D.hp <= 0) winnerSide = null;                 // mutual KO → draw
    else if (A.hp <= 0) winnerSide = "opponent";
    else if (D.hp <= 0) winnerSide = "challenger";
    else winnerSide = A.hp === D.hp ? null : (A.hp > D.hp ? "challenger" : "opponent");  // rounds cap
  }
  const draw = !winnerSide;
  const winner = winnerSide ? b.sides[winnerSide] : null;
  const loser  = winnerSide ? b.sides[petBattleOtherId2(winnerSide)] : null;

  // XP amounts. Forfeit: winner +2, leaver +0. Completed: winner +3, loser +1.
  // Draw (rounds cap tie / mutual KO): both get the loser reward (they fought).
  const matchId = b.matchId;
  const chEmail = A.tournamentEmail || players[A.id]?.email || null;
  const opEmail = D.isBot ? PB_BOT_REWARD_ID : (D.tournamentEmail || players[D.id]?.email || null);
  const awards = [];
  if (draw) {
    if (!A.isBot) awards.push([A, PB_XP_LOSE, opEmail]);
    if (!D.isBot) awards.push([D, PB_XP_LOSE, chEmail]);
  } else {
    const wEmail = winner.id === A.id ? opEmail : chEmail;   // OPPONENT email for the winner
    const lEmail = loser.id === A.id ? opEmail : chEmail;
    const wAmt = forfeit ? PB_XP_FF_WIN  : PB_XP_WIN;
    const lAmt = forfeit ? PB_XP_FF_LOSE : PB_XP_LOSE;
    if (!winner.isBot) awards.push([winner, wAmt, wEmail]);
    if (!loser.isBot)  awards.push([loser,  lAmt, lEmail]);
  }
  // Await awards so evolution/xp events precede the result card's teardown, but
  // never let a DB hiccup block the result from being sent.
  for (const [side, amt, oppEmail] of awards) {
    try { await petBattleAwardXp(matchId, side, amt, oppEmail); }
    catch (err) { console.error("pet battle award failed:", err); }
  }

  const winnerId = winner ? (winner.isBot ? "bot" : winner.id) : null;
  petBattleEmitBoth(b, "petBattleResult", (side) => ({
    matchId, reason, forfeit, draw,
    winnerId,
    youWon: !draw && b.sides[side].id === winner.id,
    combatants: petBattleView(b),
    tournament: !!b.tournament,
  }));
  petBattleEmitTournamentSpectators(b, "petBattleResult", {
    matchId, reason, forfeit, draw,
    winnerSide,
    combatants: petBattleView(b),
    tournament: true,
  });
  b.state = "done";
  petBattleUnmap(b);
  if (b.tournament && winner) {
    try { await grandEventBattleFinished(b, winner); }
    catch (err) { console.error("Grand Event bracket advancement failed:", err); }
  }
  console.log(`Pet Battle #${b.seq} done (${reason})${draw ? " — draw" : ` — winner ${winner?.name}`}`);
}
function petBattleOtherId2(side) { return side === "challenger" ? "opponent" : "challenger"; }

// Both picks are in (or the pick timer fired / a no-pick defaulted to guard):
// resolve the round, emit petBattleRound, then either finish (KO or round cap)
// or advance to the next pick phase.
async function petBattleResolve(b) {
  if (b.state !== "picking") return;   // double-fire guard (pick race vs timer)
  const A = b.sides.challenger, D = b.sides.opponent;
  // No-pick defaults to guard (safe, non-punishing) so a stalled client doesn't
  // hang the match; illegal picks were already rejected at intake.
  if (!A.pick) A.pick = b.suddenDeath ? "attack" : "guard";
  if (!D.pick) D.pick = b.suddenDeath ? "attack" : "guard";
  b.state = "resolving";

  const result = petBattleResolveRound(b);
  b.round += 1;
  if (b.tournament && b.suddenDeath) b.suddenDeathExchanges = (b.suddenDeathExchanges || 0) + 1;
  const tournamentDecision = b.tournament ? grandEventBattleDecision({
    challengerHp: A.hp,
    opponentHp: D.hp,
    round: b.round,
    maxRounds: PB_MAX_ROUNDS,
    suddenDeath: b.suddenDeath,
    suddenDeathExchanges: b.suddenDeathExchanges || 0,
  }) : null;
  if (tournamentDecision?.suddenDeath && !b.suddenDeath) {
    b.suddenDeath = true;
    b.suddenDeathExchanges = 0;
  }

  petBattleEmitBoth(b, "petBattleRound", (side) => ({
    matchId: b.matchId, round: b.round, maxRounds: PB_MAX_ROUNDS,
    result, combatants: petBattleView(b), suddenDeath: !!b.suddenDeath,
    overtimeReset: tournamentDecision?.action === "overtime-reset",
  }));
  petBattleEmitTournamentSpectators(b, "petBattleRound", {
    matchId: b.matchId, round: b.round, maxRounds: PB_MAX_ROUNDS,
    result, combatants: petBattleView(b), suddenDeath: !!b.suddenDeath,
    overtimeReset: tournamentDecision?.action === "overtime-reset",
  });

  // Reset picks for the next round.
  A.pick = null; D.pick = null;

  if (tournamentDecision?.action === "overtime-reset") {
    // NBA-style bracket matches cannot draw. A simultaneous knockout starts a
    // clean overtime possession at full HP; using full HP avoids identical
    // one-hit builds immediately repeating the same mutual knockout forever.
    // Overtime removes Guard and ends as soon as one pet leads after an exchange.
    for (const side of [A, D]) {
      side.hp = side.stats.maxHp;
      side.charge = 0;
      side.specialCd = 0;
      side.status = {
        shield: 0, dot: null, weaken: 0, exposed: 0, power: 0,
        evade: 0, counter: 0, regen: 0, regenAmount: 0, rebirth: false,
      };
    }
    petBattleBeginPick(b);
    return;
  }
  if (tournamentDecision?.action === "seed-tiebreak") {
    const aSeed = Number(A.tournamentSeed) || Number.MAX_SAFE_INTEGER;
    const dSeed = Number(D.tournamentSeed) || Number.MAX_SAFE_INTEGER;
    await petBattleFinish(b, {
      reason: "suddenDeath",
      winnerSide: aSeed <= dSeed ? "challenger" : "opponent",
    });
    return;
  }
  if (tournamentDecision?.action === "finish") {
    await petBattleFinish(b, {
      reason: b.suddenDeath ? "suddenDeath" : (A.hp <= 0 || D.hp <= 0 ? "ko" : "rounds"),
      winnerSide: tournamentDecision.winnerSide,
    });
    return;
  }
  if (b.tournament) {
    petBattleBeginPick(b);
    return;
  }
  if (A.hp <= 0 || D.hp <= 0) {
    await petBattleFinish(b, { reason: "ko" });
    return;
  }
  if (b.round >= PB_MAX_ROUNDS) {
    await petBattleFinish(b, { reason: "rounds" });
    return;
  }
  petBattleBeginPick(b);
}

// Open a fresh pick phase: arm the short pick timer, tell both humans it's time
// to pick (with each side's currently-legal moves), and let the bot choose
// after a natural small delay.
function petBattleBeginPick(b) {
  b.state = "picking";
  clearTimeout(b.pickTimer);
  b.pickTimer = setTimeout(() => {
    petBattleResolve(b).catch((err) => console.error("pet battle resolve failed:", err));
  }, PB_PICK_MS);
  petBattleEmitBoth(b, "petBattlePickStatus", (side) => {
    const me = b.sides[side], foe = b.sides[petBattleOtherId2(side)];
    return {
      matchId: b.matchId, round: b.round + 1, maxRounds: PB_MAX_ROUNDS, pickMs: PB_PICK_MS,
      legal: [...PB_MOVES].filter((mv) => (!b.suddenDeath || mv !== "guard") && petBattleMoveLegal(me, mv)),
      charge: me.charge, ultCharge: PB_ULT_CHARGE, specialCd: me.specialCd,
      you: petBattleCombatantView(b, side),
      foe: petBattleCombatantView(b, petBattleOtherId2(side)),
      tournament: !!b.tournament,
      suddenDeath: !!b.suddenDeath,
    };
  });
  petBattleEmitTournamentSpectators(b, "petBattleSpectatorStatus", {
    matchId: b.matchId,
    round: b.round + 1,
    maxRounds: PB_MAX_ROUNDS,
    pickMs: PB_PICK_MS,
    combatants: petBattleView(b),
    tournament: true,
    suddenDeath: !!b.suddenDeath,
  });
  // Bot picks after a natural beat.
  if (petBattleIsBot(b)) {
    clearTimeout(b.botTimer);
    const delay = PB_BOT_MIN_MS + Math.floor(Math.random() * (PB_BOT_MAX_MS - PB_BOT_MIN_MS + 1));
    b.botTimer = setTimeout(() => {
      if (b.state !== "picking") return;
      const bot = b.sides.opponent, foe = b.sides.challenger;
      bot.pick = petBattleBotMove(bot, foe);
      if (bot.pick && b.sides.challenger.pick) {
        petBattleResolve(b).catch((err) => console.error("pet battle resolve failed:", err));
      }
    }, delay);
  }
}

// Start a battle once both sides are locked: freeze snapshots, emit the safe
// petBattleStart to both humans, and open round 1's pick phase.
function petBattleStart(b) {
  b.state = "starting";
  b.round = 0;
  petBattleEmitBoth(b, "petBattleStart", (side) => ({
    matchId: b.matchId, maxRounds: PB_MAX_ROUNDS, pickMs: PB_PICK_MS,
    you: side, combatants: petBattleView(b),
    tournament: !!b.tournament,
    eventLabel: b.tournament ? "Pet Wars Grand Event" : "",
  }));
  petBattleEmitTournamentSpectators(b, "petBattleStart", grandEventSpectatorStartPayload(b));
  petBattleBeginPick(b);
}

// A human LEFT (disconnect / kick / dropLiveByEmail) with a battle at stake.
// A pending challenge just cancels; an ACTIVE battle settles as a FORFEIT by
// the leaver (winner +2, leaver +0) — same anti-dodge policy as the rps roster.
// Called BEFORE players[id] is deleted so the winner's snapshot email is still
// resolvable for the XP award.
function petBattleForfeitForLeave(id) {
  const b = battleBySocket.get(id);
  if (!b) return;
  if (b.state === "pending") {
    petBattleCancel(id, "They left the office — battle cancelled.");
    return;
  }
  if (b.state !== "picking" && b.state !== "resolving" && b.state !== "starting") return;  // settling/done stands
  const leaverSide = b.sides.challenger.id === id ? "challenger" : "opponent";
  const winnerSide = petBattleOtherId2(leaverSide);
  petBattleFinish(b, { reason: "forfeit", winnerSide, forfeit: true })
    .catch((err) => console.error("pet battle leave-forfeit failed:", err));
}

// Cancel a pending/active battle with a message to both humans and no XP moved
// (mutual no-show / explicit cancel of a not-yet-started fight). An active
// fight that a caller wants to END as a forfeit uses petBattleFinish instead.
function petBattleCancel(id, reason) {
  const b = battleBySocket.get(id);
  if (!b || (b.state === "settling" || b.state === "done")) return;
  b.state = "done";
  clearBattleTimers(b);
  petBattleUnmap(b);
  const msg = reason || "Battle cancelled.";
  // Pending challenges do not have combat snapshots yet, so emit by the two
  // known socket ids instead of going through petBattleEmitBoth(b.sides).
  io.to(b.challengerId).emit("petBattleCancelled", { matchId: b.matchId, reason: msg });
  if (b.opponentId !== BOT_ID)
    io.to(b.opponentId).emit("petBattleCancelled", { matchId: b.matchId, reason: msg });
}

// ══════════════════════════════════════════════════════════════════════════
// PET WARS GRAND EVENT
// ══════════════════════════════════════════════════════════════════════════
// The bracket and every coin mutation are server-owned. The event snapshot is
// persisted after each transition; entry, refund, stage-reward, and champion
// credits have their own ledgers so replaying a transition is always safe.

function grandEventQueue(work) {
  const run = grandEventOp.then(work, work);
  grandEventOp = run.catch((err) => console.error("Grand Event operation failed:", err));
  return run;
}

function grandEventSocketForEmail(email) {
  for (const [id, p] of Object.entries(players)) if (p.email === email) return id;
  return null;
}

function grandEventEntrantSnapshot(p) {
  if (!p?.email || !p.pet) return null;
  if (Array.isArray(p.cosmetics) && !p.cosmetics.includes(p.pet)) return null;
  const xp = ((p.petXp || {})[p.pet]) || 0;
  return {
    email: p.email,
    name: p.name,
    petId: p.pet,
    stage: petStageOfPet(p.pet, xp),
    build: { ...effectivePetBuild(p, p.pet) },
    seed: 0,
    status: "active",
    viewMode: "playing",
    joinedAt: Date.now(),
  };
}

function grandEventEmailCompeting(email) {
  if (!grandEvent || grandEvent.state !== "running" || !email) return false;
  return grandEvent.entrants.get(email)?.status === "active";
}

function grandEventIsBlockingOfficeEvents() {
  return !!grandEvent && (grandEvent.state === "registration" || grandEvent.state === "running");
}

function grandEventSerialize() {
  if (!grandEvent) return {};
  return {
    joinDeadline: grandEvent.joinDeadline || 0,
    entrants: [...grandEvent.entrants.values()],
    rounds: grandEvent.rounds || [],
    currentRoundIndex: grandEvent.currentRoundIndex || 0,
    currentMatchIndex: grandEvent.currentMatchIndex || 0,
    byes: grandEvent.byes || [],
    champion: grandEvent.champion || null,
    cancelledMessage: grandEvent.cancelledMessage || "",
  };
}

async function grandEventPersist() {
  if (!grandEvent) return;
  await pool.query(
    `UPDATE jpo_grand_events
        SET state=$2, config=$3::jsonb, snapshot=$4::jsonb,
            champion_email=$5, updated_at=now(),
            completed_at=CASE WHEN $2 IN ('complete','cancelled') THEN coalesce(completed_at,now()) ELSE completed_at END
      WHERE id=$1`,
    [
      grandEvent.id,
      grandEvent.state,
      JSON.stringify(grandEvent.config),
      JSON.stringify(grandEventSerialize()),
      grandEvent.champion?.email || null,
    ],
  );
}

function grandEventEntrantView(email, readySet = null) {
  const e = grandEvent?.entrants.get(email);
  if (!e) return null;
  return {
    seed: e.seed,
    name: e.name,
    petId: e.petId,
    stage: e.stage,
    status: e.status,
    ready: !!readySet?.has(email),
    online: !!grandEventSocketForEmail(email),
  };
}

function grandEventRoundReward(round) {
  if (!round || !grandEvent) return 0;
  if (round.key === "opening") return grandEvent.config.rewards.opening;
  if (round.key === "quarterfinal") return grandEvent.config.rewards.quarterfinal;
  if (round.key === "semifinal") return grandEvent.config.rewards.semifinal;
  return grandEvent.config.rewards.final;
}

function grandEventCurrentMatch() {
  return grandEvent?.rounds?.[grandEvent.currentRoundIndex]?.matches?.[grandEvent.currentMatchIndex] || null;
}

function grandEventPublicView(email = null) {
  if (!grandEvent) return { active: false };
  if (grandEvent.state === "complete" && Date.now() - Number(grandEvent.champion?.at || 0) > 15 * 60_000)
    return { active: false };
  if (grandEvent.state === "cancelled" && Date.now() - Number(grandEvent.endedAt || 0) > 60_000)
    return { active: false };
  const current = grandEventCurrentMatch();
  const readySet = new Set(current?.ready || []);
  const rounds = (grandEvent.rounds || []).map((round) => ({
    key: round.key,
    label: round.label,
    reward: grandEventRoundReward(round),
    matches: round.matches.map((m) => ({
      id: m.id,
      state: m.state,
      slot: m.slot,
      p1: grandEventEntrantView(m.p1, new Set(m.ready || [])),
      p2: grandEventEntrantView(m.p2, new Set(m.ready || [])),
      winnerSeed: m.winner ? grandEvent.entrants.get(m.winner)?.seed || null : null,
      forfeit: !!m.forfeit,
    })),
  }));
  const mine = email ? grandEvent.entrants.get(email) : null;
  const isCurrent = !!current && (current.p1 === email || current.p2 === email);
  return {
    active: true,
    id: grandEvent.id,
    state: grandEvent.state,
    entryFee: grandEvent.config.entryFee,
    prizeLabel: grandEvent.config.prizeLabel,
    prizeDetails: grandEvent.config.prizeDetails,
    rewards: { ...grandEvent.config.rewards },
    joinDeadline: grandEvent.joinDeadline || 0,
    minPlayers: GE_MIN_PLAYERS,
    maxPlayers: GE_MAX_PLAYERS,
    allowedCounts: [...GE_ALLOWED_COUNTS],
    canStart: grandEvent.state === "registration" && GE_ALLOWED_COUNTS.has(grandEvent.entrants.size),
    pot: grandEvent.entrants.size * grandEvent.config.entryFee,
    entrants: [...grandEvent.entrants.values()]
      .sort((a, b) => (a.seed || a.joinedAt) - (b.seed || b.joinedAt))
      .map((e) => grandEventEntrantView(e.email, readySet)),
    rounds,
    currentRoundIndex: grandEvent.currentRoundIndex || 0,
    currentMatchId: current?.id || null,
    currentReward: grandEventRoundReward(grandEvent.rounds?.[grandEvent.currentRoundIndex]),
    readyDeadline: current?.readyDeadline || 0,
    champion: grandEvent.champion ? {
      seed: grandEvent.champion.seed,
      name: grandEvent.champion.name,
      petId: grandEvent.champion.petId,
      stage: grandEvent.champion.stage,
      pot: grandEvent.champion.pot,
      roundReward: grandEvent.champion.roundReward,
      prizeLabel: grandEvent.config.prizeLabel,
      prizeDetails: grandEvent.config.prizeDetails,
      at: grandEvent.champion.at,
    } : null,
    cancelledMessage: grandEvent.cancelledMessage || "",
    me: {
      joined: !!mine,
      status: mine?.status || null,
      viewMode: mine?.viewMode || (mine?.status === "eliminated" ? "decision" : "playing"),
      isCurrent,
      ready: !!email && readySet.has(email),
      canReady: grandEvent.state === "running" && isCurrent && current?.state === "ready" && !readySet.has(email),
      canJoin: grandEvent.state === "registration" && !mine && grandEvent.entrants.size < GE_MAX_PLAYERS,
      canWithdraw: grandEvent.state === "registration" && !!mine,
      canChooseAfterLoss: (grandEvent.state === "running" || grandEvent.state === "complete")
        && mine?.status === "eliminated",
    },
  };
}

function grandEventEmitToSocket(id) {
  const email = players[id]?.email || null;
  io.to(id).emit("grandEventState", grandEventPublicView(email));
}

function grandEventBroadcast() {
  for (const id of Object.keys(players)) grandEventEmitToSocket(id);
  for (const id of admins) {
    if (!players[id]) io.to(id).emit("grandEventState", grandEventPublicView(null));
  }
}

function grandEventCurrentBattle() {
  const match = grandEventCurrentMatch();
  if (!grandEvent || grandEvent.state !== "running" || match?.state !== "active" || !match.battleId) return null;
  for (const battle of new Set(battleBySocket.values())) {
    if (battle?.tournament
        && battle.grandEventId === grandEvent.id
        && battle.grandEventMatchId === match.id
        && battle.matchId === match.battleId
        && battle.state !== "done") return battle;
  }
  return null;
}

function grandEventSpectatorSocketIds(battle) {
  if (!battle?.tournament || !grandEvent || battle.grandEventId !== grandEvent.id) return [];
  const ids = [];
  for (const entrant of grandEvent.entrants.values()) {
    if (entrant.status !== "eliminated" || entrant.viewMode !== "spectate") continue;
    const id = grandEventSocketForEmail(entrant.email);
    if (id && id !== battle.challengerId && id !== battle.opponentId) ids.push(id);
  }
  return ids;
}

function grandEventSpectatorStartPayload(battle) {
  if (!battle?.tournament) return null;
  return {
    matchId: battle.matchId,
    maxRounds: PB_MAX_ROUNDS,
    pickMs: PB_PICK_MS,
    you: "challenger",
    viewSide: "challenger",
    spectator: true,
    combatants: petBattleView(battle),
    tournament: true,
    eventLabel: "Pet Wars Grand Event",
  };
}

function petBattleEmitTournamentSpectators(battle, event, payload) {
  if (!payload || !battle?.tournament) return;
  for (const id of grandEventSpectatorSocketIds(battle)) {
    io.to(id).emit(event, { ...payload, spectator: true, viewSide: "challenger" });
  }
}

function grandEventEmitCurrentBattleToSpectator(id) {
  const email = players[id]?.email;
  const entrant = email ? grandEvent?.entrants.get(email) : null;
  if (!entrant || entrant.status !== "eliminated" || entrant.viewMode !== "spectate") return;
  const battle = grandEventCurrentBattle();
  if (!battle) return;
  io.to(id).emit("petBattleStart", grandEventSpectatorStartPayload(battle));
  io.to(id).emit("petBattleSpectatorStatus", {
    matchId: battle.matchId,
    round: battle.round + (battle.state === "picking" ? 1 : 0),
    maxRounds: PB_MAX_ROUNDS,
    pickMs: battle.state === "picking" ? PB_PICK_MS : 0,
    combatants: petBattleView(battle),
    tournament: true,
    spectator: true,
    viewSide: "challenger",
    suddenDeath: !!battle.suddenDeath,
    resolving: battle.state === "resolving" || battle.state === "settling",
  });
}

function grandEventSyncToSocket(id) {
  grandEventEmitToSocket(id);
  grandEventEmitCurrentBattleToSpectator(id);
}

function grandEventClearTimers() {
  if (!grandEvent) return;
  clearTimeout(grandEvent.joinTimer);
  clearTimeout(grandEvent.readyTimer);
  grandEvent.joinTimer = null;
  grandEvent.readyTimer = null;
}

function grandEventPairRound(key, label, emails) {
  const seeded = [...emails].sort((a, b) =>
    (grandEvent.entrants.get(a)?.seed || 999) - (grandEvent.entrants.get(b)?.seed || 999));
  const matches = [];
  let slot = 1;
  while (seeded.length >= 2) {
    const p1 = seeded.shift();
    const p2 = seeded.pop();
    matches.push({
      id: crypto.randomUUID(),
      slot: slot++,
      p1,
      p2,
      state: "queued",
      ready: [],
      readyDeadline: 0,
      battleId: null,
      winner: null,
      forfeit: false,
    });
  }
  return { key, label, matches };
}

async function grandEventCredit(email, amount, payoutKey, kind) {
  if (!grandEvent || !email || !(amount > 0)) return false;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let cl;
    try {
      cl = await pool.connect();
      await cl.query("BEGIN");
      const claim = await cl.query(
        `INSERT INTO jpo_grand_event_payouts (event_id,payout_key,email,amount,kind)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING 1`,
        [grandEvent.id, payoutKey, email, amount, kind],
      );
      let coins = null;
      if (claim.rows[0]) {
        const paid = await cl.query(
          `UPDATE jpo_players SET coins=coins+$2, updated_at=now() WHERE email=$1 RETURNING coins`,
          [email, amount],
        );
        if (!paid.rows[0]) throw new Error("winner account no longer exists");
        coins = paid.rows[0].coins;
      } else {
        // Every semantic payout key belongs to exactly one recipient. A replay
        // that proposes a different winner is an integrity error, not an
        // idempotent retry; never silently advance a new winner unpaid.
        const prior = await cl.query(
          `SELECT email,amount,kind FROM jpo_grand_event_payouts
            WHERE event_id=$1 AND payout_key=$2`,
          [grandEvent.id, payoutKey],
        );
        const row = prior.rows[0];
        if (!row || row.email !== email || Number(row.amount) !== amount || row.kind !== kind) {
          throw new Error(`Grand Event payout key conflict: ${payoutKey}`);
        }
      }
      await cl.query("COMMIT");
      if (coins !== null) {
        const sid = grandEventSocketForEmail(email);
        if (sid && players[sid]?.email === email) {
          players[sid].coins = coins;
          io.to(sid).emit("coinUpdate", { coins });
          io.to(sid).emit("grandEventPayout", { kind, amount, coins });
        }
      }
      return !!claim.rows[0];
    } catch (err) {
      lastErr = err;
      try { await cl?.query("ROLLBACK"); } catch {}
      if (attempt < 3) await new Promise((r) => setTimeout(r, 250 * attempt));
    } finally {
      cl?.release();
    }
  }
  throw lastErr || new Error("Grand Event payout failed");
}

async function grandEventRefundEntrant(entry, state = "refunded") {
  if (!grandEvent || !entry) return;
  await grandEventCredit(entry.email, grandEvent.config.entryFee, `entry-refund:${entry.email}`, "refund");
  await pool.query(
    `UPDATE jpo_grand_event_entries SET state=$3, updated_at=now() WHERE event_id=$1 AND email=$2`,
    [grandEvent.id, entry.email, state],
  );
}

async function grandEventCancelRegistration(message) {
  if (!grandEvent || grandEvent.state !== "registration" || grandEvent.closing) return;
  grandEvent.closing = true;
  clearTimeout(grandEvent.joinTimer);
  const entries = [...grandEvent.entrants.values()];
  let refundError = null;
  try {
    for (const entry of entries) {
      try { await grandEventRefundEntrant(entry, "refunded"); }
      catch (err) { refundError ||= err; }
    }
  } finally {
    grandEvent.closing = false;
  }
  if (refundError) {
    await grandEventPersist();
    throw new Error("Some refunds are still pending. Try cancel again; completed refunds will not duplicate.");
  }
  grandEvent.state = "cancelled";
  grandEvent.cancelledMessage = message || "The Grand Event was cancelled. Every entry fee was refunded.";
  grandEvent.endedAt = Date.now();
  await grandEventPersist();
  grandEventBroadcast();
  io.emit("grandEventCancelled", { id: grandEvent.id, message: grandEvent.cancelledMessage });
}

async function grandEventCreate(config, createdBy) {
  grandEventClearTimers();
  const id = crypto.randomUUID();
  grandEvent = {
    id,
    state: "registration",
    config,
    createdBy,
    joinDeadline: Date.now() + config.joinMs,
    entrants: new Map(),
    rounds: [],
    currentRoundIndex: 0,
    currentMatchIndex: 0,
    byes: [],
    champion: null,
    joinTimer: null,
    readyTimer: null,
    closing: false,
  };
  await pool.query(
    `INSERT INTO jpo_grand_events (id,state,config,snapshot,created_by)
     VALUES ($1,'registration',$2::jsonb,$3::jsonb,$4)`,
    [id, JSON.stringify(config), JSON.stringify(grandEventSerialize()), createdBy || ""],
  );
  grandEvent.joinTimer = setTimeout(() => {
    grandEventQueue(async () => {
      if (!grandEvent || grandEvent.id !== id || grandEvent.state !== "registration") return;
      if (GE_ALLOWED_COUNTS.has(grandEvent.entrants.size)) await grandEventStartBracket();
      else await grandEventCancelRegistration(
        `Registration closed with ${grandEvent.entrants.size} player${grandEvent.entrants.size === 1 ? "" : "s"} — the event needs at least 8 players and a supported roster of 8, 10, 12, 14, or 16. Every entry fee was refunded.`,
      );
    });
  }, config.joinMs);
  grandEventBroadcast();
  return grandEvent;
}

async function grandEventJoin(id) {
  const p = players[id];
  if (!p?.email || !grandEvent || grandEvent.state !== "registration" || grandEvent.closing) {
    throw new Error("Registration is not open.");
  }
  if (grandEvent.entrants.has(p.email)) throw new Error("You're already in the bracket.");
  if (grandEvent.entrants.size >= GE_MAX_PLAYERS) throw new Error("The 16-player bracket is full.");
  if (battleBySocket.has(id) || rpsBySocket.has(id) || inRound(id)) throw new Error("Finish your current game first.");
  const entry = grandEventEntrantSnapshot(p);
  if (!entry) throw new Error("Equip a pet you own before joining.");
  // Date.now() can tie when several sockets register within one millisecond.
  // Persist an explicit monotonic order so seeds survive fast joins/restarts.
  entry.registrationOrder = grandEvent.entrants.size + 1;
  const fee = grandEvent.config.entryFee;
  let cl;
  try {
    cl = await pool.connect();
    await cl.query("BEGIN");
    const inserted = await cl.query(
      `INSERT INTO jpo_grand_event_entries (event_id,email,entry_fee,state,entrant)
       VALUES ($1,$2,$3,'joined',$4::jsonb) ON CONFLICT DO NOTHING RETURNING 1`,
      [grandEvent.id, p.email, fee, JSON.stringify(entry)],
    );
    if (!inserted.rows[0]) throw new Error("This account already entered this event.");
    const paid = await cl.query(
      `UPDATE jpo_players SET coins=coins-$2, updated_at=now()
        WHERE email=$1 AND coins >= $2 RETURNING coins`,
      [p.email, fee],
    );
    if (!paid.rows[0]) throw new Error(`You need ${fee.toLocaleString()} coins to enter.`);
    await cl.query("COMMIT");
    grandEvent.entrants.set(p.email, entry);
    p.coins = paid.rows[0].coins;
    io.to(id).emit("coinUpdate", { coins: p.coins });
    await grandEventPersist();
    grandEventBroadcast();
  } catch (err) {
    try { await cl?.query("ROLLBACK"); } catch {}
    throw err;
  } finally {
    cl?.release();
  }
}

async function grandEventWithdraw(id) {
  const p = players[id];
  if (!p?.email || !grandEvent || grandEvent.state !== "registration" || grandEvent.closing)
    throw new Error("Entries are locked.");
  const entry = grandEvent.entrants.get(p.email);
  if (!entry) throw new Error("You're not entered.");
  await grandEventRefundEntrant(entry, "withdrawn");
  grandEvent.entrants.delete(p.email);
  await grandEventPersist();
  grandEventBroadcast();
}

async function grandEventStartBracket() {
  if (!grandEvent || grandEvent.state !== "registration") throw new Error("No registration lobby is open.");
  const count = grandEvent.entrants.size;
  if (!GE_ALLOWED_COUNTS.has(count))
    throw new Error("Start requires at least 8 players and a supported roster of 8, 10, 12, 14, or 16.");
  clearTimeout(grandEvent.joinTimer);
  grandEvent.joinTimer = null;

  // Refresh every online entrant's authoritative equipped pet/build at the
  // instant the bracket locks. Offline entrants retain the valid join snapshot.
  for (const entry of grandEvent.entrants.values()) {
    const sid = grandEventSocketForEmail(entry.email);
    const fresh = sid ? grandEventEntrantSnapshot(players[sid]) : null;
    if (fresh) Object.assign(entry, fresh, { joinedAt: entry.joinedAt });
  }
  [...grandEvent.entrants.values()]
    .sort((a, b) =>
      (a.registrationOrder || 999) - (b.registrationOrder || 999)
      || a.joinedAt - b.joinedAt
      || a.email.localeCompare(b.email))
    .forEach((entry, i) => {
      entry.seed = i + 1;
      entry.status = "active";
      entry.viewMode = "playing";
    });

  grandEvent.state = "running";
  grandEvent.rounds = [];
  grandEvent.currentRoundIndex = 0;
  grandEvent.currentMatchIndex = 0;
  grandEvent.byes = [];
  const emails = [...grandEvent.entrants.values()]
    .sort((a, b) => a.seed - b.seed)
    .map((e) => e.email);
  const opening = grandEventOpeningPlan(count, emails);
  grandEvent.byes = opening.byes;
  grandEvent.rounds.push(grandEventPairRound(opening.key, opening.label, opening.participants));
  await pool.query(
    `UPDATE jpo_grand_event_entries e
        SET entrant=v.entrant::jsonb, updated_at=now()
       FROM (SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(email text, entrant jsonb)) v
      WHERE e.event_id=$1 AND e.email=v.email`,
    [
      grandEvent.id,
      JSON.stringify([...grandEvent.entrants.values()].map((e) => ({ email: e.email, entrant: e }))),
    ],
  ).catch((err) => console.error("Grand Event frozen snapshot update failed:", err));
  await grandEventPersist();
  await grandEventArmCurrentMatch();
}

async function grandEventArmCurrentMatch() {
  if (!grandEvent || grandEvent.state !== "running") return;
  clearTimeout(grandEvent.readyTimer);
  const match = grandEventCurrentMatch();
  if (!match || match.state === "active" || match.state === "done") return;
  match.state = "ready";
  match.ready = [];
  match.readyDeadline = Date.now() + GE_READY_MS;
  match.battleId = null;
  await grandEventPersist();
  grandEventBroadcast();
  const eventId = grandEvent.id, matchId = match.id;
  grandEvent.readyTimer = setTimeout(() => {
    grandEventQueue(async () => {
      if (!grandEvent || grandEvent.id !== eventId || grandEvent.state !== "running") return;
      const cur = grandEventCurrentMatch();
      if (!cur || cur.id !== matchId || cur.state !== "ready") return;
      const ready = new Set(cur.ready || []);
      const p1Available = ready.has(cur.p1) && !!grandEventSocketForEmail(cur.p1);
      const p2Available = ready.has(cur.p2) && !!grandEventSocketForEmail(cur.p2);
      let winner = cur.p1;
      if (p2Available && !p1Available) winner = cur.p2;
      else if (p1Available && !p2Available) winner = cur.p1;
      else {
        const p1Seed = grandEvent.entrants.get(cur.p1)?.seed || 999;
        const p2Seed = grandEvent.entrants.get(cur.p2)?.seed || 999;
        winner = p1Seed <= p2Seed ? cur.p1 : cur.p2;
      }
      await grandEventCompleteMatch(cur.id, winner, { forfeit: true, reason: "ready timeout" });
    });
  }, GE_READY_MS);
}

async function grandEventReady(id) {
  const p = players[id];
  const match = grandEventCurrentMatch();
  if (!p?.email || !grandEvent || grandEvent.state !== "running" || !match || match.state !== "ready")
    throw new Error("No tournament match is waiting for you.");
  if (match.p1 !== p.email && match.p2 !== p.email) throw new Error("Your matchup isn't up yet.");
  if (battleBySocket.has(id) || rpsBySocket.has(id) || inRound(id)) throw new Error("Finish your current game first.");
  match.ready = Array.from(new Set([...(match.ready || []), p.email]));
  await grandEventPersist();
  grandEventBroadcast();
  if (match.ready.includes(match.p1) && match.ready.includes(match.p2)) await grandEventStartBattle(match);
}

async function grandEventSetViewMode(id, mode) {
  const p = players[id];
  if (!p?.email || !grandEvent || !["running", "complete"].includes(grandEvent.state))
    throw new Error("No Grand Event is available.");
  const entrant = grandEvent.entrants.get(p.email);
  if (!entrant || entrant.status !== "eliminated")
    throw new Error("Quit and Spectate are available after elimination.");
  if (mode !== "spectate" && mode !== "quit") throw new Error("Choose Quit or Spectate.");
  entrant.viewMode = mode;
  await grandEventPersist();
  grandEventBroadcast();
  if (mode === "spectate") grandEventEmitCurrentBattleToSpectator(id);
}

async function grandEventStartBattle(match) {
  if (!grandEvent || grandEvent.state !== "running" || match !== grandEventCurrentMatch() || match.state !== "ready") return;
  const aId = grandEventSocketForEmail(match.p1);
  const dId = grandEventSocketForEmail(match.p2);
  if (!aId || !dId) return;   // the ready clock will settle a walkover if they do not return
  if (battleBySocket.has(aId) || battleBySocket.has(dId) || rpsBySocket.has(aId) || rpsBySocket.has(dId)) return;
  const a = grandEvent.entrants.get(match.p1), d = grandEvent.entrants.get(match.p2);
  if (!a || !d) throw new Error("A bracket entrant is missing.");
  const matchId = crypto.randomUUID();
  const b = {
    matchId,
    seq: ++petBattleSeq,
    challengerId: aId,
    opponentId: dId,
    state: "starting",
    round: 0,
    sides: {
      challenger: petBattleSnapshot(aId, a.name, a.petId, a.stage, a.build, false),
      opponent: petBattleSnapshot(dId, d.name, d.petId, d.stage, d.build, false),
    },
    tournament: true,
    grandEventId: grandEvent.id,
    grandEventMatchId: match.id,
    suddenDeath: false,
    suddenDeathExchanges: 0,
  };
  b.sides.challenger.tournamentEmail = a.email;
  b.sides.opponent.tournamentEmail = d.email;
  b.sides.challenger.tournamentSeed = a.seed;
  b.sides.opponent.tournamentSeed = d.seed;
  battleBySocket.set(aId, b);
  battleBySocket.set(dId, b);
  clearTimeout(grandEvent.readyTimer);
  match.state = "active";
  match.readyDeadline = 0;
  match.battleId = matchId;
  await grandEventPersist();
  grandEventBroadcast();
  petBattleStart(b);
  console.log(`Grand Event: ${a.name} vs ${d.name} (${grandEvent.rounds[grandEvent.currentRoundIndex].label})`);
}

async function grandEventCompleteMatch(matchId, winnerEmail, { forfeit = false, reason = "" } = {}) {
  if (!grandEvent || grandEvent.state !== "running") return;
  const round = grandEvent.rounds[grandEvent.currentRoundIndex];
  const match = round?.matches?.find((m) => m.id === matchId);
  if (!match || match.state === "done" || match.state === "settling") return;
  if (winnerEmail !== match.p1 && winnerEmail !== match.p2) throw new Error("Invalid tournament winner.");
  match.state = "settling";
  clearTimeout(grandEvent.readyTimer);
  const loserEmail = winnerEmail === match.p1 ? match.p2 : match.p1;
  const winner = grandEvent.entrants.get(winnerEmail);
  const loser = grandEvent.entrants.get(loserEmail);
  if (!winner || !loser) throw new Error("Tournament entrant disappeared.");
  loser.status = "eliminated";
  match.winner = winnerEmail;
  match.forfeit = !!forfeit;
  match.reason = reason || "";
  match.state = "done";
  const reward = grandEventRoundReward(round);
  let finalMatch = false;
  if (grandEvent.currentMatchIndex + 1 < round.matches.length) {
    grandEvent.currentMatchIndex += 1;
  } else if (round.key === "final") {
    finalMatch = true;
    grandEvent.state = "complete";
    grandEvent.champion = {
      email: winner.email,
      seed: winner.seed,
      name: winner.name,
      petId: winner.petId,
      stage: winner.stage,
      pot: grandEvent.entrants.size * grandEvent.config.entryFee,
      roundReward: reward,
      at: Date.now(),
    };
  } else {
    const winners = round.matches.map((m) => m.winner).filter(Boolean);
    const nextPlayers = round.key === "opening" ? [...grandEvent.byes, ...winners] : winners;
    const next = round.key === "opening"
      ? grandEventPairRound("quarterfinal", "Quarterfinals", nextPlayers)
      : round.key === "quarterfinal"
        ? grandEventPairRound("semifinal", "Semifinals", nextPlayers)
        : grandEventPairRound("final", "Championship", nextPlayers);
    grandEvent.rounds.push(next);
    grandEvent.currentRoundIndex += 1;
    grandEvent.currentMatchIndex = 0;
  }

  // The durable snapshot is the commit point for a match result. Payouts happen
  // only after this succeeds, so a crash before it replays an unpaid battle,
  // while a crash after it restores the recorded winner and recovers any
  // missing idempotent payout instead of paying a second replay winner.
  await grandEventPersist();
  if (process.env.GE_TEST_CRASH_AFTER_MATCH_PERSIST === "1") {
    process.exit(86);
  }

  try {
    if (reward > 0) {
      await grandEventCredit(winnerEmail, reward, `round:${match.id}`, "round");
      delete match.payoutPending;
    }
  } catch (err) {
    match.payoutPending = true;
    console.error(`Grand Event round reward pending for ${winnerEmail}:`, err);
  }

  if (finalMatch) {
    const pot = grandEvent.champion.pot;
    try {
      if (pot > 0) await grandEventCredit(winner.email, pot, "champion-pot", "champion");
      delete grandEvent.champion.payoutPending;
    } catch (err) {
      grandEvent.champion.payoutPending = true;
      console.error(`Grand Event champion pot pending for ${winner.email}:`, err);
    }
    await grandEventPersist();
    grandEventBroadcast();
    io.emit("grandEventChampion", grandEventPublicView(null).champion);
    console.log(`Grand Event champion: ${winner.name} (+${pot} pot, +${reward} final reward)`);
    return;
  }

  await grandEventPersist();
  grandEventBroadcast();
  await grandEventArmCurrentMatch();
}

async function grandEventBattleFinished(b, winner) {
  if (!b?.tournament || !winner?.tournamentEmail) return;
  await grandEventQueue(() =>
    grandEventCompleteMatch(b.grandEventMatchId, winner.tournamentEmail, {
      forfeit: b.finishWasForfeit,
      reason: b.finishReason || "",
    }));
}

async function grandEventRecoverPayouts() {
  if (!grandEvent) return;
  for (const round of grandEvent.rounds || []) {
    const reward = grandEventRoundReward(round);
    if (!(reward > 0)) continue;
    for (const match of round.matches || []) {
      if (match.state !== "done" || !match.winner) continue;
      try {
        await grandEventCredit(match.winner, reward, `round:${match.id}`, "round");
        delete match.payoutPending;
      } catch (err) { console.error("Grand Event reward recovery failed:", err); }
    }
  }
  if (grandEvent.state === "complete" && grandEvent.champion?.email && grandEvent.champion.pot > 0) {
    try {
      await grandEventCredit(grandEvent.champion.email, grandEvent.champion.pot, "champion-pot", "champion");
      delete grandEvent.champion.payoutPending;
    } catch (err) { console.error("Grand Event champion recovery failed:", err); }
  }
  await grandEventPersist();
}

async function grandEventRestoreFromDb() {
  const { rows } = await pool.query(
    `SELECT * FROM jpo_grand_events
      WHERE state IN ('registration','running','complete')
      ORDER BY created_at DESC LIMIT 1`,
  );
  if (!rows[0]) return;
  const row = rows[0];
  const config = row.config || {};
  const snap = row.snapshot || {};
  const entryRows = (await pool.query(
    `SELECT email, entrant FROM jpo_grand_event_entries WHERE event_id=$1 AND state='joined' ORDER BY joined_at`,
    [row.id],
  )).rows;
  const fromSnap = new Map((snap.entrants || []).map((e) => [e.email, e]));
  const entrants = new Map();
  for (const er of entryRows) {
    const e = fromSnap.get(er.email) || er.entrant;
    if (e?.email) entrants.set(e.email, e);
  }
  grandEvent = {
    id: row.id,
    state: row.state,
    config,
    createdBy: row.created_by || "",
    joinDeadline: Number(snap.joinDeadline) || 0,
    entrants,
    rounds: snap.rounds || [],
    currentRoundIndex: Number(snap.currentRoundIndex) || 0,
    currentMatchIndex: Number(snap.currentMatchIndex) || 0,
    byes: snap.byes || [],
    champion: snap.champion || null,
    cancelledMessage: snap.cancelledMessage || "",
    joinTimer: null,
    readyTimer: null,
    closing: false,
  };
  if (grandEvent.state === "running") {
    const match = grandEventCurrentMatch();
    if (match?.state === "active" || match?.state === "settling") {
      // Pet Battle combat is intentionally in-memory. After a process restart
      // the bracket matchup is replayed from its frozen entrant snapshots; no
      // reward or advancement was committed yet, so this cannot double-pay.
      match.state = "queued";
      match.ready = [];
      match.battleId = null;
      match.readyDeadline = 0;
    }
    await grandEventPersist();
    await grandEventRecoverPayouts();
    await grandEventArmCurrentMatch();
  } else if (grandEvent.state === "registration") {
    const left = grandEvent.joinDeadline - Date.now();
    if (left <= 0) {
      setTimeout(() => grandEventQueue(async () => {
        if (GE_ALLOWED_COUNTS.has(grandEvent?.entrants.size)) await grandEventStartBracket();
        else await grandEventCancelRegistration("Registration expired during a restart. Every entry fee was refunded.");
      }), 0);
    } else {
      const eventId = grandEvent.id;
      grandEvent.joinTimer = setTimeout(() => grandEventQueue(async () => {
        if (!grandEvent || grandEvent.id !== eventId || grandEvent.state !== "registration") return;
        if (GE_ALLOWED_COUNTS.has(grandEvent.entrants.size)) await grandEventStartBracket();
        else await grandEventCancelRegistration("Registration closed without an eligible even roster. Every entry fee was refunded.");
      }), left);
    }
  } else {
    await grandEventRecoverPayouts();
  }
  console.log(`Grand Event restored: ${grandEvent.id} (${grandEvent.state}, ${grandEvent.entrants.size} entrants)`);
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
    buddyGameBonus(cId, tId).catch((err) => console.error("buddy game bonus failed:", err));
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
  if (!forfeit) {
    coachDuelPlayed(winnerId, loserId).catch((err) => console.error("coach duel hook failed:", err));
    buddyGameBonus(winnerId, loserId).catch((err) => console.error("buddy game bonus failed:", err));
  }
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
    // Base rate × the shared-treat buff. Fractional halves (e.g. 3 × 1.5 =
    // 4.5) accumulate in p.earnFrac so nothing is lost to rounding: a boosted
    // desk-sitter gets 4,5,4,5,... coins on alternating minutes.
    const base = COIN_TICK_BASE + (isAtWorkSeat(p) ? WORK_BONUS : 0);
    // Buddy proximity buff multiplies WITH the shared-treat buff (both are
    // deliberately social; the daily minute cap bounds the stack).
    const buddyNear = buddyNearPos(p) &&
      await buddyCapConsume("buff|" + p.email, BUDDY_BUFF_DAILY_MIN).catch((e) => { console.error("buddy cap failed:", e); return false; });
    const mult = ((p.earnUntil || 0) > ltTickStart ? EARN_MULT : 1) * (buddyNear ? BUDDY_EARN_MULT : 1);
    const exact = base * mult;
    p.earnFrac = (p.earnFrac || 0) + exact;
    const rate = Math.floor(p.earnFrac);
    p.earnFrac -= rate;
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
    io.to(id).emit("coinUpdate", { coins: p.coins, buddyBoost: buddyNear });
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

// ── Prop Hunt (Hide & Seek) ─────────────────────────────────────────────
// The boss (any F8 admin) starts a round from wherever they're STANDING —
// that spot becomes the seekers' gathering base. Joiners are teleported
// there and frozen while the hider walks off and settles into a furniture
// disguise. When the hide timer ends, everyone is shown one extra piece of
// furniture (the prop) at the hider's final spot; seekers hunt at locked
// default zoom and press E on the suspicious object to win.
// ANTI-CHEAT: from phStart until phEnd the hider's playerMoved broadcasts
// are suppressed and their sprite is vanished on every client — the only
// position the server ever shares is the prop's frozen coordinates, so a
// modified client has nothing extra to reveal. (Zoom lock is client-side
// courtesy; the real secrecy is this suppression.)
// In-memory only: a server restart cancels the round harmlessly.
// Disguise ids must have a matching client texture in PH_TEX (index.html).
const PH_DISGUISES = new Set(["cooler", "punchbag", "treadmill", "chair", "computer", "plant", "cabinet", "board"]);
const PH_GUESS_RANGE_PX = 120;   // ~2.5 tiles — must walk right up to the prop
let propHunt = null;
// { state:'hiding'|'hunting', hiderId, hiderName, disguise,
//   gatherX, gatherY, seekers:Set<socketId>, hideEndsAt, endsAt,
//   huntMs, hideTimer, huntTimer }

function phFrozen(id) {
  if (!propHunt) return false;
  if (propHunt.state === "hiding")  return propHunt.seekers.has(id); // seekers wait at base
  if (propHunt.state === "hunting") return propHunt.hiderId === id;  // furniture doesn't walk
  return false;
}

function phBeginHunt() {
  if (!propHunt || propHunt.state !== "hiding") return;
  const hp = players[propHunt.hiderId];
  if (!hp) { phFinish(false, null, "hider left"); return; }
  if (propHunt.seekers.size === 0) { phFinish(false, null, "nobody joined"); return; }
  propHunt.state = "hunting";
  propHunt.endsAt = Date.now() + propHunt.huntMs;
  propHunt.huntTimer = setTimeout(() => phFinish(false, null, "time"), propHunt.huntMs);
  io.emit("phHunt", {
    prop: { x: Math.round(hp.x), y: Math.round(hp.y), disguise: propHunt.disguise },
    endsAt: propHunt.endsAt,
  });
}

// Snapshot guard: any full-players emit during a round must mask the hider's
// live coordinates (the sprite gets vanished client-side, but a modified
// client keeps the payload). The mask is the PUBLIC gathering spot — zero
// information. The hider themself gets the real map.
function phMaskedPlayers(forId) {
  if (!propHunt || forId === propHunt.hiderId) return players;
  const hp = players[propHunt.hiderId];
  if (!hp) return players;
  return { ...players, [propHunt.hiderId]: { ...hp, x: propHunt.gatherX, y: propHunt.gatherY, anim: "idle" } };
}

function phFinish(found, winnerName, reason) {
  if (!propHunt) return;
  clearTimeout(propHunt.hideTimer);
  clearTimeout(propHunt.huntTimer);
  const hid = propHunt.hiderId;
  const hp  = players[hid];
  io.emit("phEnd", {
    found: !!found,
    winnerName: winnerName || null,
    hiderName: propHunt.hiderName,
    reason: reason || (found ? "found" : "time"),
    // Un-vanish payload: where the hider stands right now (null if they left).
    hider: hp ? { id: hid, x: Math.round(hp.x), y: Math.round(hp.y), dir: hp.dir, anim: hp.anim } : null,
  });
  propHunt = null;
}

// ── Red Light, Green Light (the doll game) ──────────────────────────────
// Admin-started from F8 Events. Players join a lobby, get teleported to the
// start line of a big open-floor arena, and race to the finish while a giant
// doll turns around: moving during RED LIGHT (validated server-side off the
// same playerMove pipeline as anti-cheat) eliminates you on the spot. Pushing
// (rlglPush) shoves a nearby runner forward — during red light that's murder.
// If NOBODY reaches the finish, the same game replays until someone survives
// (owner request). When few runners remain, the floor turns SLIPPERY: clients
// glide with momentum, so stopping for red light gets dicey. Finishers split
// the pot via the same guarded additive-payout pattern as After Dark/Bingo.
// In-memory only: a restart cancels the game harmlessly (nothing was debited).
// West lawn (tiles 12-19 × 16-95, all Ext grass, verified clear): runners race
// DOWNWARD so everyone's face/outfit is visible, doll waits at the bottom.
const RLGL_ARENA = { x0: 576, y0: 768, x1: 960, y1: 4608 };
const RLGL_START_Y  = 880;     // runners line up here (top edge)
const RLGL_FINISH_Y = 3020;    // cross this → survived the round (~2140px run, ~15% shorter per owner)
const RLGL_DOLL = { x: 768, y: 3160 };
const RLGL_JOIN_MS       = Number(process.env.RLGL_JOIN_MS) || 45_000;
const RLGL_MIN_PLAYERS   = Number(process.env.RLGL_MIN_PLAYERS) || 3;
const RLGL_ATTEMPT_MS    = 90_000;       // per attempt; timer expiry wipes the field → replay (owner: visible per-round time limit)
const RLGL_PRIZE_MIN = 100, RLGL_PRIZE_MAX = 100_000;
const RLGL_MOVE_EPS_PX  = 10;            // drift under this during red is forgiven (jitter)
// Escalating phases, indexed by attempt (last one repeats forever).
// halfW = half-width of the legal strip in px (null = full lawn); stepping
// outside the strip is elimination. fakeouts = the doll twitches during green.
const RLGL_PHASES = [
  { name: "CLASSIC",       green: [1_500, 3_500], red: [3_000, 6_000], grace: 700, halfW: null, slippery: false, fakeouts: false },
  { name: "ANGRY DOLL",    green: [1_500, 3_500], red: [2_500, 5_000], grace: 700, halfW: null, slippery: false, fakeouts: false },
  { name: "NARROW PATH",   green: [1_000, 2_500], red: [2_500, 5_000], grace: 450, halfW: 96,   slippery: false, fakeouts: false },
  { name: "SUDDEN DEATH",  green: [900, 2_000],   red: [2_500, 4_500], grace: 400, halfW: 72,   slippery: true,  fakeouts: true  },
];
// Coin bait: scattered on the track each attempt — greed drags runners off
// their safe private lanes and into shove range. House pays.
const RLGL_COIN_N = 8, RLGL_COIN_VALUE = 25, RLGL_COIN_GRAB_PX = 40;
const RLGL_PUSH_RANGE_PX = 70, RLGL_PUSH_DIST_PX = 130, RLGL_PUSH_COOLDOWN_MS = 5_000;
const RLGL_PUSH_ARM_MS   = 11_000;  // owner rule: no shoving until intro (~4.5s) + 3-2-1 (GO ~8s) + 3s of spreading out
const RLGL_SLIPPERY_AT  = 3;             // ≤3 runners still on the field → slippery floor
const RLGL_MAX_ATTEMPTS = 20;            // sanity cap on total rounds/replays
const RLGL_SAFE_STREAK  = 3;             // 2 players left who BOTH survived this many rounds → co-champions
let rlgl = null;
// { state:'joining'|'running'|'ending', prize, starterName, attempt,
//   members: Map<socketId,{name,email,alive,finished,lastPushAt}>,
//   light:'green'|'red', redAt, slippery,
//   joinTimer, joinEndsAt, lightTimer, attemptTimer, endsAt, replayTimer }

// Eliminated runners lie where they fell until the attempt ends — the server
// rejects their movement outright (a body that walks off ruins the drama).
function rlglFrozen(id) {
  if (!rlgl || rlgl.state !== "running") return false;
  const m = rlgl.members.get(id);
  return !!m && !m.alive;
}

function rlglPhaseOf(attempt) {
  return RLGL_PHASES[Math.min(Math.max(attempt, 1), RLGL_PHASES.length) - 1];
}
function rlglPhase() { return rlglPhaseOf(rlgl ? rlgl.attempt : 1); }
// Legal x-strip for the current phase (the y-extent is always the full lawn).
function rlglBoundsNow() {
  const ph = rlglPhase();
  if (!ph.halfW) return { x0: RLGL_ARENA.x0, x1: RLGL_ARENA.x1 };
  const cx = (RLGL_ARENA.x0 + RLGL_ARENA.x1) / 2;
  return { x0: cx - ph.halfW, x1: cx + ph.halfW };
}

// An alive, not-yet-finished runner in a live round — the subset that the
// speed-fairness rules apply to (no coffee/pizza boosts, owner's rule).
function rlglActiveRunner(id) {
  if (!rlgl || rlgl.state !== "running") return false;
  const m = rlgl.members.get(id);
  return !!m && m.alive && !m.finished;
}

function rlglRunnersLeft() {
  let n = 0;
  for (const m of rlgl.members.values()) if (m.alive && !m.finished) n++;
  return n;
}

function rlglRoster() {
  return [...rlgl.members].map(([id, m]) => ({ id, name: m.name, alive: m.alive, finished: m.finished, safe: m.safe || 0 }));
}

function rlglCancel(reason) {
  if (!rlgl) return;
  const g = rlgl;
  rlgl = null;
  clearTimeout(g.joinTimer); clearTimeout(g.lightTimer); clearTimeout(g.attemptTimer); clearTimeout(g.replayTimer); clearTimeout(g.fakeTimer);
  io.emit("rlglCancelled", { reason });
  console.log(`RLGL: cancelled (${reason})`);
}

// Teleport a member to the start line (join + every replay). The server owns
// the position; the member's own client snaps via rlglTeleport, everyone else
// syncs through the ordinary playerMoved broadcast.
function rlglPlaceAtStart(id, idx) {
  const p = players[id];
  if (!p) return;
  const b = rlglBoundsNow();
  const lanes = Math.max(rlgl.members.size, 1);
  const laneW = (b.x1 - b.x0 - 40) / lanes;
  p.x = Math.round(b.x0 + 20 + laneW * (idx + 0.5));
  p.y = RLGL_START_Y;
  p.anim = "idle"; p.dir = "down";
  io.to(id).emit("rlglTeleport", { x: p.x, y: p.y });
  io.emit("playerMoved", { id, ...p });
}

// Sudden-death theater: mid-green the doll TWITCHES like she's turning
// (client-only animation, the light genuinely stays green — panic stops are
// their own punishment: pure lost time).
function rlglScheduleFake() {
  const ph = rlglPhase();
  if (!ph.fakeouts || rlgl.light !== "green") return;
  clearTimeout(rlgl.fakeTimer);
  rlgl.fakeTimer = setTimeout(() => {
    if (!rlgl || rlgl.state !== "running" || rlgl.light !== "green") return;
    io.emit("rlglFake", {});
  }, 500 + Math.floor(Math.random() * 1_200));
}

function rlglScheduleLight() {
  if (!rlgl || rlgl.state !== "running") return;
  const ph = rlglPhase();
  // The FIRST green of every attempt is extra long (owner rule): the client's
  // cinematic intro eats ~4s, so a normal-length green would flip to red
  // before players even see the field.
  let [lo, hi] = rlgl.light === "green" ? ph.green : ph.red;
  // (~4.5s camera intro, THEN the 3-2-1 (GO at ~8s), then ≥3s of guaranteed
  // running room before her first red.)
  if (rlgl.light === "green" && rlgl.firstLight) { lo = 11_000; hi = 12_500; rlgl.firstLight = false; }
  rlgl.lightTimer = setTimeout(() => {
    if (!rlgl || rlgl.state !== "running") return;
    rlgl.light = rlgl.light === "green" ? "red" : "green";
    if (rlgl.light === "red") rlgl.redAt = Date.now();
    io.emit("rlglLight", { light: rlgl.light, graceMs: ph.grace });
    if (rlgl.light === "green") rlglScheduleFake();
    else clearTimeout(rlgl.fakeTimer);
    rlglScheduleLight();
  }, lo + Math.floor(Math.random() * (hi - lo)));
}

function rlglStartAttempt() {
  if (!rlgl) return;
  // Drop members whose player entry vanished between attempts.
  for (const id of [...rlgl.members.keys()]) if (!players[id]) rlgl.members.delete(id);
  // Everyone else bailed between rounds → the one still standing takes the pot.
  if (rlgl.members.size === 1) {
    rlgl.state = "running";   // rlglFinish's settlement guard expects a live game
    rlglFinish([...rlgl.members]).catch((err) => console.error("RLGL finish failed:", err));
    return;
  }
  if (rlgl.members.size < 2) { rlglCancel("Not enough players left on the field."); return; }
  rlgl.state = "running";
  rlgl.replayTimer = null;   // fired (or unused) — a set value now means "between attempts"
  rlgl.light = "green";
  rlgl.firstLight = true;   // first green runs extra long (cinematic intro cover)
  rlgl.redAt = 0;
  const ph = rlglPhaseOf(rlgl.attempt);
  const bounds = rlglBoundsNow();
  rlgl.slippery = !!ph.slippery;   // sudden death: iced from the first step
  // The 90s clock starts at GO, not at the camera intro — the ~8s of
  // cinematic + 3-2-1 countdown is free (owner: "is 90s enough?!").
  rlgl.endsAt = Date.now() + 8_000 + RLGL_ATTEMPT_MS;
  rlgl.beganAt = Date.now();   // shove arm-delay reference (RLGL_PUSH_ARM_MS)
  // Scatter the coin bait — random spots on the legal strip, away from the
  // start and finish so nobody scoops them standing still.
  rlgl.coins = Array.from({ length: RLGL_COIN_N }, () => ({
    x: Math.round(bounds.x0 + 25 + Math.random() * (bounds.x1 - bounds.x0 - 50)),
    y: Math.round(RLGL_START_Y + 250 + Math.random() * (RLGL_FINISH_Y - RLGL_START_Y - 450)),
    taken: false,
  }));
  let idx = 0;
  for (const [id, m] of rlgl.members) {
    m.alive = true; m.finished = false;
    // Fair race: any coffee/pizza boost still running is stripped at the start
    // line (durationMs:1 expires the client's mirror immediately — the client
    // handler treats 0 as "use the default", so 1ms is the "off" signal).
    const p = players[id];
    if (p && p.boostUntil) { p.boostUntil = 0; io.emit("coffeeBoost", { id, durationMs: 1, mult: 1 }); }
    rlglPlaceAtStart(id, idx++);
  }
  clearTimeout(rlgl.attemptTimer); clearTimeout(rlgl.lightTimer); clearTimeout(rlgl.fakeTimer);
  rlgl.attemptTimer = setTimeout(rlglTimeUp, 8_000 + RLGL_ATTEMPT_MS);
  io.emit("rlglBegin", {
    attempt: rlgl.attempt, prize: rlgl.prize, endsAt: rlgl.endsAt,
    phase: { n: Math.min(rlgl.attempt, RLGL_PHASES.length), name: ph.name },
    arena: RLGL_ARENA, bounds, startY: RLGL_START_Y, finishY: RLGL_FINISH_Y, doll: RLGL_DOLL,
    players: rlglRoster(), light: "green", slippery: rlgl.slippery,
    coins: rlgl.coins.map((c, i) => ({ idx: i, x: c.x, y: c.y })), coinValue: RLGL_COIN_VALUE,
    pushRangePx: RLGL_PUSH_RANGE_PX, pushCooldownMs: RLGL_PUSH_COOLDOWN_MS, pushArmMs: RLGL_PUSH_ARM_MS,
  });
  if (rlgl.slippery) io.emit("rlglSlippery", { on: true });
  rlglScheduleFake();
  rlglScheduleLight();
  console.log(`RLGL: attempt ${rlgl.attempt} (${ph.name}) started with ${rlgl.members.size} runners`);
}

function rlglMaybeSlippery() {
  if (!rlgl || rlgl.state !== "running" || rlgl.slippery) return;
  const left = rlglRunnersLeft();
  if (left > 0 && left <= RLGL_SLIPPERY_AT && rlgl.members.size > RLGL_SLIPPERY_AT) {
    rlgl.slippery = true;
    io.emit("rlglSlippery", { on: true });
    console.log("RLGL: floor is now SLIPPERY");
  }
}

function rlglEliminate(id, cause, byName) {
  const m = rlgl?.members.get(id);
  if (!m || !m.alive || m.finished) return;
  m.alive = false;
  const p = players[id];
  io.emit("rlglOut", {
    id, name: m.name, cause, byName: byName || null,
    x: p ? Math.round(p.x) : 0, y: p ? Math.round(p.y) : 0,
  });
  console.log(`RLGL: ${m.name} eliminated (${cause}${byName ? ` by ${byName}` : ""})`);
  rlglMaybeSlippery();
  rlglCheckAttemptEnd();
}

function rlglTimeUp() {
  if (!rlgl || rlgl.state !== "running") return;
  for (const [id, m] of rlgl.members) if (m.alive && !m.finished) rlglEliminate(id, "time");
  // rlglEliminate → rlglCheckAttemptEnd handles the rest (replay: nobody finished).
}

function rlglCheckAttemptEnd() {
  if (!rlgl || rlgl.state !== "running" || rlglRunnersLeft() > 0) return;
  const finishers = [...rlgl.members].filter(([, m]) => m.alive && m.finished);
  clearTimeout(rlgl.lightTimer); clearTimeout(rlgl.attemptTimer); clearTimeout(rlgl.fakeTimer);
  if (finishers.length === 1) { rlglFinish(finishers).catch((err) => console.error("RLGL finish failed:", err)); return; }
  if (finishers.length >= 2) {
    // Owner's rule (Aug 2026): survivors don't split on round 1 — the field
    // is cut and they race AGAIN. Only when the SAME group survives two
    // rounds in a row do they split the pot.
    const setNow = finishers.map(([id]) => id).sort().join("|");
    if (rlgl.lastFinishers === setNow || rlgl.attempt >= RLGL_MAX_ATTEMPTS) {
      rlglFinish(finishers).catch((err) => console.error("RLGL finish failed:", err));
      return;
    }
    rlgl.lastFinishers = setNow;
    rlgl.wipes = 0;  // survivors in this round reset the wipe counter
    // Cut the field: everyone who didn't cross is OUT of the tournament.
    for (const [id, m] of [...rlgl.members]) if (!(m.alive && m.finished)) rlgl.members.delete(id);
    rlgl.attempt++;
    rlgl.state = "joining";   // limbo: red-light checks stop during the reset
    io.emit("rlglRound", {
      attempt: rlgl.attempt,
      remaining: finishers.map(([, m]) => ({ name: m.name, safe: m.safe || 0 })),
      safeNeeded: 2,
    });
    rlgl.replayTimer = setTimeout(rlglStartAttempt, 5_000);
    console.log(`RLGL: round survived by ${finishers.length} — next round (attempt ${rlgl.attempt})`);
    return;
  }
  // NOBODY survived → ONE mercy replay, and that's it (owner's rule, Aug 2026):
  // wipe the field twice and the game is OVER — nobody wins, no payout.
  rlgl.wipes = (rlgl.wipes || 0) + 1;
  if (rlgl.wipes >= 2) { rlglCancel("Two rounds and NOBODY crossed the line. The doll wins. Nobody gets the pot."); return; }
  if (rlgl.attempt >= RLGL_MAX_ATTEMPTS) { rlglCancel("Twenty rounds and NOBODY survived. The doll wins. No payout."); return; }
  rlgl.attempt++;
  rlgl.state = "joining";   // brief limbo so red-light checks stop during the reset
  io.emit("rlglReplay", { attempt: rlgl.attempt });
  rlgl.replayTimer = setTimeout(rlglStartAttempt, 4_000);
  console.log(`RLGL: nobody survived — replaying (attempt ${rlgl.attempt})`);
}

// SYNCHRONOUS state flip before any await — same double-settle discipline as
// endRound. Winner identities snapshotted before the payout SQL.
async function rlglFinish(finisherPairs) {
  if (!rlgl || rlgl.state === "ending") return;
  const g = rlgl;
  g.state = "ending";
  clearTimeout(g.joinTimer); clearTimeout(g.lightTimer); clearTimeout(g.attemptTimer); clearTimeout(g.replayTimer); clearTimeout(g.fakeTimer);
  const winners = finisherPairs.map(([id, m]) => ({ id, name: m.name, email: m.email || players[id]?.email || null }));
  const each = Math.floor(g.prize / winners.length);
  for (const w of winners) {
    try {
      if (w.email) {
        const { rows } = await pool.query(
          `UPDATE jpo_players SET coins = coins + $2, updated_at = now() WHERE email = $1 RETURNING coins`,
          [w.email, each],
        );
        const p = players[w.id];
        if (rows[0] && p && p.email === w.email) {
          p.coins = rows[0].coins;
          io.to(w.id).emit("coinUpdate", { coins: p.coins });
        }
      } else {
        const p = players[w.id];
        if (p) { p.coins += each; io.to(w.id).emit("coinUpdate", { coins: p.coins }); }
      }
    } catch (err) { console.error("RLGL payout failed:", err); }
  }
  io.emit("rlglEnd", { winners: winners.map((w) => w.name), each, prize: g.prize, attempt: g.attempt });
  if (rlgl === g) rlgl = null;
  console.log(`RLGL: over after attempt ${g.attempt} — ${winners.length} survivor(s) × ${each} coins`);
}

// Leave seam — hooked into the same places as roundHandleLeave (disconnect,
// kickPlayer, dropLiveByEmail, purge). No grace: a refresh mid-doll-game is
// an elimination-by-cowardice, which everyone agrees is funnier.
function rlglHandleLeave(id) {
  if (!rlgl || !rlgl.members.has(id)) return;
  if (rlgl.state === "ending") return;   // settlement stands
  const m = rlgl.members.get(id);
  // A FINISHER already crossed the line — a refresh/blip must not void their
  // prize. Keep the member row: the payout is keyed by email (same offline-
  // winner path as After Dark), so it pays even if they never reconnect.
  // (Replays only happen when there are ZERO finishers, so a kept finisher
  // can never be revived onto the field with a dead socket.)
  if (rlgl.state === "running" && m.finished && m.alive && m.email) return;
  rlgl.members.delete(id);
  if (rlgl.state === "joining") {
    if (rlgl.replayTimer) {
      // Between rounds: if exactly one contender remains, they win by
      // walkover; an empty field cancels the game.
      if (rlgl.members.size === 1) {
        clearTimeout(rlgl.replayTimer);
        rlgl.state = "running";   // rlglFinish's settlement guard expects a live game
        rlglFinish([...rlgl.members]).catch((err) => console.error("RLGL finish failed:", err));
      } else if (rlgl.members.size === 0) {
        rlglCancel("Everyone left the field.");
      }
      return;
    }
    io.emit("rlglLobby", { prize: rlgl.prize, count: rlgl.members.size, msLeft: Math.max(0, rlgl.joinEndsAt - Date.now()) });
    if (rlgl.members.size === 0) rlglCancel("Everyone left before the game began.");
    return;
  }
  io.emit("rlglOut", { id, name: m.name, cause: "left", byName: null, x: 0, y: 0 });
  rlglMaybeSlippery();
  rlglCheckAttemptEnd();
}


// ─── PET RACE ──────────────────────────────────────────────────────────────
let race = null;
const RACE_JOIN_MS   = 45_000;
const RACE_TICK_MS   = 150;
const RACE_HEAT_SIZE = 8;
const RACE_ADVANCE_N = 3;

function racePetSpeed(petId, stage) {
  // Speeds are intentionally tight — stages add a SMALL bonus so the race is
  // determined mostly by noise + special events, not by who has the highest stage.
  const s = (petId || '').replace(/^pet_/, '');
  // Base speed (stage 1): 2.0–2.3 band — everyone is competitive
  let base = 2.15;
  if (s.startsWith('turtle')) base = 1.6;
  else if (s.startsWith('bunny'))  base = 2.1;
  else if (s.startsWith('duck'))   base = 2.1;
  else if (s.startsWith('cat'))    base = 2.2;
  else if (s.startsWith('dog'))    base = 2.2;
  else if (s.startsWith('dragon')) base = 2.2;
  else if (s === 'phoenix')        base = 2.2;
  else if (s === 'unicorn')        base = 2.1;
  // Stage bonus: +0.25 per stage above 1 (was +0.7–1.5 before)
  const bonus = Math.max(0, stage - 1) * 0.25;
  return base + bonus;
}

function petStemForRace(petId, stage) {
  const base = (petId || '').replace(/^pet_/, '');
  if (stage >= 3) return base + '_s3';
  if (stage >= 2) return base + '_s2';
  return base;
}

function raceEntrantList() {
  return [...race.entrants.entries()].map(([id, e]) => ({
    id, name: e.name, petId: e.petId, petStage: e.petStage,
    stem: petStemForRace(e.petId, e.petStage),
  }));
}

function raceHeatEntrants(ids) {
  return ids.map(id => {
    const e = race.entrants.get(id);
    if (!e) return null;
    return { id, name: e.name, petId: e.petId, petStage: e.petStage, stem: petStemForRace(e.petId, e.petStage) };
  }).filter(Boolean);
}

// Emit only to the two duel participants (private challenge race),
// or to every connected client (public admin race).
// Returns an object with .emit() so callers don't need to know which mode.
function raceIO() {
  if (race?.duelIds) {
    const ids = race.duelIds;
    return { emit: (ev, data) => { for (const id of ids) io.to(id).emit(ev, data); } };
  }
  return io;
}

function raceCancel(reason) {
  if (!race) return;
  const g = race; race = null;
  clearTimeout(g.joinTimer); clearTimeout(g.countdownTimer); clearInterval(g.tickInterval);
  if (g.duelIds) { for (const id of g.duelIds) io.to(id).emit('raceCancelled', { reason }); }
  else io.emit('raceCancelled', { reason });
  console.log('Race: cancelled (' + reason + ')');
}

// Called from the disconnect handler (before players[id] is deleted) when one
// side of an active duel race bails out. Survivor is declared the winner and
// receives the full wager; leaver gets nothing and sees the forfeit screen.
async function raceDuelForfeit(leaverSocketId) {
  if (!race?.duelIds?.includes(leaverSocketId)) return;
  const g = race; race = null;   // claim race immediately — no double-settle
  clearTimeout(g.joinTimer); clearTimeout(g.countdownTimer); clearInterval(g.tickInterval);
  const survivorId  = g.duelIds.find(id => id !== leaverSocketId);
  const leaverName  = players[leaverSocketId]?.name || 'Opponent';
  console.log(`Race duel forfeit: ${leaverName} disconnected — ${players[survivorId]?.name || survivorId} wins by walkover`);
  if (g.duelWager > 0 && survivorId) {
    try {
      const transferred = await rpsSettle(survivorId, leaverSocketId, g.duelWager);
      if (transferred > 0) {
        const wp = players[survivorId], lp = players[leaverSocketId];
        if (wp) io.to(survivorId).emit('rpsResult', { game: 'race', outcome: 'win',  wager: g.duelWager, coinsDelta:  transferred, coins: wp.coins });
        if (lp) io.to(leaverSocketId).emit('rpsResult', { game: 'race', outcome: 'loss', wager: g.duelWager, coinsDelta: -transferred, coins: lp.coins });
      }
    } catch (err) { console.error('Race duel forfeit settle failed:', err); }
  }
  // Send results to both sides — leaver may be mid-disconnect but the event
  // is harmless if they're already gone; survivor sees the forfeit screen.
  const forfeitPayload = { results: [], totalPot: 0, forfeit: true, forfeitName: leaverName };
  for (const id of g.duelIds) io.to(id).emit('raceResult', forfeitPayload);
}

function raceBeginRace(ids) {
  race.positions      = new Map();
  race.finishOrder    = [];
  race.specialCooldowns = new Map();
  const now = Date.now();
  // Pre-stagger each pet's first special so they never all fire at once
  for (const id of ids) {
    race.positions.set(id, { pos: 0, vel: 0, finished: false, place: null });
    race.specialCooldowns.set(id, now + 2000 + Math.random() * 6000);
  }
  raceIO().emit('raceGo', { entrants: raceHeatEntrants(ids) });
  race.tickInterval = setInterval(raceTick, RACE_TICK_MS);
}

// Returns { boost (% position jump), label, type } for a pet's special move.
// type is used by the client to pick the right visual effect.
function raceSpecialEvent(petId) {
  const s = (petId || '').replace(/^pet_/, '');
  if (s.startsWith('dragon'))  return { boost: 4 + Math.random() * 5, label: '🔥 Fire Breath!', type: 'fire'      };
  if (s.startsWith('phoenix')) return { boost: 4 + Math.random() * 5, label: '🔥 Flame Burst!', type: 'fire'      };
  if (s.startsWith('unicorn')) return { boost: 3 + Math.random() * 5, label: '✨ Magic Dash!',  type: 'magic'     };
  if (s.startsWith('dog'))     return { boost: 6 + Math.random() * 7, label: '⚡ Teleport!',    type: 'teleport'  };
  if (s.startsWith('duck'))    return { boost: 3 + Math.random() * 5, label: '💨 Belly Flop!',  type: 'flop'      };
  if (s.startsWith('cat'))     return { boost: 3 + Math.random() * 6, label: '🐾 Ninja Pounce!',type: 'pounce'    };
  if (s.startsWith('bunny'))   return { boost: 4 + Math.random() * 5, label: '🌀 Super Hop!',   type: 'hop'       };
  return                              { boost: 3 + Math.random() * 4, label: '⭐ Power Up!',    type: 'power'     };
}

function raceTick() {
  if (!race || (race.state !== 'heat' && race.state !== 'final')) return;
  if (!race.specialCooldowns) race.specialCooldowns = new Map();
  const now = Date.now();
  const posData = {};
  const events  = [];
  for (const [id, p] of race.positions) {
    if (p.finished) { posData[id] = { pos: p.pos, finished: true, place: p.place }; continue; }
    const e       = race.entrants.get(id);
    const base    = e ? e.speed : 2.0;
    // Noise is wide so any pet can surge or stumble — keeps races chaotic
    const noise   = (Math.random() - 0.48) * 1.2;
    const burst   = Math.random() < 0.02  ?  0.8 + Math.random() * 1.0 : 0;
    const stumble = Math.random() < 0.015 ? -(0.5 + Math.random() * 0.8) : 0;
    p.vel = Math.max(0.2, base + noise + burst + stumble);
    p.pos = Math.min(100, p.pos + p.vel * (RACE_TICK_MS / 1000));
    // Special event: each pet has a cooldown; ~1 per 5-9 seconds
    const cd = race.specialCooldowns.get(id) || 0;
    if (now >= cd && Math.random() < 0.028 && p.pos < 95) {
      const ev = raceSpecialEvent(e ? e.petId : '');
      p.pos = Math.min(100, p.pos + ev.boost);
      race.specialCooldowns.set(id, now + 5000 + Math.random() * 4000);
      events.push({ id, label: ev.label, type: ev.type });
    }
    if (p.pos >= 100 && !p.finished) {
      p.finished = true;
      p.place    = race.finishOrder.length + 1;
      race.finishOrder.push(id);
    }
    posData[id] = { pos: p.pos, finished: p.finished, place: p.place };
  }
  raceIO().emit('racePositions', posData);
  for (const ev of events) raceIO().emit('raceEvent', ev);
  const isHeat  = race.state === 'heat';
  const advN    = Math.min(RACE_ADVANCE_N, race.positions.size);
  const allDone = isHeat
    ? race.finishOrder.length >= advN
    : race.finishOrder.length === race.positions.size;
  if (!allDone) return;
  clearInterval(race.tickInterval); race.tickInterval = null;
  const results = race.finishOrder.map((id, i) => {
    const e = race.entrants.get(id);
    return { id, name: e ? e.name : '?', place: i + 1, petId: e ? e.petId : '', petStage: e ? e.petStage : 1, stem: e ? petStemForRace(e.petId, e.petStage) : '' };
  });
  for (const [id, p] of race.positions) {
    if (!p.finished) {
      const e = race.entrants.get(id);
      results.push({ id, name: e ? e.name : '?', place: null, petId: e ? e.petId : '', petStage: e ? e.petStage : 1, stem: e ? petStemForRace(e.petId, e.petStage) : '' });
    }
  }
  raceIO().emit('raceHeatEnd', { heat: race.currentHeat + 1, totalHeats: race.heats.length, isFinal: !isHeat, results });
  if (isHeat) {
    const advance   = race.finishOrder.slice(0, advN);
    race.finalists  = [...(race.finalists || []), ...advance];
    race.currentHeat++;
    if (race.currentHeat < race.heats.length) setTimeout(raceBeginHeat, 5000);
    else setTimeout(raceBeginFinal, 5000);
  } else {
    setTimeout(raceDoFinish, 5000);
  }
}

function raceBeginHeat() {
  if (!race) return;
  const ids = race.heats[race.currentHeat];
  race.state = 'heat';
  raceIO().emit('raceHeatStart', {
    heat: race.currentHeat + 1, totalHeats: race.heats.length,
    entrants: raceHeatEntrants(ids), advanceN: RACE_ADVANCE_N,
  });
  race.countdownTimer = setTimeout(() => raceBeginRace(ids), 4000);
}

function raceBeginFinal() {
  if (!race) return;
  race.state = 'final';
  raceIO().emit('raceFinalStart', { entrants: raceHeatEntrants(race.finalists), totalHeats: race.heats.length });
  race.countdownTimer = setTimeout(() => raceBeginRace(race.finalists), 4000);
}

async function raceDoFinish() {
  if (!race) return;
  const g = race; race = null;
  const winnerId      = g.finishOrder[0];
  const totalPot      = [...g.bets.values()].reduce((s, b) => s + b.amount, 0);
  const winnerBets    = [...g.bets.entries()].filter(([, b]) => b.onId === winnerId);
  const winnerBetTot  = winnerBets.reduce((s, [, b]) => s + b.amount, 0);
  const payouts       = new Map();   // bettor sid → { amount, email }
  if (winnerBetTot > 0) {
    for (const [sid, b] of winnerBets)
      payouts.set(sid, { amount: Math.round(totalPot * b.amount / winnerBetTot),
                         email:  b.email || players[sid]?.email || null });
  }
  // Settle by EMAIL, not by live socket: a bettor who refreshed mid-race has a
  // new socket id (or none), but their coins must still land. Retry the whole
  // transaction a few times — production has transient DB connection blips,
  // and a single silent ROLLBACK used to eat every winner's payout.
  // Idempotency: each credit first claims a (settle_id, email) row in
  // jpo_race_settlements inside the SAME transaction. If a COMMIT succeeded
  // but its ack was lost (ambiguous outcome), the retry's INSERT conflicts and
  // the credit is skipped — retries can never double-pay.
  const settleId = globalThis.crypto.randomUUID();
  let betsSettled = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let cl;
    try {
      cl = await pool.connect();
      await cl.query('BEGIN');
      for (const [, pay] of payouts) {
        if (!pay.email) continue;   // guest/unknown bettor — nothing to credit
        const claim = await cl.query(
          'INSERT INTO jpo_race_settlements (settle_id, email, amount) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING 1',
          [settleId, pay.email, pay.amount]);
        if (!claim.rows[0]) continue;   // already paid by a previously-committed attempt
        await cl.query(
          'UPDATE jpo_players SET coins = coins + $2, updated_at = now() WHERE email = $1',
          [pay.email, pay.amount]);
      }
      await cl.query('COMMIT');
      betsSettled = true;
      break;
    } catch (err) {
      try { await cl?.query('ROLLBACK'); } catch {}
      console.error(`Race payout attempt ${attempt}/3 failed:`, err.message || err);
      if (attempt === 3) console.error('Race payout GAVE UP — winners not credited:',
        [...payouts.values()].map(p => `${p.email}:+${p.amount}`).join(' '));
      else await new Promise(r => setTimeout(r, 1500 * attempt));
    } finally { cl?.release(); }
  }
  // Only after a CONFIRMED commit: sync in-memory balances from the DB and
  // notify whichever socket each bettor is on now. Never before — a rollback
  // must not leave clients holding spendable coins that were never committed.
  if (betsSettled && payouts.size) {
    try {
      const emails = [...new Set([...payouts.values()].map(p => p.email).filter(Boolean))];
      const { rows } = await pool.query('SELECT email, coins FROM jpo_players WHERE email = ANY($1)', [emails]);
      for (const r of rows) {
        const liveSid = Object.keys(players).find(k => players[k].email === r.email);
        if (liveSid) { players[liveSid].coins = r.coins; io.to(liveSid).emit('coinUpdate', { coins: r.coins }); }
      }
    } catch (err) { console.error('Race payout balance sync failed:', err.message || err); }
  }
  // Duel wager settlement: winner takes coins from the loser.
  if (g.duelRoom && g.duelWager > 0 && winnerId) {
    const loserId = g.duelChallengerId === winnerId ? g.duelTargetId : g.duelChallengerId;
    try {
      const transferred = await rpsSettle(winnerId, loserId, g.duelWager);
      if (transferred > 0) {
        const wp = players[winnerId], lp = players[loserId];
        if (wp) io.to(winnerId).emit('rpsResult', { game: 'race', outcome: 'win',  wager: g.duelWager, coinsDelta:  transferred, coins: wp.coins });
        if (lp) io.to(loserId).emit('rpsResult',  { game: 'race', outcome: 'loss', wager: g.duelWager, coinsDelta: -transferred, coins: lp.coins });
      }
    } catch (err) { console.error('Race duel wager settle failed:', err); }
  }

  const results = g.finishOrder.map((id, i) => {
    const e = g.entrants.get(id);
    return { id, name: e?.name || '?', place: i + 1, petId: e?.petId || '', stem: e ? petStemForRace(e.petId, e.petStage) : '', payout: payouts.get(id)?.amount || 0 };
  });
  if (g.duelIds) { for (const id of g.duelIds) io.to(id).emit('raceResult', { results, totalPot }); }
  else io.emit('raceResult', { results, totalPot });
  if (betsSettled) {
    for (const [sid, pay] of payouts) {
      const liveSid = players[sid]?.email === pay.email ? sid
        : Object.keys(players).find(k => players[k].email === pay.email);
      if (liveSid) io.to(liveSid).emit('racePayout', { amount: pay.amount });
    }
  }
  console.log('Race: done. Winner: ' + winnerId + ', pot: ' + totalPot + ', payouts: ' + payouts.size);
}

// Post-move hook, called from playerMove AFTER a move passes anti-cheat.
// Red-light detection rides the validated pipeline: a modified client that
// skips sending moves also never moves server-side, so there is nothing to
// catch — the authoritative position simply stays put.
function rlglOnMove(id, prevX, prevY, x, y, now) {
  if (!rlgl || rlgl.state !== "running") return;
  const m = rlgl.members.get(id);
  if (!m || !m.alive || m.finished) return;
  const ph = rlglPhase();
  const b = rlglBoundsNow();
  // Pre-GO corral (owner rule): the free-move window before GO (~8s of
  // intro + countdown) is for spreading out ALONG the start line — not for
  // sneaking a head start. Cross the line early and the doll shoves you back.
  if (now - rlgl.beganAt < 8_000 && y > RLGL_START_Y + 90) {
    const p = players[id];
    if (p) {
      p.x = x; p.y = RLGL_START_Y;
      io.to(id).emit("rlglPushed", { id, x: p.x, y: p.y, byName: "The doll — wait for GO!" });
      io.emit("playerMoved", { id, ...p });
    }
    return;
  }
  // Runaways: leaving the lawn forfeits. In narrow phases the legal strip is
  // tighter than the lawn — stepping off the path is its own death (no slack:
  // the borders are drawn on everyone's screen).
  if (x < b.x0 - (ph.halfW ? 0 : 60) || x > b.x1 + (ph.halfW ? 0 : 60) ||
      y < RLGL_ARENA.y0 - 60 || y > RLGL_ARENA.y1 + 60) {
    rlglEliminate(id, ph.halfW && x >= RLGL_ARENA.x0 - 60 && x <= RLGL_ARENA.x1 + 60 ? "path" : "fled");
    return;
  }
  if (rlgl.light === "red" && now > rlgl.redAt + ph.grace) {
    const dx = x - prevX, dy = y - prevY;
    if (dx * dx + dy * dy > RLGL_MOVE_EPS_PX * RLGL_MOVE_EPS_PX) { rlglEliminate(id, "moved"); return; }
  }
  // Coin bait: grab everything in reach (validated position only).
  if (rlgl.coins) {
    for (let i = 0; i < rlgl.coins.length; i++) {
      const c = rlgl.coins[i];
      if (c.taken) continue;
      const cdx = x - c.x, cdy = y - c.y;
      if (cdx * cdx + cdy * cdy > RLGL_COIN_GRAB_PX * RLGL_COIN_GRAB_PX) continue;
      c.taken = true;
      io.emit("rlglCoin", { idx: i, byId: id, byName: m.name, value: RLGL_COIN_VALUE });
      const p = players[id];
      if (p) {
        if (p.email) {
          pool.query(`UPDATE jpo_players SET coins = coins + $2, updated_at = now() WHERE email = $1 RETURNING coins`,
            [p.email, RLGL_COIN_VALUE])
            .then(({ rows }) => {
              if (rows[0] && players[id] && players[id].email === p.email) {
                players[id].coins = rows[0].coins;
                io.to(id).emit("coinUpdate", { coins: rows[0].coins });
              }
            }).catch((err) => console.error("RLGL coin payout failed:", err));
        } else {
          p.coins += RLGL_COIN_VALUE;
          io.to(id).emit("coinUpdate", { coins: p.coins });
        }
      }
    }
  }
  if (y >= RLGL_FINISH_Y) {
    m.finished = true;
    io.emit("rlglFinished", { id, name: m.name });
    console.log(`RLGL: ${m.name} crossed the finish line`);
    rlglMaybeSlippery();
    rlglCheckAttemptEnd();
  }
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
  socket.emit("saleState", _saleState());

  // Per-connection rate-limit state — closed over by the handlers below and
  // GC'd with the socket on disconnect (no global map to clean up).
  const chatBucket  = makeBucket(5, 700);   // ~1.4 msgs/s sustained, burst of 5
  const chatImgBucket = makeBucket(2, 6000); // chat images are heavy — ~1 per 6s sustained, burst of 2
  const buyBucket   = makeBucket(3, 500);   // guards rapid buy-spam / double-clicks
  const postBucket  = makeBucket(3, 1000);  // guards announcement spam
  const emoteBucket = makeBucket(4, 900);   // ~1 emote/s sustained, burst of 4
  const rpsBucket   = makeBucket(3, 2000);  // guards challenge spam (~1 per 2s sustained)
  const petBattleBucket = makeBucket(4, 1500); // Pet Battle challenges/picks/build ops (~1 per 1.5s sustained)
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
    const isOwner = !!(OWNER_PASSWORD && password === OWNER_PASSWORD);
    if (!isOwner && (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD)) { socket.emit("adminAuthFail"); return; }
    if (isOwner) owners.add(socket.id);
    // Log the unlock only when we know WHO this socket is. A reconnecting
    // client silently re-sends adminAuth BEFORE its resume/register completes,
    // which produced useless "Unknown admin — Panel unlocked" spam. Real,
    // human F8 unlocks happen in-game, where the player identity exists.
    if (!admins.has(socket.id) && players[socket.id]) logAdmin(socket, "Panel unlocked", "Entered the owner password (F8).");
    admins.add(socket.id);
    socket.emit("adminAuthOk", { owner: owners.has(socket.id) });
    // Owner tier: deliver every price change he hasn't dismissed yet (made
    // while he was offline or in another session).
    if (isOwner) {
      pool.query(
        `SELECT id, item_id, old_price, new_price, changed_by, changed_at
           FROM jpo_price_alerts WHERE NOT seen ORDER BY id`,
      ).then(({ rows }) => {
        if (rows.length) socket.emit("ownerPriceAlertBacklog",
          rows.map(r => ({ id: r.id, item: r.item_id, oldPrice: r.old_price, newPrice: r.new_price, by: r.changed_by, at: r.changed_at })));
      }).catch((err) => console.error("price alert backlog failed:", err));
    }
    _pendingList().then(l => socket.emit("pendingList", l)).catch(err => console.error("adminAuth pending list failed:", err));
    socket.emit("playerList",  _playerList());
    // A refreshed host (silent re-auth) gets their bingo host controls back.
    if (bingo && bingo.state === "active") {
      socket.emit("adminBingoResult", { ok: true, mode: bingo.mode, active: true, message: `Bingo is live (${bingo.mode} calling).` });
    }
  });

  // ── Prop Hunt: start / join / guess / cancel ─────────────────────────
  socket.on("phStart", (payload) => {
    if (!admins.has(socket.id)) return;
    const p = players[socket.id];
    if (!p) return;
    if (!takeToken(roundBucket)) return;
    if (grandEventIsBlockingOfficeEvents()) { socket.emit("phResult", { ok: false, message: "Pet Wars Grand Event is open — finish or cancel it first." }); return; }
    if (propHunt) { socket.emit("phResult", { ok: false, message: "A Hide & Seek round is already running." }); return; }
    if (round)    { socket.emit("phResult", { ok: false, message: "Office After Dark is running — wait for it to finish." }); return; }
    if (deal)     { socket.emit("phResult", { ok: false, message: "Deal or No Deal is running — wait for the show to end." }); return; }
    if (rlgl)     { socket.emit("phResult", { ok: false, message: "Red Light Green Light is running — wait for the doll to finish." }); return; }
    const disguise = String(payload?.disguise || "");
    if (!PH_DISGUISES.has(disguise)) { socket.emit("phResult", { ok: false, message: "Pick a disguise first." }); return; }
    const hideSecs = Math.min(300,  Math.max(5,  Math.round(Number(payload?.hideSecs)) || 60));
    const huntSecs = Math.min(1800, Math.max(30, Math.round(Number(payload?.huntSecs)) || 300));
    propHunt = {
      state: "hiding", hiderId: socket.id, hiderName: p.name, disguise,
      gatherX: Math.round(p.x), gatherY: Math.round(p.y),
      seekers: new Set(), hideEndsAt: Date.now() + hideSecs * 1000, endsAt: 0,
      huntMs: huntSecs * 1000, huntTimer: null,
      hideTimer: setTimeout(phBeginHunt, hideSecs * 1000),
    };
    // Vanish BEFORE the invite so no client ever renders the hider mid-round.
    socket.broadcast.emit("phVanish", { id: socket.id });
    io.emit("phInvite", { hiderName: p.name, hideEndsAt: propHunt.hideEndsAt, hiderId: socket.id });
    socket.emit("phResult", { ok: true, message: `Hide & Seek is on — go hide! ${hideSecs}s until the hunt.` });
    logAdmin(socket, "Hide & Seek started", `${p.name} is hiding (${hideSecs}s hide, ${huntSecs}s hunt)`);
  });

  socket.on("phJoin", () => {
    // Joinable during the hunt too — that's how a refreshed seeker (new
    // socket id) gets back into the round, and latecomers get to play.
    if (!propHunt) return;
    const p = players[socket.id];
    if (!p || socket.id === propHunt.hiderId || propHunt.seekers.has(socket.id)) return;
    if (!takeToken(roundBucket)) return;
    propHunt.seekers.add(socket.id);
    // Teleport to the gathering base with a little scatter so joiners don't
    // stack into one pixel. Server position moves too, so the post-round
    // speed check baselines from the base, not the old desk.
    p.x = propHunt.gatherX + Math.round(Math.random() * 120 - 60);
    p.y = propHunt.gatherY + Math.round(Math.random() * 120 - 60);
    p.anim = "idle";
    socket.emit("phJoined", { x: p.x, y: p.y, hideEndsAt: propHunt.hideEndsAt, phase: propHunt.state, endsAt: propHunt.endsAt });
    socket.broadcast.emit("playerMoved", { id: socket.id, ...p });
  });

  // ── HQ-Buddy quiz ─────────────────────────────────────────────────────────
  // All three handlers are hider-of-truth on the server: questions are drawn
  // deterministically per pair per week, answers/score live in jpo_buddies,
  // and payouts go through the same atomic UPDATE pattern as everything else.
  socket.on("buddyQuizOpen", async () => {
    const p = players[socket.id];
    if (!p?.email || !p.buddyEmail || p.buddyEmail === BUDDY_NPC) return;
    try {
      const week = buddyWeek();
      const qs = buddyQuizQs(week, p.email, p.buddyEmail).map((i) => IB_PROMPTS[i]);
      socket.emit("buddyQuiz", { questions: qs });
    } catch (e) { console.error("buddy quiz open failed:", e); }
  });
  socket.on("buddyQuizAnswer", async ({ answers } = {}) => {
    const p = players[socket.id];
    if (!p?.email || !p.buddyEmail || p.buddyEmail === BUDDY_NPC) return;
    if (!Array.isArray(answers) || answers.length !== 3 || answers.some((v) => v !== 0 && v !== 1)) return;
    try {
      const week = buddyWeek();
      // Answers lock on first save — the quiz is a one-shot per week.
      const upd = await pool.query(
        `UPDATE jpo_buddies SET quiz_answers=$3 WHERE week=$1 AND email=$2 AND quiz_answers IS NULL`,
        [week, p.email, JSON.stringify(answers)]);
      if (!upd.rowCount) { socket.emit("buddyQuizMsg", { message: "You already answered this week." }); return; }
      socket.emit("buddyQuizMsg", { message: "Answers saved! Now guess your buddy's picks.", answered: true });
      // Unlock the buddy's waiting guess screen live.
      const sid = socketIdByEmail(p.buddyEmail);
      if (sid) sendBuddyInfo(sid).catch(() => {});
      sendBuddyInfo(socket.id).catch(() => {});
    } catch (e) { console.error("buddy quiz answer failed:", e); }
  });
  socket.on("buddyQuizGuess", async ({ guesses } = {}) => {
    const p = players[socket.id];
    if (!p?.email || !p.buddyEmail || p.buddyEmail === BUDDY_NPC) return;
    if (!Array.isArray(guesses) || guesses.length !== 3 || guesses.some((v) => v !== 0 && v !== 1)) return;
    // The "meet" part is real: guessing requires your buddy online and nearby.
    const sid = socketIdByEmail(p.buddyEmail);
    const b = sid ? players[sid] : null;
    if (!b) { socket.emit("buddyQuizMsg", { message: "Your buddy needs to be in the office to play this round." }); return; }
    const dx = p.x - b.x, dy = p.y - b.y;
    if (dx * dx + dy * dy > GROUP_RADIUS * GROUP_RADIUS) {
      socket.emit("buddyQuizMsg", { message: "Get closer to your buddy first — this is a together thing!" });
      return;
    }
    try {
      const week = buddyWeek();
      const { rows } = await pool.query(
        `SELECT quiz_answers, quiz_score FROM jpo_buddies WHERE week=$1 AND email=$2`, [week, p.email]);
      if (!rows[0] || rows[0].quiz_score !== null) { socket.emit("buddyQuizMsg", { message: "You already guessed this week." }); return; }
      const { rows: brows } = await pool.query(
        `SELECT quiz_answers FROM jpo_buddies WHERE week=$1 AND email=$2`, [week, p.buddyEmail]);
      const theirAnswers = brows[0]?.quiz_answers;
      if (!theirAnswers) { socket.emit("buddyQuizMsg", { message: "Your buddy hasn't answered their questions yet." }); return; }
      // Score lock inside the UPDATE guard — a double-submit race pays once.
      const score = guesses.reduce((n, g, i) => n + (g === theirAnswers[i] ? 1 : 0), 0);
      const lock = await pool.query(
        `UPDATE jpo_buddies SET quiz_score=$3 WHERE week=$1 AND email=$2 AND quiz_score IS NULL`,
        [week, p.email, score]);
      if (!lock.rowCount) return;
      const pay = score * BUDDY_QUIZ_PAY;
      if (pay > 0) {
        const { rows: crows } = await pool.query(
          `UPDATE jpo_players SET coins = coins + $2 WHERE email = $1 RETURNING coins`, [p.email, pay]);
        if (crows[0]) p.coins = crows[0].coins;
        socket.emit("coinUpdate", { coins: p.coins });
      }
      socket.emit("buddyQuizResult", { score, pay, theirAnswers });
      sendBuddyInfo(socket.id).catch(() => {});
    } catch (e) { console.error("buddy quiz guess failed:", e); }
  });

  // Hider changes their mind mid-hide (the prop everyone hunts is whatever
  // this holds when the hide timer fires). Locked once the hunt starts.
  socket.on("phSetDisguise", (payload) => {
    if (!propHunt || propHunt.state !== "hiding" || socket.id !== propHunt.hiderId) return;
    const d = payload && payload.disguise;
    if (typeof d === "string" && PH_DISGUISES.has(d)) propHunt.disguise = d;
  });

  socket.on("phGuess", () => {
    if (!propHunt || propHunt.state !== "hunting") return;
    if (!propHunt.seekers.has(socket.id)) return;
    if (!takeToken(interactBucket)) return;
    const p = players[socket.id], hp = players[propHunt.hiderId];
    if (!p || !hp) return;
    const dx = p.x - hp.x, dy = p.y - hp.y;
    if (dx * dx + dy * dy > PH_GUESS_RANGE_PX * PH_GUESS_RANGE_PX) return;
    logAdmin(socket, "Hide & Seek won", `${p.name} found ${propHunt.hiderName}`);
    phFinish(true, p.name);
  });

  socket.on("phCancel", () => {
    if (!admins.has(socket.id) || !propHunt) return;
    phFinish(false, null, "cancelled");
  });

  // ── Admin: live shop price control ───────────────────────────────────
  // Persists to jpo_shop_prices, updates the in-memory catalog (every buy
  // handler reads it), and broadcasts the new label to every open client.
  // Setting an item back to its shipped default deletes the override row.
  // ── Admin: flash sale — "X% off everything for N minutes" ────────────
  socket.on("adminSaleStart", async (payload) => {
    if (!admins.has(socket.id)) return;
    if (!owners.has(socket.id)) { socket.emit("adminSaleResult", { ok: false, message: "Flash sales need the owner key." }); return; }
    const pct = Math.round(Number(payload?.percent));
    const mins = Math.round(Number(payload?.minutes));
    if (!Number.isInteger(pct) || pct < SALE_PCT_MIN || pct > SALE_PCT_MAX) {
      socket.emit("adminSaleResult", { ok: false, message: `Percent must be ${SALE_PCT_MIN}–${SALE_PCT_MAX}.` }); return;
    }
    if (!Number.isInteger(mins) || mins < SALE_MIN_MINUTES || mins > SALE_MAX_MINUTES) {
      socket.emit("adminSaleResult", { ok: false, message: `Duration must be ${SALE_MIN_MINUTES}–${SALE_MAX_MINUTES} minutes.` }); return;
    }
    const endsAt = Date.now() + mins * 60_000;
    try {
      await pool.query(
        `INSERT INTO jpo_flash_sale (id, percent, ends_at) VALUES (1, $1, $2)
         ON CONFLICT (id) DO UPDATE SET percent = $1, ends_at = $2`,
        [pct, new Date(endsAt)],
      );
    } catch (err) {
      console.error("adminSaleStart failed:", err);
      socket.emit("adminSaleResult", { ok: false, message: "Saving the sale failed — try again." });
      return;
    }
    _armSale(pct, endsAt);
    logAdmin(socket, "Flash sale", `${pct}% off everything for ${mins} minute${mins === 1 ? "" : "s"}`);
    io.emit("saleState", _saleState());
    io.emit("priceList", allPrices());
    socket.emit("adminSaleResult", { ok: true, message: `Sale is ON: ${pct}% off for ${mins} min.` });
    console.log(`ADMIN flash sale: ${pct}% off for ${mins} min`);
  });
  socket.on("adminSaleEnd", async () => {
    if (!admins.has(socket.id)) return;
    if (!owners.has(socket.id)) { socket.emit("adminSaleResult", { ok: false, message: "Flash sales need the owner key." }); return; }
    if (!saleActive()) { socket.emit("adminSaleResult", { ok: false, message: "No sale is running." }); return; }
    logAdmin(socket, "Flash sale", "Ended the sale early");
    await _endSale("ended by owner");
    socket.emit("adminSaleResult", { ok: true, message: "Sale ended — prices are back to normal." });
  });

  socket.on("adminSetPrice", async (payload) => {
    if (!admins.has(socket.id)) return;
    // Price overrides are OWNER-key only now (plain admins abused them).
    if (!owners.has(socket.id)) { socket.emit("adminPriceResult", { ok: false, message: "Price changes need the owner key." }); return; }
    const { item, price } = payload || {};
    if (typeof item !== "string") return;
    const cat = catalogOf(item);
    if (!cat) { socket.emit("adminPriceResult", { ok: false, message: "Unknown item." }); return; }
    // Rare pets have no price by design — an override could resurrect a
    // buyable price label (buyPet still blocks, but the shop would lie).
    if (RARE_IDS.has(item)) { socket.emit("adminPriceResult", { ok: false, message: "Rare items are gift-only — no price to set." }); return; }
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
      const oldPrice = cat[item];
      cat[item] = p;
      if (oldPrice !== p) {
        logAdmin(socket, "Price change", `${item}: ${Number(oldPrice).toLocaleString()} → ${p.toLocaleString()} coins${p === DEFAULT_PRICES[item] ? " (back to default)" : ""}`);
        // Owner alert: record every non-owner price change (owner's own changes
        // are stored pre-seen — he doesn't need an alarm about himself) and
        // blast it live, in red, to any logged-in owner session.
        const _pl = players[socket.id];
        const _who = _pl ? `${_pl.name}${_pl.email ? ` (${_pl.email})` : ""}` : "Unknown admin";
        const _byOwner = owners.has(socket.id);
        pool.query(
          `INSERT INTO jpo_price_alerts (item_id, old_price, new_price, changed_by, seen)
           VALUES ($1, $2, $3, $4, $5) RETURNING id, changed_at`,
          [item, Number.isFinite(Number(oldPrice)) ? Number(oldPrice) : null, p, _who.slice(0, 120), _byOwner],
        ).then(({ rows }) => {
          if (_byOwner) return;
          const alert = { id: rows[0].id, item, oldPrice: Number(oldPrice), newPrice: p, by: _who, at: rows[0].changed_at };
          for (const sid of owners) io.to(sid).emit("ownerPriceAlert", alert);
        }).catch((err) => console.error("price alert write failed:", err));
      }
      io.emit("priceUpdate", { item, price: p });   // base price — clients apply the sale % locally
      socket.emit("adminPriceResult", { ok: true, message: `${item} is now ${p.toLocaleString()} coins${p === DEFAULT_PRICES[item] ? " (default)" : ""}.` });
      console.log(`ADMIN price change: ${item} → ${p}`);
    } catch (err) {
      console.error("adminSetPrice failed:", err);
      socket.emit("adminPriceResult", { ok: false, message: "Saving the price failed — try again." });
    }
  });

  // Owner dismissed the red price alerts — mark them seen so they stop
  // reappearing on every login. Owner tier only.
  socket.on("ownerPriceAlertsSeen", (ids) => {
    if (!owners.has(socket.id)) return;
    if (!Array.isArray(ids)) return;
    const clean = ids.filter(Number.isInteger).slice(0, 500);
    if (!clean.length) return;
    pool.query(`UPDATE jpo_price_alerts SET seen = true WHERE id = ANY($1)`, [clean])
      .catch((err) => console.error("price alerts seen failed:", err));
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
      logAdmin(socket, "Banner cleared", "");
      console.log("ADMIN banner cleared");
      return;
    }
    adminBanner = { id: ++bannerSeq, text, ts: Date.now() };
    io.emit("bannerUpdate", { banner: adminBanner });
    socket.emit("adminPriceResult", { ok: true, message: "Banner is up on every screen." });
    logAdmin(socket, "Banner posted", `"${text}"`);
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
      socket.emit("bingoCard", { gameId: bingo.id, card: bp.card, daubs: [...bp.daubs], called: bingo.called, prize: bingo.prize, state: bingo.state, mode: bingo.mode, rule: bingo.rule, msLeft: bingo.state === "joining" ? Math.max(0, bingo.joinDeadline - Date.now()) : 0 });
      if (admins.has(socket.id)) {
        socket.emit("adminBingoResult", { ok: true, mode: bingo.mode, active: true, phase: bingo.state, message: bingo.state === "active" ? `Bingo is live (${bingo.mode} calling).` : "Bingo lobby is open — game starts soon." });
      }
    } else if (bingo && bingo.state === "joining") {
      socket.emit("bingoLobby", { gameId: bingo.id, prize: bingo.prize, rule: bingo.rule, msLeft: Math.max(0, bingo.joinDeadline - Date.now()) });
    }
    // Refresh/reconnect keeps the "who's playing" list current for everyone.
    if (bingo) socket.emit("bingoNames", { gameId: bingo.id, names: [...bingo.players.values()].map((v) => v.name) });
    // No game running? Say so explicitly. A server restart mid-game (e.g. a
    // Republish) means bingoOver was never sent — reconnecting clients would
    // otherwise keep a dead card on screen forever. An empty bingoOver clears
    // the UI without any banner/toast.
    if (!bingo) socket.emit("bingoOver", {});
    // Deal or No Deal resync — same idea: rebuild or clear the show UI.
    if (deal) {
      const snap = dealSnap();
      if (em && deal.players.has(em)) socket.emit("dealYouIn", snap);
      else if (deal.state === "joining") socket.emit("dealLobby", { gameId: deal.id, jackpot: deal.jackpot, msLeft: snap.msLeft });
      socket.emit("dealNames", { gameId: deal.id, names: snap.names });
      if (owners.has(socket.id)) socket.emit("ownerDealResult", { ok: true, active: true, message: deal.state === "joining" ? "Show lobby is open." : "The show is live — you're the Banker." });
    } else {
      socket.emit("dealOver", {});
    }
    // Red Light Green Light resync: rebuild the doll/arena for reconnecting
    // spectators, or clear a dead overlay after a server restart mid-game.
    if (rlgl) {
      if (rlgl.state === "joining" && !rlgl.replayTimer) {
        socket.emit("rlglLobby", { prize: rlgl.prize, count: rlgl.members.size, msLeft: Math.max(0, rlgl.joinEndsAt - Date.now()) });
      } else if (rlgl.state === "running") {
        socket.emit("rlglBegin", {
          attempt: rlgl.attempt, prize: rlgl.prize, endsAt: rlgl.endsAt,
          phase: { n: Math.min(rlgl.attempt, RLGL_PHASES.length), name: rlglPhase().name },
          arena: RLGL_ARENA, bounds: rlglBoundsNow(), startY: RLGL_START_Y, finishY: RLGL_FINISH_Y, doll: RLGL_DOLL,
          players: rlglRoster(), light: rlgl.light, spectator: true, slippery: rlgl.slippery,
          coins: (rlgl.coins || []).map((c, i) => ({ idx: i, x: c.x, y: c.y, taken: c.taken })).filter((c) => !c.taken), coinValue: RLGL_COIN_VALUE,
          pushRangePx: RLGL_PUSH_RANGE_PX, pushCooldownMs: RLGL_PUSH_COOLDOWN_MS,
        });
        if (rlgl.slippery) socket.emit("rlglSlippery", { on: true });
      }
    } else {
      socket.emit("rlglOver", {});
    }
    grandEventSyncToSocket(socket.id);
  });

  // ── Pet Wars Grand Event ──────────────────────────────────────────────
  socket.on("grandEventCreate", (payload) => {
    if (!admins.has(socket.id)) return;
    grandEventQueue(async () => {
      if (grandEventIsBlockingOfficeEvents()) throw new Error("A Grand Event is already open.");
      if (bingo || race || deal || rlgl || round || propHunt)
        throw new Error("Another office event is running — wait for it to finish.");
      const entryFeeRaw = payload?.entryFee == null ? GE_DEFAULT_ENTRY : Math.round(Number(payload.entryFee));
      if (!Number.isSafeInteger(entryFeeRaw) || entryFeeRaw < 1 || entryFeeRaw > 10_000)
        throw new Error("Entry fee must be 1–10,000 coins.");
      const readReward = (key, fallback) => {
        const n = payload?.rewards?.[key] == null ? fallback : Math.round(Number(payload.rewards[key]));
        if (!Number.isSafeInteger(n) || n < 0 || n > GE_MAX_COINS)
          throw new Error("Each round reward must be 0–100,000 coins.");
        return n;
      };
      let joinMs = GE_JOIN_MS;
      if (payload?.joinSeconds != null) {
        const sec = Math.round(Number(payload.joinSeconds));
        if (!Number.isSafeInteger(sec) || sec < 30 || sec > 600)
          throw new Error("Registration must stay open for 30–600 seconds.");
        joinMs = sec * 1000;
      }
      const prizeLabel = String(payload?.prizeLabel || "Pet Wars Champion").trim().slice(0, 60);
      const prizeDetails = String(payload?.prizeDetails || "").trim().slice(0, 180);
      if (!prizeLabel) throw new Error("Add a champion prize label.");
      const config = {
        entryFee: entryFeeRaw,
        rewards: {
          opening: readReward("opening", 50),
          quarterfinal: readReward("quarterfinal", 100),
          semifinal: readReward("semifinal", 200),
          final: readReward("final", 500),
        },
        prizeLabel,
        prizeDetails,
        joinMs,
      };
      const p = players[socket.id];
      await grandEventCreate(config, p?.email || p?.name || "admin");
      logAdmin(socket, "Grand Event opened",
        `${entryFeeRaw} entry; rewards ${Object.values(config.rewards).join("/")}; prize ${prizeLabel}`);
      socket.emit("grandEventAdminResult", {
        ok: true,
        message: `Grand Event registration is open for ${Math.round(joinMs / 1000)}s. Entry: ${entryFeeRaw.toLocaleString()} coins.`,
      });
    }).catch((err) => socket.emit("grandEventAdminResult", { ok: false, message: err.message || "Couldn't open the event." }));
  });

  socket.on("grandEventStart", () => {
    if (!admins.has(socket.id)) return;
    grandEventQueue(async () => {
      await grandEventStartBracket();
      logAdmin(socket, "Grand Event bracket started", `${grandEvent.entrants.size} players`);
      socket.emit("grandEventAdminResult", { ok: true, message: "Bracket locked. The opening matchup has been called." });
    }).catch((err) => socket.emit("grandEventAdminResult", { ok: false, message: err.message || "Couldn't start the bracket." }));
  });

  socket.on("grandEventCancel", () => {
    if (!admins.has(socket.id)) return;
    grandEventQueue(async () => {
      if (!grandEvent || grandEvent.state !== "registration")
        throw new Error("Only an open registration lobby can be cancelled.");
      await grandEventCancelRegistration("The organizer cancelled the Grand Event. Every entry fee was refunded.");
      logAdmin(socket, "Grand Event cancelled", "All entry fees refunded");
      socket.emit("grandEventAdminResult", { ok: true, message: "Grand Event cancelled. Every entry was refunded exactly once." });
    }).catch((err) => socket.emit("grandEventAdminResult", { ok: false, message: err.message || "Couldn't cancel the event." }));
  });

  socket.on("grandEventJoin", () => {
    if (!takeToken(interactBucket)) return;
    grandEventQueue(() => grandEventJoin(socket.id))
      .then(() => socket.emit("grandEventActionResult", { ok: true, message: "You're in the Grand Event!" }))
      .catch((err) => socket.emit("grandEventActionResult", { ok: false, message: err.message || "Couldn't join." }));
  });

  socket.on("grandEventWithdraw", () => {
    if (!takeToken(interactBucket)) return;
    grandEventQueue(() => grandEventWithdraw(socket.id))
      .then(() => socket.emit("grandEventActionResult", { ok: true, message: "You withdrew. Your entry fee was refunded." }))
      .catch((err) => socket.emit("grandEventActionResult", { ok: false, message: err.message || "Couldn't withdraw." }));
  });

  socket.on("grandEventReady", () => {
    if (!takeToken(interactBucket)) return;
    grandEventQueue(() => grandEventReady(socket.id))
      .catch((err) => socket.emit("grandEventActionResult", { ok: false, message: err.message || "Couldn't ready up." }));
  });

  socket.on("grandEventViewMode", (payload) => {
    if (!takeToken(interactBucket)) return;
    const mode = String(payload?.mode || "");
    grandEventQueue(() => grandEventSetViewMode(socket.id, mode))
      .then(() => socket.emit("grandEventActionResult", {
        ok: true,
        message: mode === "spectate"
          ? "Live spectating is on. The next Pet Battle will open automatically."
          : "You left Pet Wars. Your locked entry and result are unchanged.",
      }))
      .catch((err) => socket.emit("grandEventActionResult", {
        ok: false,
        message: err.message || "Couldn't update your Pet Wars view.",
      }));
  });

  socket.on("grandEventSync", () => grandEventSyncToSocket(socket.id));

  // ── Admin: Red Light, Green Light ─────────────────────────────────────
  socket.on("adminRlglStart", (payload) => {
    if (!admins.has(socket.id)) return;
    if (rlgl)     { socket.emit("adminRlglResult", { ok: false, message: "A doll game is already running." }); return; }
    if (grandEventIsBlockingOfficeEvents()) { socket.emit("adminRlglResult", { ok: false, message: "The Pet Wars Grand Event is running." }); return; }
    if (bingo)    { socket.emit("adminRlglResult", { ok: false, message: "Bingo is running — wait for it to finish." }); return; }
    if (round)    { socket.emit("adminRlglResult", { ok: false, message: "Office After Dark is running — wait for the round to end." }); return; }
    if (propHunt) { socket.emit("adminRlglResult", { ok: false, message: "Hide & Seek is running — end it first." }); return; }
    if (deal)     { socket.emit("adminRlglResult", { ok: false, message: "Deal or No Deal is running — wait for the show to end." }); return; }
    // Plain admins can run games, but the pot is FIXED at 500 coins —
    // only the owner key gets to pick prize amounts.
    const prize = owners.has(socket.id) ? Math.round(Number(payload?.prize)) : 500;
    if (!Number.isSafeInteger(prize) || prize < RLGL_PRIZE_MIN || prize > RLGL_PRIZE_MAX) {
      socket.emit("adminRlglResult", { ok: false, message: `Prize must be ${RLGL_PRIZE_MIN}–${RLGL_PRIZE_MAX.toLocaleString()} coins.` });
      return;
    }
    rlgl = {
      state: "joining", prize, starterName: players[socket.id]?.name || "an admin",
      attempt: 1, members: new Map(), light: "green", redAt: 0, slippery: false,
      joinEndsAt: Date.now() + RLGL_JOIN_MS,
      joinTimer: setTimeout(() => {
        if (!rlgl || rlgl.state !== "joining") return;
        for (const id of [...rlgl.members.keys()]) if (!players[id]) rlgl.members.delete(id);
        if (rlgl.members.size < RLGL_MIN_PLAYERS) { rlglCancel(`Not enough players — it takes at least ${RLGL_MIN_PLAYERS} to face the doll.`); return; }
        rlglStartAttempt();
      }, RLGL_JOIN_MS),
      lightTimer: null, attemptTimer: null, replayTimer: null, endsAt: 0,
    };
    io.emit("rlglLobby", { prize, count: 0, msLeft: RLGL_JOIN_MS });
    socket.emit("adminRlglResult", { ok: true, message: `Doll game announced — ${prize.toLocaleString()} coin pot, ${RLGL_JOIN_MS / 1000}s to join. Survivors split it.` });
    logAdmin(socket, "Red Light Green Light started", `Pot ${prize.toLocaleString()} coins`);
    console.log(`ADMIN RLGL start: pot ${prize}`);
  });
  socket.on("adminRlglCancel", () => {
    if (!admins.has(socket.id) || !rlgl) return;
    if (rlgl.state === "ending") return;
    rlglCancel("The office called the game off.");
    logAdmin(socket, "Red Light Green Light cancelled", "");
    socket.emit("adminRlglResult", { ok: true, message: "Doll game cancelled." });
  });


  // ─── PET RACE ──────────────────────────────────────────────────────────────
  socket.on('ownerStartRace', ({ prize }) => {
    if (!admins.has(socket.id)) return;
    if (race) { socket.emit('ownerMsg', 'A pet race is already running.'); return; }
    if (grandEventIsBlockingOfficeEvents()) { socket.emit('ownerMsg', 'The Pet Wars Grand Event is running.'); return; }
    const p = players[socket.id];
    if (!p) return;
    prize = Math.max(0, Math.min(100_000, Math.round(prize || 0)));
    if (!owners.has(socket.id)) prize = 500;   // plain admins: fixed 500-coin pot
    race = {
      state: 'lobby', prize, starterName: p.name,
      entrants: new Map(), heats: [], currentHeat: 0, finalists: [],
      bets: new Map(), positions: new Map(), finishOrder: [],
      tickInterval: null, countdownTimer: null,
      joinDeadline: Date.now() + RACE_JOIN_MS,
    };
    io.emit('raceLobby', { prize, joinDeadline: race.joinDeadline, entrants: [] });
    race.joinTimer = setTimeout(() => {
      if (!race || race.state !== 'lobby') return;
      if (race.entrants.size < 2) { raceCancel('Not enough pets joined — need at least 2. \uD83D\uDC3E'); return; }
      const all = [...race.entrants.keys()];
      for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [all[i], all[j]] = [all[j], all[i]];
      }
      if (all.length <= RACE_HEAT_SIZE) {
        race.finalists = all; race.heats = [];
        raceBeginFinal();
      } else {
        const heats = [];
        for (let i = 0; i < all.length; i += RACE_HEAT_SIZE) heats.push(all.slice(i, i + RACE_HEAT_SIZE));
        race.heats = heats;
        raceBeginHeat();
      }
    }, RACE_JOIN_MS);
    logAdmin(socket, 'Pet Race started', 'prize=' + prize);
    socket.emit('ownerMsg', '\uD83C\uDFC1 Race lobby is open for ' + (RACE_JOIN_MS/1000) + 's!');
    console.log('Race: lobby opened by ' + p.name + ', prize ' + prize);
  });

  socket.on('ownerRaceCancel', () => {
    if (!admins.has(socket.id)) return;
    raceCancel('Cancelled by admin.');
    logAdmin(socket, 'Pet Race cancelled', '');
  });

  socket.on('raceJoin', () => {
    if (!race || race.state !== 'lobby') return;
    // Duel races are private — only the two challenged players may join.
    if (race.duelIds && !race.duelIds.includes(socket.id)) return;
    const p = players[socket.id];
    if (!p?.pet) { socket.emit('raceJoinErr', 'You need a pet equipped to race! \uD83D\uDC3E'); return; }
    if (race.entrants.has(socket.id)) return;
    if (!takeToken(interactBucket)) return;
    const stage = petStageFor(p);
    race.entrants.set(socket.id, { name: p.name, petId: p.pet, petStage: stage, speed: racePetSpeed(p.pet, stage) });
    raceIO().emit('raceEntrantUpdate', { entrants: raceEntrantList() });
    socket.emit('raceJoinOk', {});
    console.log('Race join: ' + p.name + ' with ' + p.pet + ' s' + stage);
  });

  socket.on('raceBet', ({ onId, amount }) => {
    if (!race || race.state !== 'lobby') return;
    // Duel races are private — only the two players can bet.
    if (race.duelIds && !race.duelIds.includes(socket.id)) return;
    const p = players[socket.id];
    if (!p?.email) return;
    if (!takeToken(interactBucket)) return;
    if (!race.entrants.has(onId)) { socket.emit('raceBetErr', 'That pet is not in the race.'); return; }
    amount = Math.max(50, Math.min(p.coins, Math.round(amount || 0)));
    if (p.coins < amount || amount < 50) { socket.emit('raceBetErr', 'Not enough coins (min 50).'); return; }
    const prev = race.bets.get(socket.id);
    if (prev) p.coins += prev.amount;
    p.coins -= amount;
    // Store the bettor's email too: a refresh/disconnect mid-race kills the
    // socket id, and a payout keyed only by socket id would silently vanish.
    race.bets.set(socket.id, { onId, amount, email: p.email });
    pool.query('UPDATE jpo_players SET coins=$1 WHERE email=$2', [p.coins, p.email]).catch(console.error);
    socket.emit('raceBetAck', { onId, amount, coins: p.coins });
    socket.emit('coinUpdate', { coins: p.coins });
    const pot = [...race.bets.values()].reduce((s, b) => s + b.amount, 0);
    raceIO().emit('racePotUpdate', { pot });
  });

  socket.on("rlglJoin", () => {
    const p = players[socket.id];
    if (!p || !rlgl || rlgl.state !== "joining" || rlgl.replayTimer) return;
    if (!takeToken(interactBucket)) return;
    if (rlgl.members.has(socket.id)) return;
    // One live socket per email in the game (mirror of bingo's email keying).
    if (p.email) for (const m of rlgl.members.values()) if (m.email === p.email) return;
    rlgl.members.set(socket.id, { name: p.name, email: p.email || null, alive: true, finished: false, lastPushAt: 0 });
    rlglPlaceAtStart(socket.id, rlgl.members.size - 1);
    io.emit("rlglLobby", { prize: rlgl.prize, count: rlgl.members.size, msLeft: Math.max(0, rlgl.joinEndsAt - Date.now()) });
    socket.emit("rlglYouIn", {});
    console.log(`RLGL join: ${p.name} (${rlgl.members.size} in)`);
  });

  // The shove. Alive runner shoves another alive runner within range: victim
  // is displaced server-side (authoritative — anti-cheat unaffected), gets a
  // red flash client-side, and if the doll is watching… that's on the pusher's
  // conscience. Publicly credited, cooldown-gated.
  socket.on("rlglPush", (payload) => {
    if (!rlgl || rlgl.state !== "running") return;
    const me = rlgl.members.get(socket.id);
    const p = players[socket.id];
    if (!me || !p || !me.alive || me.finished) return;
    const now = Date.now();
    if (rlgl.beganAt && now - rlgl.beganAt < RLGL_PUSH_ARM_MS) return;   // shoving not armed yet this round
    if (now - me.lastPushAt < RLGL_PUSH_COOLDOWN_MS) return;
    const targetId = payload?.targetId;
    if (typeof targetId !== "string" || targetId === socket.id) return;
    const tm = rlgl.members.get(targetId);
    const tp = players[targetId];
    if (!tm || !tp || !tm.alive || tm.finished) return;
    const dx = tp.x - p.x, dy = tp.y - p.y;
    if (dx * dx + dy * dy > RLGL_PUSH_RANGE_PX * RLGL_PUSH_RANGE_PX) return;
    me.lastPushAt = now;
    // Shove direction: away from the pusher (normalized), clamped to the
    // legal strip — a shove can't throw the victim off the path (their own
    // panic-run after the shove does that just fine).
    const b = rlglBoundsNow();
    const d = Math.max(Math.hypot(dx, dy), 1);
    tp.x = Math.min(b.x1 - 15, Math.max(b.x0 + 15, tp.x + (dx / d) * RLGL_PUSH_DIST_PX));
    tp.y = Math.min(RLGL_ARENA.y1 - 20, Math.max(RLGL_ARENA.y0 + 20, tp.y + (dy / d) * RLGL_PUSH_DIST_PX));
    tp.x = Math.round(tp.x); tp.y = Math.round(tp.y);
    io.emit("playerMoved", { id: targetId, ...tp });
    io.emit("rlglPushed", { id: targetId, name: tm.name, byId: socket.id, byName: me.name, x: tp.x, y: tp.y });
    console.log(`RLGL: ${me.name} pushed ${tm.name}`);
    // Pushed while the doll is watching → the VICTIM moved. Squid Game rules.
    if (rlgl.light === "red" && now > rlgl.redAt + rlglPhase().grace) {
      rlglEliminate(targetId, "pushed", me.name);
      return;
    }
    // Pushed across the finish line during green → congratulations, I guess.
    if (tp.y >= RLGL_FINISH_Y) {
      tm.finished = true;
      io.emit("rlglFinished", { id: targetId, name: tm.name });
      rlglMaybeSlippery();
      rlglCheckAttemptEnd();
    }
  });

  // ── Admin: Office Bingo ───────────────────────────────────────────────
  socket.on("adminBingoStart", (payload) => {
    if (!admins.has(socket.id)) return;
    if (bingo) { socket.emit("adminBingoResult", { ok: false, message: "A bingo game is already running." }); return; }
    if (grandEventIsBlockingOfficeEvents()) { socket.emit("adminBingoResult", { ok: false, message: "The Pet Wars Grand Event is running." }); return; }
    if (round) { socket.emit("adminBingoResult", { ok: false, message: "Office After Dark is running — wait for the round to end." }); return; }
    if (propHunt) { socket.emit("adminBingoResult", { ok: false, message: "Hide & Seek is running — end it first." }); return; }
    if (deal) { socket.emit("adminBingoResult", { ok: false, message: "Deal or No Deal is running — wait for the show to end." }); return; }
    if (rlgl) { socket.emit("adminBingoResult", { ok: false, message: "Red Light Green Light is running — wait for the doll to finish." }); return; }
    // Plain admins: prize is FIXED at 500 coins (owner key picks amounts).
    const prize = owners.has(socket.id) ? Math.round(Number(payload?.prize)) : 500;
    if (!Number.isSafeInteger(prize) || prize < BINGO_PRIZE_MIN || prize > BINGO_PRIZE_MAX) {
      socket.emit("adminBingoResult", { ok: false, message: `Prize must be ${BINGO_PRIZE_MIN}–${BINGO_PRIZE_MAX.toLocaleString()} coins.` });
      return;
    }
    const mode = payload?.mode === "manual" ? "manual" : "auto";
    // Host-picked auto-call pace (seconds between balls) and win rule.
    // Only clamp when the host actually picked a pace — otherwise keep the
    // env-configurable default (tests run with a very fast BINGO_CALL_MS).
    const pickedSecs = Math.round(Number(payload?.callSecs));
    const callMs = Number.isFinite(pickedSecs) && pickedSecs > 0
      ? Math.min(20, Math.max(2, pickedSecs)) * 1000
      : BINGO_CALL_MS;
    const rule = payload?.rule === "blackout" ? "blackout" : "line";
    const pool = Array.from({ length: 75 }, (_, i) => i + 1);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    bingo = {
      id: ++bingoGameSeq, state: "joining", mode, prize, players: new Map(), pool, called: [],
      callMs, rule,
      joinDeadline: Date.now() + BINGO_JOIN_MS,
      joinTimer: setTimeout(bingoBegin, BINGO_JOIN_MS), callTimer: null,
    };
    io.emit("bingoLobby", { gameId: bingo.id, prize, rule, msLeft: BINGO_JOIN_MS });
    socket.emit("adminBingoResult", { ok: true, mode, active: true, phase: "joining", message: `Bingo announced (${mode === "manual" ? "YOU call the numbers" : `auto-calling every ${callMs / 1000}s`}, ${rule === "blackout" ? "BLACKOUT — full card wins" : "any line wins"}) — ${prize.toLocaleString()} coin prize, ${BINGO_JOIN_MS / 1000}s to join.` });
    logAdmin(socket, "Bingo started", `Prize ${prize.toLocaleString()} coins, ${mode === "auto" ? `auto every ${callMs / 1000}s` : "manual calling"}, ${rule}`);
    console.log(`ADMIN bingo start: prize ${prize}, ${mode}, ${rule}, ${callMs}ms`);
  });
  socket.on("adminBingoCancel", () => {
    if (!admins.has(socket.id) || !bingo) return;
    const gameId = bingo.id;
    bingoStop();
    io.emit("bingoOver", { gameId, winnerName: null, message: "Bingo was cancelled by the office." });
    logAdmin(socket, "Bingo cancelled", "");
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
    logAdmin(socket, "Bingo mode switched", mode === "auto" ? "Auto-calling" : "Manual calling");
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
    socket.emit("bingoCard", { gameId: bingo.id, card, daubs: [], called: [], prize: bingo.prize, state: "joining", mode: bingo.mode, rule: bingo.rule, msLeft: Math.max(0, bingo.joinDeadline - Date.now()) });
    io.emit("bingoNames", { gameId: bingo.id, names: [...bingo.players.values()].map((v) => v.name) });
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
    const line = bingo.rule === "blackout" ? bingoHasBlackout(bp.card, bp.daubs) : bingoHasLine(bp.card, bp.daubs);
    if (!line) {
      socket.emit("bingoError", { message: bingo.rule === "blackout" ? "Not a blackout yet — the WHOLE card must be filled!" : "Not a bingo yet — keep daubing!" });
      return;
    }
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

  // ── Deal or No Deal (owner-hosted) ────────────────────────────────────
  socket.on("ownerDealStart", (payload) => {
    if (!owners.has(socket.id)) return;   // OWNER key only — plain admins can't host
    if (deal)     { socket.emit("ownerDealResult", { ok: false, message: "A show is already running." }); return; }
    if (grandEventIsBlockingOfficeEvents()) { socket.emit("ownerDealResult", { ok: false, message: "The Pet Wars Grand Event is running." }); return; }
    if (bingo)    { socket.emit("ownerDealResult", { ok: false, message: "Bingo is running — wait for it to finish." }); return; }
    if (round)    { socket.emit("ownerDealResult", { ok: false, message: "Office After Dark is running — wait for the round to end." }); return; }
    if (propHunt) { socket.emit("ownerDealResult", { ok: false, message: "Hide & Seek is running — end it first." }); return; }
    if (rlgl)     { socket.emit("ownerDealResult", { ok: false, message: "Red Light Green Light is running — wait for the doll to finish." }); return; }
    const jackpot = Math.round(Number(payload?.jackpot));
    if (!Number.isSafeInteger(jackpot) || jackpot < DEAL_JACKPOT_MIN || jackpot > DEAL_JACKPOT_MAX) {
      socket.emit("ownerDealResult", { ok: false, message: `Jackpot must be ${DEAL_JACKPOT_MIN}–${DEAL_JACKPOT_MAX.toLocaleString()} coins.` });
      return;
    }
    // Owner-tunable vote timer (F8 setting), clamped to something sane.
    let voteSec = Math.round(Number(payload?.voteSec));
    if (!Number.isFinite(voteSec)) voteSec = DEAL_VOTE_MS / 1000;
    voteSec = Math.min(60, Math.max(5, voteSec));
    const values = DEAL_FRACS.map((f) => Math.max(1, Math.round(jackpot * f)));
    for (let i = values.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [values[i], values[j]] = [values[j], values[i]]; }
    deal = {
      id: ++dealGameSeq, state: "joining", jackpot, round: 0, voteMs: voteSec * 1000,
      blockIdx: 0, blockLeft: 0, blockSize: 0, teamCase: null,
      cases: values.map((v) => ({ v, opened: false })),
      players: new Map(), votes: new Map(), dealVotes: new Map(), misses: new Map(), offer: 0,
      joinDeadline: Date.now() + DEAL_JOIN_MS,
      joinTimer: setTimeout(dealBegin, DEAL_JOIN_MS), phaseTimer: null, phaseDeadline: 0,
    };
    io.emit("dealLobby", { gameId: deal.id, jackpot, msLeft: DEAL_JOIN_MS });
    socket.emit("ownerDealResult", { ok: true, active: true, message: `Show announced! Top case holds ${jackpot.toLocaleString()} coins — ${DEAL_JOIN_MS / 1000}s to join. You're the Banker: drop offers whenever you smell fear.` });
    logAdmin(socket, "Deal or No Deal started", `Jackpot ${jackpot.toLocaleString()} coins`);
    console.log(`OWNER deal start: jackpot ${jackpot}`);
  });
  // The Banker speaks — only during the offer break between rounds, like the
  // real show. Puts the offer to an office DEAL / NO DEAL vote.
  socket.on("ownerDealOffer", (payload) => {
    if (!owners.has(socket.id)) return;
    if (!deal || deal.state !== "banker") {
      socket.emit("ownerDealResult", { ok: false, message: deal ? "The phone only rings between rounds — wait for the Banker break." : "No show running." });
      return;
    }
    const amount = Math.round(Number(payload?.amount));
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > DEAL_JACKPOT_MAX) {
      socket.emit("ownerDealResult", { ok: false, message: `Offer must be 1–${DEAL_JACKPOT_MAX.toLocaleString()} coins (total pot — they split it).` });
      return;
    }
    clearTimeout(deal.phaseTimer);
    deal.state = "offer";
    deal.offer = amount;
    deal.dealVotes = new Map();
    deal.phaseDeadline = Date.now() + DEAL_OFFER_MS;
    deal.phaseTimer = setTimeout(dealResolveOffer, DEAL_OFFER_MS);
    io.emit("dealPhase", dealSnap());
    socket.emit("ownerDealResult", { ok: true, active: true, message: `Offer on the table: ${amount.toLocaleString()} coins total (≈${Math.floor(amount / Math.max(1, deal.players.size)).toLocaleString()} each). The office is voting…` });
    logAdmin(socket, "Banker offer", `${amount.toLocaleString()} coins total pot`);
    console.log(`OWNER deal offer: ${amount}/player`);
  });
  // "No offer this round" — the show rolls straight into the next block.
  socket.on("ownerDealSkip", () => {
    if (!owners.has(socket.id)) return;
    if (!deal || deal.state !== "banker") return;
    clearTimeout(deal.phaseTimer);
    io.emit("dealNoDeal", { gameId: deal.id, yes: 0, no: 0, skipped: true });
    socket.emit("ownerDealResult", { ok: true, active: true, message: "No offer — next round!" });
    console.log("OWNER deal skip offer");
    dealVotePhase();
  });
  socket.on("ownerDealCancel", () => {
    if (!owners.has(socket.id) || !deal) return;
    const gameId = deal.id;
    dealStop();
    io.emit("dealOver", { gameId, message: "The Banker walked off the set — show cancelled, nobody gets paid. 📺" });
    logAdmin(socket, "Deal or No Deal cancelled", "");
    socket.emit("ownerDealResult", { ok: true, message: "Show cancelled." });
    console.log("OWNER deal cancelled");
  });
  socket.on("dealJoin", () => {
    const p = players[socket.id];
    if (!p?.email || !deal || deal.state !== "joining") return;
    if (!takeToken(interactBucket)) return;
    if (deal.players.has(p.email)) return;
    deal.players.set(p.email, { name: p.name });
    socket.emit("dealYouIn", dealSnap());
    io.emit("dealNames", { gameId: deal.id, names: [...deal.players.values()].map((v) => v.name) });
    console.log(`DEAL join: ${p.name} (${deal.players.size} in)`);
  });
  // One vote per player per round (revotable until the timer): which case opens.
  socket.on("dealVoteCase", (payload) => {
    const p = players[socket.id];
    const em = p?.email;
    if (!em || !deal || !deal.players.has(em)) return;
    if (deal.state !== "voting" && deal.state !== "pickcase") return;
    if (!takeToken(interactBucket)) return;
    const i = Math.round(Number(payload?.i));
    if (!Number.isInteger(i) || i < 0 || i >= deal.cases.length || deal.cases[i].opened) return;
    if (deal.state === "voting" && i === deal.teamCase) return;   // the team's case stays sealed
    if (deal.votes.get(em) === i) return;   // unchanged — no broadcast fuel for spammers
    deal.votes.set(em, i);
    // Live tallies keep the argument loud — counts only, never who voted what.
    const counts = deal.cases.map((c, idx) => (c.opened ? 0 : [...deal.votes.values()].filter((v) => v === idx).length));
    io.emit("dealTally", { gameId: deal.id, counts, voters: deal.votes.size, of: deal.players.size });
  });
  socket.on("dealVoteDeal", (payload) => {
    const p = players[socket.id];
    const em = p?.email;
    if (!em || !deal || deal.state !== "offer" || !deal.players.has(em)) return;
    if (!takeToken(interactBucket)) return;
    const yes = !!payload?.yes;
    if (deal.dealVotes.get(em) === yes) return;   // unchanged — drop silently
    deal.dealVotes.set(em, yes);
    const votes = [...deal.dealVotes.values()];
    io.emit("dealDealTally", { gameId: deal.id, yes: votes.filter(Boolean).length, no: votes.filter((v) => !v).length, of: deal.players.size });
  });

  // Pull-based refresh: the open admin panel re-requests both lists every few
  // seconds (and once on open), so a missed push — connection blip, zombie
  // socket, anything — can never leave the panel stale until a page refresh.
  // ── Owner-only: adjust a player's coin balance ────────────────────────
  // Gated on the OWNER_PASSWORD tier (not plain admins). By the owner's own
  // request this is NOT written to the activity log. Updates the DB row and,
  // if the person is online, the in-memory balance too (memory is what gets
  // saved back, so touching only the DB would be silently overwritten).
  socket.on("adminAdjustCoins", async (payload) => {
    if (!owners.has(socket.id)) return;
    const em = String(payload?.email || "").trim().toLowerCase().slice(0, 80);
    const delta = Math.round(Number(payload?.delta));
    if (!em || !Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 1000000) {
      socket.emit("adminCoinResult", { ok: false, message: "Enter an email and a non-zero amount up to ±1,000,000." });
      return;
    }
    try {
      const { rows } = await pool.query(
        `UPDATE jpo_players SET coins = GREATEST(0, coins + $2), updated_at = now()
          WHERE email = $1 RETURNING name, coins`,
        [em, delta],
      );
      if (!rows[0]) { socket.emit("adminCoinResult", { ok: false, message: "No account with that email." }); return; }
      for (const [sid, p] of Object.entries(players)) {
        if (p.email === em) { p.coins = rows[0].coins; io.to(sid).emit("coinUpdate", { coins: p.coins }); }
      }
      socket.emit("adminCoinResult", { ok: true, message: `${rows[0].name} now has ${Number(rows[0].coins).toLocaleString()} coins.` });
    } catch (err) {
      console.error("adminAdjustCoins failed:", err);
      socket.emit("adminCoinResult", { ok: false, message: "Something went wrong — try again." });
    }
  });

  // ── Owner-only: whisper log ───────────────────────────────────────────
  // Full whisper history (text + images), newest first. OWNER key only —
  // plain admins never see this, and there is deliberately no broadcast.
  socket.on("ownerWhisperLog", async (payload) => {
    if (!owners.has(socket.id)) return;
    const filter = String(payload?.email || "").trim().toLowerCase().slice(0, 80);
    try {
      const { rows } = await pool.query(
        filter
          ? `SELECT id, sent_at, from_email, from_name, to_email, to_name, message, img
               FROM jpo_whispers WHERE from_email = $1 OR to_email = $1 ORDER BY id DESC LIMIT 200`
          : `SELECT id, sent_at, from_email, from_name, to_email, to_name, message, img
               FROM jpo_whispers ORDER BY id DESC LIMIT 200`,
        filter ? [filter] : [],
      );
      socket.emit("ownerWhisperLog", { ok: true, rows });
    } catch (err) {
      console.error("ownerWhisperLog failed:", err);
      socket.emit("ownerWhisperLog", { ok: false, message: "Couldn't load the whisper log — try again." });
    }
  });

  // ── Owner-only: gift a rare pet (unicorn / phoenix) ───────────────────
  // Same OWNER_PASSWORD tier as coin adjustments — plain admins can't.
  // Email-based like adminAdjustCoins so the person doesn't have to be
  // online; if they ARE online, the pet pops out at their feet instantly.
  // Duplicate guard lives in the UPDATE's WHERE, matching buyPet's pattern.
  socket.on("ownerGrantPet", async (payload) => {
    if (!owners.has(socket.id)) return;
    const em = String(payload?.email || "").trim().toLowerCase().slice(0, 80);
    const pet = String(payload?.pet || "");
    if (!em || !RARE_IDS.has(pet)) {
      socket.emit("ownerGrantResult", { ok: false, message: "Pick a rare item and enter an email." });
      return;
    }
    // Pets auto-equip into equipped_pet; rare wings into equipped_wings;
    // other rare wearables into equipped_cosmetic.
    const isPet = RARE_PETS.has(pet);
    const grantCol = isPet ? "equipped_pet" : WINGS_IDS.has(pet) ? "equipped_wings" : "equipped_cosmetic";
    try {
      const { rows } = await pool.query(
        `UPDATE jpo_players
            SET cosmetics = array_append(cosmetics, $2),
                ${grantCol} = $2,
                updated_at = now()
          WHERE email = $1 AND NOT ($2 = ANY(cosmetics))
          RETURNING name, cosmetics, equipped_pet, equipped_cosmetic, equipped_wings`,
        [em, pet],
      );
      if (!rows[0]) {
        const { rows: chk } = await pool.query(`SELECT 1 FROM jpo_players WHERE email = $1`, [em]);
        socket.emit("ownerGrantResult", { ok: false, message: chk[0] ? "They already have that one!" : "No account with that email." });
        return;
      }
      // Online? Update the live player + broadcast so it appears instantly.
      for (const [sid, lp] of Object.entries(players)) {
        if (lp.email === em) {
          lp.cosmetics = rows[0].cosmetics || [];
          if (isPet) {
            lp.pet = rows[0].equipped_pet || "";
            io.to(sid).emit("petSuccess", { item: pet, pet: lp.pet, petAcc: lp.petAcc || "" });
            io.emit("playerPetUpdate", { id: sid, pet: lp.pet, petAcc: lp.petAcc || "", petStage: petStageFor(lp) });
          } else {
            lp.equipped = rows[0].equipped_cosmetic || "";
            lp.wings = rows[0].equipped_wings || "";
            io.to(sid).emit("shopSuccess", { item: pet, equipped: lp.equipped, wings: lp.wings, slots: lp.slots || emptySlots() });
            io.emit("playerCosmeticUpdate", { id: sid, cosmetics: lp.cosmetics, equipped: lp.equipped, wings: lp.wings, slots: lp.slots || emptySlots() });
          }
          io.to(sid).emit("rareGiftToast", { pet });
        }
      }
      const label = { pet_unicorn: "Unicorn 🦄", pet_phoenix: "Phoenix 🐦‍🔥", phoenixwings: "Phoenix Wings 🔥" }[pet] || pet;
      console.log(`Owner gifted rare ${pet} to ${em}`);
      socket.emit("ownerGrantResult", { ok: true, message: `Done! ${rows[0].name} now owns the ${label}.` });
    } catch (err) {
      console.error("ownerGrantPet failed:", err);
      socket.emit("ownerGrantResult", { ok: false, message: "Something went wrong — try again." });
    }
  });

  // ── Admin: activity log (paged, newest first) ─────────────────────────
  socket.on("adminLogGet", async (payload) => {
    if (!admins.has(socket.id)) return;
    const PER = 15;
    let page = Math.max(1, Math.floor(Number(payload?.page)) || 1);
    try {
      const total = Number((await pool.query(`SELECT count(*) AS c FROM jpo_admin_log`)).rows[0].c);
      const pages = Math.max(1, Math.ceil(total / PER));
      if (page > pages) page = pages;
      const { rows } = await pool.query(
        `SELECT admin_name, action, detail, ts FROM jpo_admin_log ORDER BY id DESC LIMIT $1 OFFSET $2`,
        [PER, (page - 1) * PER],
      );
      socket.emit("adminLogPage", { rows, page, pages, total });
    } catch (err) { console.error("adminLogGet failed:", err); }
  });

  // Registered directory (F8 → Registered): every approved account, online or
  // not, straight from the DB — plus a live "online" flag matched by email.
  socket.on("adminRegisteredList", async () => {
    if (!admins.has(socket.id)) return;
    try {
      const { rows } = await pool.query(
        `SELECT email, name, nickname, first_name, last_name, department, coins, created_at, updated_at
           FROM jpo_players
          WHERE approved = TRUE AND COALESCE(dismissed, FALSE) = FALSE
          ORDER BY LOWER(COALESCE(NULLIF(first_name,''), name))`);
      const onlineEmails = new Set(
        Object.values(players).map(p => (p.email || "").toLowerCase()).filter(Boolean));
      socket.emit("registeredList", rows.map(r => ({
        email:      r.email || "",
        name:       r.nickname || r.first_name || r.name,
        fullName:   [r.first_name, r.last_name].filter(Boolean).join(" ") || r.name,
        department: r.department || "",
        coins:      Number.isFinite(Number(r.coins)) ? Number(r.coins) : 0,
        registeredAt: r.created_at,
        lastActive:   r.updated_at || r.created_at,
        online:     onlineEmails.has((r.email || "").toLowerCase()),
      })));
    } catch (err) { console.error("adminRegisteredList failed:", err); }
  });

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
          coins: 50, cosmetics: [], equipped: "", wings: "", slots: emptySlots(), pet: "", petAcc: "", items: {}, isAnnouncer: false,
          department: reg.department || "", wins: {}, hobby: "", createdAt: Date.now(),
        };
        players[targetId] = state;
        io.to(targetId).emit("approved", {
          name: state.name, character: state.character,
          hairIdx: state.hairIdx, skinIdx: state.skinIdx, shirtIdx: state.shirtIdx, pantsIdx: state.pantsIdx,
          coins: state.coins, cosmetics: state.cosmetics, equipped: state.equipped, wings: state.wings || "", slots: state.slots || emptySlots(), pet: state.pet, petAcc: state.petAcc, items: state.items,
        });
        io.to(targetId).emit("currentPlayers", phMaskedPlayers(targetId));
        io.to(targetId).emit("announcerStatus", { canPost: false });
        io.to(targetId).emit("announcements", await fetchAnnouncements());
        for (const pid in players) {
          if (pid !== targetId) io.to(pid).emit("playerJoined", { id: targetId, ...state });
        }
        _notifyAdmins();
        logAdmin(socket, "Registration approved", `${reg.name} (session-only)`);
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
      logAdmin(socket, "Registration approved", `${row.name}${row.email ? ` (${row.email})` : ""}`);
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
    logAdmin(socket, "Registration rejected", `${reg?.name || em || "unknown"}${em ? ` (${em})` : ""}`);
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
    petBattleForfeitForLeave(targetId);   // active pet battle → forfeit
    
    roundHandleLeave(targetId);
    rlglHandleLeave(targetId);
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
    logAdmin(socket, "Player kicked", `${p.name}${p.email ? ` (${p.email})` : ""} — approval revoked`);
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
      logAdmin(socket, canPost ? "Announcer granted" : "Announcer revoked", `${p.name}${p.email ? ` (${p.email})` : ""}`);
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
      logAdmin(socket, "Password reset", `${rows[0].name} (${em})`);
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

    // Prop Hunt freeze: seekers hold at the gathering base while the boss
    // hides; the hider is furniture (immobile) once the hunt begins. Dropped
    // server-side so a modified client can't wander early.
    if (phFrozen(socket.id)) return;
    // RLGL: eliminated runners lie where they fell until the attempt ends.
    if (rlglFrozen(socket.id)) return;

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
      // RLGL runners never get the boosted budget — "any speed" is banned on
      // the field (owner's rule), so even a boost that slipped through renders
      // no server-side speed allowance.
      const boosted = me.boostUntil && now < me.boostUntil + BOOST_GRACE_MS && !rlglActiveRunner(socket.id);
      let mult = boosted ? COFFEE_MULT : 1;
      if (round && round.state === "active") {
        const rm = round.members.get(socket.id);
        if (rm && rm.alive) {
          mult = round.killerIds.has(socket.id) ? Math.max(ROUND_KILLER_SPEED_MULT, mult) : 1;
        }
      }
      // Prop Hunt: the hider sneaks at double speed during the hide phase
      // (owner request — client mirrors this; the hider's position is never
      // broadcast mid-round anyway, so nobody sees the zoom).
      if (propHunt && propHunt.state === "hiding" && propHunt.hiderId === socket.id) mult = Math.max(mult, 2);
      const speed = MOVE_SPEED * mult;
      const maxDist = speed * elapsed * MOVE_SPEED_TOLERANCE + MOVE_JITTER_PX + snapBonus;
      const dx = x - me.x, dy = y - me.y;
      if (dx * dx + dy * dy > maxDist * maxDist) { if (LT_METRICS) ltState.mvRej++; return; }   // teleport / speed hack (silently dropped)
    }

    const rlglPrevX = me.x, rlglPrevY = me.y;
    me.x = x; me.y = y;
    if (typeof data.dir === "string") me.dir = data.dir;
    me.anim = data.anim;
    wasSitting = sitting;
    lastMoveAt = now;
    if (LT_METRICS) ltState.mvOk++;
    // Red Light Green Light rides the validated pipeline: the move was already
    // accepted as legit, so red-light detection can't false-positive off junk.
    rlglOnMove(socket.id, rlglPrevX, rlglPrevY, x, y, now);
    // Prop Hunt secrecy: the hider's live position is never broadcast while a
    // round runs — the server tracks it (me.x/me.y above), everyone else only
    // ever learns the prop's frozen spot from phHunt.
    if (propHunt && propHunt.hiderId === socket.id) return;
    socket.broadcast.emit("playerMoved", { id: socket.id, ...me });
  });

  socket.on("chatMessage", (payload) => {
    const { message } = payload || {};
    if (!players[socket.id]) return;
    if (!takeToken(chatBucket)) return;   // throttle chat spam (silently drop)
    const text = (message || "").trim().slice(0, 200);
    if (!text) return;
    const msg = { mid: ++chatMsgSeq, id: socket.id, name: players[socket.id].name, message: text };
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

  // ── Chat images (pasted / dragged in, like Teams) ────────────────────
  // Ephemeral like text chat: broadcast once, held only in each client's
  // session log — a server restart wipes them, exactly like messages.
  // The client shrinks big pictures before sending; the server just enforces
  // the hard cap (2 MB image ≈ 2.73 MB base64) and the data-URL shape so a
  // modified client can't relay arbitrary payloads to everyone.
  const CHAT_IMG_MAX_B64 = 2_800_000;
  const CHAT_IMG_RE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
  socket.on("chatImage", (payload) => {
    const img = (payload || {}).img;
    if (!players[socket.id]) return;
    if (typeof img !== "string" || img.length > CHAT_IMG_MAX_B64 || !CHAT_IMG_RE.test(img)) return;
    if (!takeToken(chatImgBucket)) { socket.emit("chatImgError", "Sending pictures a bit fast — give it a few seconds."); return; }
    const msg = { mid: ++chatMsgSeq, id: socket.id, name: players[socket.id].name, img };
    // Same Office After Dark routing as text chat: lit players can't leak
    // to the people still in the dark.
    if (round && round.state === "active" && !inTheDark(socket.id)) {
      for (const id of Object.keys(players)) if (!inTheDark(id)) io.to(id).emit("chatImage", msg);
    } else {
      io.emit("chatImage", msg);
    }
    console.log(`${players[socket.id].name} shared a chat image (${Math.round(img.length / 1024)} KB b64)`);
  });

  // ── Chat-log reactions (ephemeral, like the messages they attach to) ──
  // The server only validates + relays; clients aggregate counts and treat a
  // repeat from the same person as a toggle-off. After Dark routing matches
  // chat so a reaction can't leak across the dark wall.
  socket.on("chatReact", (payload) => {
    const { mid, emoji } = payload || {};
    if (!players[socket.id]) return;
    if (!Number.isInteger(mid) || mid <= 0 || mid > chatMsgSeq) return;
    if (typeof emoji !== "string" || !CHAT_REACTS.has(emoji)) return;
    if (!takeToken(emoteBucket)) return;   // shares the emote throttle
    const out = { mid, emoji, id: socket.id, name: players[socket.id].name };
    if (round && round.state === "active" && !inTheDark(socket.id)) {
      for (const id of Object.keys(players)) if (!inTheDark(id)) io.to(id).emit("chatReact", out);
    } else {
      io.emit("chatReact", out);
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

  // ── Pet trick button — relay so everyone sees the trick (lively pets) ──
  // Client-side flavor animation; the server just validates + throttles and
  // fans out. Shares the After Dark isolation rule with emotes: a hidden
  // round participant's pet trick must not fire at their concealed position.
  socket.on("petTrick", () => {
    if (!players[socket.id]) return;
    if (!takeToken(emoteBucket)) return;             // same throttle pool as emotes
    if (round && round.state === "active" && !inTheDark(socket.id)) {
      for (const id of Object.keys(players)) if (!inTheDark(id)) io.to(id).emit("petTrick", { id: socket.id });
    } else {
      io.emit("petTrick", { id: socket.id });
    }
  });

  // ── Private whispers (DMs) — delivered ONLY to the target, echoed to sender ──
  // The client resolves the display name to a specific socket id via its online
  // roster (autocomplete), so name collisions are settled in the UI; the server
  // just validates the id is a live player. Shares chatBucket with public chat
  // so the combined message rate is what's limited. In-session only (no DB).
  // Owner-requested surveillance log: every delivered whisper (text or image)
  // is recorded for the owner-key F8 panel. Fire-and-forget — a DB blip must
  // never block or break the whisper itself. Occasional prune keeps the
  // table from growing without bound (images are base64 and chunky).
  function logWhisper(sender, target, text, img) {
    pool.query(
      `INSERT INTO jpo_whispers (from_email, from_name, to_email, to_name, message, img)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sender.email || "", sender.name || "?", target.email || "", target.name || "?", text || null, img || null],
    ).catch((err) => console.error("whisper log failed:", err.message));
    if (++_whisperLogN % 200 === 0) {
      pool.query(`DELETE FROM jpo_whispers WHERE id < (SELECT COALESCE(MAX(id),0) - 5000 FROM jpo_whispers)`)
        .catch((err) => console.error("whisper log prune failed:", err.message));
    }
  }
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
    logWhisper(sender, target, text, null);
    // Mission fact — the COUNT of an exchange (separate from the owner log).
    coachWhisperExchanged(socket.id, targetId);
  });

  // Whisper images: same validation as chatImage (cap + data-URL shape +
  // shared image throttle), same targeting/dark rules as text whispers.
  // Ephemeral like everything else in chat — target-only + sender echo.
  socket.on("whisperImage", (payload) => {
    const { targetId, img } = payload || {};
    const sender = players[socket.id];
    if (!sender) return;
    if (typeof img !== "string" || img.length > CHAT_IMG_MAX_B64 || !CHAT_IMG_RE.test(img)) return;
    if (!takeToken(chatImgBucket)) { socket.emit("whisperFailed", { message: "Sending pictures a bit fast — give it a few seconds." }); return; }
    if (typeof targetId !== "string" || targetId === socket.id) return;
    const target = players[targetId];
    if (!target) { socket.emit("whisperFailed", { message: "They're not in the office right now." }); return; }
    if (inTheDark(targetId) && !inTheDark(socket.id)) {
      socket.emit("whisperFailed", { message: "🌙 They're in the dark — wait until the round ends." });
      return;
    }
    io.to(targetId).emit("whisper", { fromId: socket.id, fromName: sender.name, img });
    socket.emit("whisperSent", { toId: targetId, toName: target.name, img });
    logWhisper(sender, target, null, img);
    coachWhisperExchanged(socket.id, targetId);
    console.log(`${sender.name} whispered an image to ${target.name} (${Math.round(img.length / 1024)} KB b64)`);
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
  socket.on("npcSync", () => { socket.emit("npcState", npcSnapshot()); socket.emit("hrNpcState", HR_NPC); });

  // ── Ms. Poli (HR): daily Code of Discipline quiz ──────────────────────
  socket.on("hrInteract", async () => {
    const p = players[socket.id];
    if (!p || !takeToken(coachBucket)) return;
    const dx = (p.x ?? 0) - HR_NPC.x, dy = (p.y ?? 0) - HR_NPC.y;
    if (dx * dx + dy * dy > HR_TALK_RADIUS * HR_TALK_RADIUS) {
      socket.emit("interactError", { message: "Walk over to Ms. Poli first!" });
      return;
    }
    p.hrTalkAt = Date.now();   // proximity verified — answer window opens
    if (!p.email) { socket.emit("hrQuiz", { guest: true }); return; }
    const day = new Date().toISOString().slice(0, 10);
    try {
      const qid = hrQuestionIdx(p.email, day);
      await pool.query(
        `INSERT INTO jpo_cod_quiz (day, email, qid) VALUES ($1, $2, $3)
         ON CONFLICT (day, email) DO NOTHING`, [day, p.email, qid]);
      const { rows } = await pool.query(
        `SELECT * FROM jpo_cod_quiz WHERE day=$1 AND email=$2`, [day, p.email]);
      socket.emit("hrQuiz", hrQuizView(rows[0]));
    } catch (err) {
      console.error("hrInteract failed:", err);
      socket.emit("interactError", { message: "Ms. Poli is filing paperwork — try again in a moment." });
    }
  });
  socket.on("hrAnswer", async (payload) => {
    const p = players[socket.id];
    if (!p?.email || !takeToken(coachBucket)) return;
    if (!hrSessionOk(p)) { socket.emit("interactError", { message: "Walk over to Ms. Poli first!" }); return; }
    p.hrTalkAt = Date.now();
    const answer = String(payload?.answer ?? "").trim().slice(0, 300);
    if (answer.length < 2) return;
    const day = new Date().toISOString().slice(0, 10);
    try {
      const { rows } = await pool.query(
        `SELECT * FROM jpo_cod_quiz WHERE day=$1 AND email=$2`, [day, p.email]);
      const row = rows[0];
      if (!row) { socket.emit("interactError", { message: "Talk to Ms. Poli first!" }); return; }
      if (row.solved) { socket.emit("hrQuiz", hrQuizView(row, { already: true })); return; }
      if (row.attempts >= HR_QUIZ_MAX_TRIES) { socket.emit("hrQuiz", hrQuizView(row, { capped: true })); return; }
      const item = COD_QUIZ[row.qid];
      if (!item) return;
      let correct;
      try {
        correct = await hrGradeAnswer(item, answer);
      } catch (gradeErr) {
        // Grading hiccup must NOT burn an attempt — tell them to just retry.
        console.error("hrGradeAnswer failed:", gradeErr.message);
        socket.emit("hrQuiz", hrQuizView(row, { checkFailed: true }));
        return;
      }
      if (!correct) {
        const upd = await pool.query(
          `UPDATE jpo_cod_quiz SET attempts = attempts + 1 WHERE day=$1 AND email=$2 AND solved=FALSE RETURNING *`,
          [day, p.email]);
        // Echo their typed answer back so they can screenshot it and show HR.
        if (upd.rows[0]) socket.emit("hrQuiz", hrQuizView(upd.rows[0], { wrong: true, yourAnswer: answer }));
        return;
      }
      // Correct: flip solved exactly once (guards restarts + double-clicks),
      // pay based on whether this was the very first attempt. Claim + coin
      // credit run in ONE transaction so a mid-flight failure can never leave
      // a solved row without its coins (review catch).
      const pay = row.attempts === 0 ? HR_QUIZ_PAY_FIRST : HR_QUIZ_PAY_LATE;
      const client = await pool.connect();
      let claimed = null, newCoins = null;
      try {
        await client.query("BEGIN");
        const claim = await client.query(
          `UPDATE jpo_cod_quiz SET solved=TRUE, paid=$3 WHERE day=$1 AND email=$2 AND solved=FALSE RETURNING *`,
          [day, p.email, pay]);
        claimed = claim.rows[0] || null;
        if (claimed) {
          const coin = await client.query(
            `UPDATE jpo_players SET coins = coins + $2, updated_at = now() WHERE email=$1 RETURNING coins`,
            [p.email, pay]);
          newCoins = coin.rows[0]?.coins ?? null;
        }
        await client.query("COMMIT");
      } catch (txErr) {
        await client.query("ROLLBACK").catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
      if (!claimed) { socket.emit("hrQuiz", hrQuizView(row, { already: true })); return; }
      if (newCoins !== null) { p.coins = newCoins; socket.emit("coinUpdate", { coins: p.coins }); }
      socket.emit("hrQuiz", hrQuizView(claimed, { justPaid: pay }));
      console.log(`COD quiz: ${p.email} solved q${row.qid} (attempt ${row.attempts + 1}, +${pay})`);
    } catch (err) {
      console.error("hrAnswer failed:", err);
      socket.emit("interactError", { message: "Ms. Poli lost her page — try again." });
    }
  });

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
      pet:        p.pet || "",
      petStage:   p.pet ? petStageFor(p) : 0,
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
    if (inAnyMatch(socket.id)) { socket.emit("rpsChallengeFailed", { message: "You're already in a challenge." }); return; }
    if (inAnyMatch(targetId)) { socket.emit("rpsChallengeFailed", { message: `${target.name} is busy in another match.` }); return; }
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

    if (m.game === "race") {
      // Clean up the rps match slot without sending a cancellation message.
      clearTimeout(m.acceptTimer);
      rpsBySocket.delete(m.challengerId);
      rpsBySocket.delete(m.targetId);

      // Block if a race is already running — don't hijack the public event.
      if (race) {
        io.to(m.challengerId).emit('raceChallengeFail', { message: 'A race is already running — try again when it ends.' });
        io.to(m.targetId).emit('raceChallengeFail',   { message: 'A race is already running — try again when it ends.' });
        return;
      }

      // Both players need a pet.
      if (!ch?.pet || !tg?.pet) {
        const msg = 'Both players need a pet equipped to race. 🐾';
        io.to(m.challengerId).emit('raceChallengeFail', { message: msg });
        io.to(m.targetId).emit('raceChallengeFail',   { message: msg });
        return;
      }

      const DUEL_COUNTDOWN_MS = 6000;
      race = {
        state: 'lobby', prize: 0, starterName: ch.name,
        entrants: new Map(), heats: [], currentHeat: 0, finalists: [],
        bets: new Map(), positions: new Map(), finishOrder: [],
        tickInterval: null, countdownTimer: null,
        joinDeadline: Date.now() + DUEL_COUNTDOWN_MS,
        duelIds: [m.challengerId, m.targetId],  // ← raceIO() targets only these two
        duelWager: m.wager,
        duelChallengerId: m.challengerId,
        duelTargetId: m.targetId,
      };

      // Auto-join both players immediately (no lobby needed).
      const chStage = petStageFor(ch), tgStage = petStageFor(tg);
      race.entrants.set(m.challengerId, { name: ch.name, petId: ch.pet, petStage: chStage, speed: racePetSpeed(ch.pet, chStage) });
      race.entrants.set(m.targetId,     { name: tg.name, petId: tg.pet, petStage: tgStage, speed: racePetSpeed(tg.pet, tgStage) });

      // Send a rich "VS" event — client shows a countdown screen, no lobby.
      io.to(m.challengerId).emit('raceChallenge', {
        isDuel: true, opponentName: tg.name, countdownMs: DUEL_COUNTDOWN_MS,
        myStem: petStemForRace(ch.pet, chStage), opponentStem: petStemForRace(tg.pet, tgStage),
      });
      io.to(m.targetId).emit('raceChallenge', {
        isDuel: true, opponentName: ch.name, countdownMs: DUEL_COUNTDOWN_MS,
        myStem: petStemForRace(tg.pet, tgStage), opponentStem: petStemForRace(ch.pet, chStage),
      });

      // Skip the public join window — start the duel after a short countdown.
      race.joinTimer = setTimeout(() => {
        if (!race || race.state !== 'lobby') return;
        race.finalists = [...race.entrants.keys()];
        race.heats = [];
        raceBeginFinal();
      }, DUEL_COUNTDOWN_MS);

      console.log(`Race duel: ${ch.name} vs ${tg.name}`);
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

  // ════════════════════════════════════════════════════════════════════════
  // ── Pet Battle handlers ──────────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════
  // SECURITY: every handler cross-checks that THIS socket owns the match it
  // names (battleBySocket keyed by socket id + a matchId equality check), and
  // no handler ever reads combat numbers from the payload — only a move name.

  // Shared validation for both the human and bot challenge paths. Confirms the
  // challenger is online, owns & has equipped a battle-ready pet, and isn't
  // already in a battle. Returns the player object, or null after emitting the
  // failure reason.
  function petBattleReadyChallenger() {
    const me = players[socket.id];
    if (!me) return null;
    if (!takeToken(petBattleBucket)) { socket.emit("petBattleFail", { message: "Slow down a moment." }); return null; }
    if (!me.email)                    { socket.emit("petBattleFail", { message: "Sign in with an approved account to battle." }); return null; }
    if (battleBySocket.has(socket.id)) { socket.emit("petBattleFail", { message: "You're already in a battle." }); return null; }
    if (rpsBySocket.has(socket.id))    { socket.emit("petBattleFail", { message: "Finish your current match first." }); return null; }
    if (inRound(socket.id))            { socket.emit("petBattleFail", { message: "No battles during Office After Dark!" }); return null; }
    if (grandEventIsBlockingOfficeEvents()) { socket.emit("petBattleFail", { message: "Normal Pet Battles pause during the Pet Wars Grand Event." }); return null; }
    if (!me.pet)                       { socket.emit("petBattleFail", { message: "Equip a pet to battle." }); return null; }
    // Roster/ownership: an equipped pet you no longer own can't fight (defends
    // against a stale equipped_pet after a trade).
    if (me.email && Array.isArray(me.cosmetics) && !me.cosmetics.includes(me.pet)) {
      socket.emit("petBattleFail", { message: "You don't own that pet anymore." }); return null;
    }
    return me;
  }

  // Freeze one side's snapshot from the AUTHORITATIVE live player (pet id +
  // stage from server XP + effective build). Never from client input.
  function petBattleSnapshotForPlayer(id, isBot) {
    const p = players[id];
    const pet = p.pet;
    const xp = ((p.petXp || {})[pet]) || 0;
    const stage = petStageOfPet(pet, xp);
    const build = effectivePetBuild(p, pet);
    return petBattleSnapshot(id, p.name, pet, stage, build, isBot);
  }

  // Challenge another online player to a pet battle.
  socket.on("petBattleChallenge", (payload) => {
    const { targetId } = payload || {};
    const me = petBattleReadyChallenger();
    if (!me) return;
    if (typeof targetId !== "string" || targetId === socket.id) {
      socket.emit("petBattleFail", { message: "Pick someone to battle." }); return;
    }
    const target = players[targetId];
    if (!target) { socket.emit("petBattleFail", { message: "They're not in the office right now." }); return; }
    if (!target.email) { socket.emit("petBattleFail", { message: `${target.name} needs a saved account to battle.` }); return; }
    if (battleBySocket.has(targetId)) { socket.emit("petBattleFail", { message: `${target.name} is already battling.` }); return; }
    if (rpsBySocket.has(targetId))    { socket.emit("petBattleFail", { message: `${target.name} is busy in another match.` }); return; }
    if (inRound(targetId))            { socket.emit("petBattleFail", { message: `${target.name} is playing Office After Dark.` }); return; }
    if (grandEventEmailCompeting(target.email)) { socket.emit("petBattleFail", { message: `${target.name} is locked into the Grand Event bracket.` }); return; }
    if (!target.pet)                  { socket.emit("petBattleFail", { message: `${target.name} needs a pet equipped to battle.` }); return; }
    if (target.email && Array.isArray(target.cosmetics) && !target.cosmetics.includes(target.pet)) {
      socket.emit("petBattleFail", { message: `${target.name} needs to equip a pet they own.` }); return;
    }
    // Range: walk up to them (same reach as duels).
    const dx = (me.x ?? 0) - (target.x ?? 0), dy = (me.y ?? 0) - (target.y ?? 0);
    if (dx * dx + dy * dy > PB_RANGE_PX * PB_RANGE_PX) {
      socket.emit("petBattleFail", { message: "Walk closer to battle them." }); return;
    }
    const matchId = globalThis.crypto.randomUUID();   // opaque, server-generated
    const b = {
      matchId, seq: ++petBattleSeq, challengerId: socket.id, opponentId: targetId,
      state: "pending", round: 0, sides: null,
      acceptTimer: setTimeout(() => petBattleCancel(socket.id, "Battle challenge expired."), PB_ACCEPT_MS),
    };
    battleBySocket.set(socket.id, b);
    battleBySocket.set(targetId, b);
    io.to(targetId).emit("petBattleChallengeIncoming", {
      matchId, fromId: socket.id, fromName: me.name, fromPet: me.pet,
      fromStage: petStageFor(me), timeoutMs: PB_ACCEPT_MS,
    });
    io.to(socket.id).emit("petBattleChallengeSent", {
      matchId, toId: targetId, toName: target.name, toPet: target.pet,
    });
    console.log(`Pet Battle challenge: ${me.name} → ${target.name}`);
  });

  // Challenge the training bot: an instant, no-partner battle vs a server-run
  // opponent that scales to the challenger's own form/training.
  socket.on("petBattleBotChallenge", () => {
    const me = petBattleReadyChallenger();
    if (!me) return;
    const matchId = globalThis.crypto.randomUUID();
    const b = {
      matchId, seq: ++petBattleSeq, challengerId: socket.id, opponentId: BOT_ID,
      state: "starting", round: 0, sides: null,
    };
    battleBySocket.set(socket.id, b);
    // Both snapshots: the bot mirrors the challenger's pet/stage/build so the
    // fight is close (non-player identity in the payload — see the view helper).
    const challengerSnap = petBattleSnapshotForPlayer(socket.id, false);
    const botSnap = petBattleSnapshot(BOT_ID, "Training Bot", challengerSnap.petId,
                                      challengerSnap.stage, challengerSnap.build, true);
    b.sides = { challenger: challengerSnap, opponent: botSnap };
    console.log(`Pet Battle (bot): ${me.name} vs Training Bot`);
    petBattleStart(b);
  });

  // Accept / decline an incoming challenge. Only the named target, on a
  // still-pending match, can accept; stale/forged responses are dropped.
  socket.on("petBattleRespond", (payload) => {
    const { matchId, accept } = payload || {};
    const b = battleBySocket.get(socket.id);
    if (!b || b.matchId !== matchId || b.state !== "pending" || socket.id !== b.opponentId) return;
    if (!accept) { petBattleCancel(socket.id, "Battle declined."); return; }
    const ch = players[b.challengerId], tg = players[b.opponentId];
    if (!ch || !tg) { petBattleCancel(socket.id, "Battle cancelled — someone left."); return; }
    if (!ch.email || !tg.email) { petBattleCancel(socket.id, "Battle cancelled — a saved account is required."); return; }
    // Re-validate both sides still have their equipped pets (a trade/unequip
    // could have happened during the accept window).
    if (!ch.pet || !tg.pet) { petBattleCancel(socket.id, "Battle cancelled — a pet was unequipped."); return; }
    if ((ch.email && Array.isArray(ch.cosmetics) && !ch.cosmetics.includes(ch.pet))
        || (tg.email && Array.isArray(tg.cosmetics) && !tg.cosmetics.includes(tg.pet))) {
      petBattleCancel(socket.id, "Battle cancelled — an equipped pet is no longer owned."); return;
    }
    clearTimeout(b.acceptTimer);
    // Freeze BOTH snapshots at accept time (the start-of-battle moment).
    b.sides = {
      challenger: petBattleSnapshotForPlayer(b.challengerId, false),
      opponent:   petBattleSnapshotForPlayer(b.opponentId, false),
    };
    petBattleStart(b);
  });

  // A per-round move intent. Validates ownership of the match, that it's the
  // picking phase, that the move is a legal string, and that the move is
  // currently allowed (cooldown/charge). First pick locks — no take-backs.
  socket.on("petBattlePick", (payload) => {
    const { matchId, move } = payload || {};
    const b = battleBySocket.get(socket.id);
    if (!b || b.matchId !== matchId || b.state !== "picking") return;
    if (typeof move !== "string" || !PB_MOVES.has(move)) return;   // never accept anything but a legal move name
    const side = b.sides.challenger.id === socket.id ? b.sides.challenger
               : b.sides.opponent.id  === socket.id ? b.sides.opponent : null;
    if (!side || side.pick) return;   // not a combatant, or already locked
    if (b.tournament && b.suddenDeath && move === "guard") {
      socket.emit("petBattleFail", { message: "Guard is disabled in sudden death." }); return;
    }
    if (!petBattleMoveLegal(side, move)) {
      socket.emit("petBattleFail", { message: "That move isn't ready." }); return;
    }
    side.pick = move;
    // Only the FACT of a pick leaks to the foe — never the move itself.
    const foeId = petBattleOtherId(b, socket.id);
    if (foeId !== BOT_ID) io.to(foeId).emit("petBattlePickStatus", { matchId: b.matchId, foePicked: true });
    if (b.sides.challenger.pick && b.sides.opponent.pick) {
      petBattleResolve(b).catch((err) => console.error("pet battle resolve failed:", err));
    }
  });

  // Explicit cancel of a not-yet-started challenge you own. An ACTIVE battle
  // can't be freely cancelled (that would be a dodge) — leaving forfeits it.
  socket.on("petBattleCancel", (payload) => {
    const { matchId } = (payload || {});
    const b = battleBySocket.get(socket.id);
    if (!b || (matchId && b.matchId !== matchId)) return;
    if (b.state !== "pending") return;   // active battles settle via forfeit, not cancel
    petBattleCancel(socket.id, "Battle cancelled.");
  });

  // A deliberate mid-battle surrender. Unlike pending cancellation, this is a
  // settled forfeit: the opponent receives the smaller forfeit reward and the
  // surrendering pet receives zero. The caller must own this active match.
  socket.on("petBattleForfeit", (payload) => {
    const { matchId } = payload || {};
    const b = battleBySocket.get(socket.id);
    if (!b || b.matchId !== matchId) return;
    if (b.state !== "picking" && b.state !== "resolving" && b.state !== "starting") return;
    const leaverSide = b.sides.challenger.id === socket.id ? "challenger" : "opponent";
    const winnerSide = petBattleOtherId2(leaverSide);
    petBattleFinish(b, { reason: "forfeit", winnerSide, forfeit: true })
      .catch((err) => console.error("pet battle surrender failed:", err));
  });

  // Return the current stored build (and derived budget/stats) for one of the
  // caller's pets. Read-only.
  socket.on("petBattleGetBuild", (payload) => {
    const p = players[socket.id];
    if (!p) return;
    if (!takeToken(petBattleBucket)) return;
    const pet = (payload || {}).pet;
    if (typeof pet !== "string" || !Object.hasOwn(PETS, pet)) return;
    if (p.email && Array.isArray(p.cosmetics) && !p.cosmetics.includes(pet)) return;   // ownership
    const xp = ((p.petXp || {})[pet]) || 0;
    const build = effectivePetBuild(p, pet);
    socket.emit("petBattleBuild", {
      pet, build, budget: petBattleBudget(pet, xp),
      spent: PB_ATTRS.reduce((s, a) => s + (build[a] || 0), 0),
      stage: petStageOfPet(pet, xp), attrs: PB_ATTRS,
      kit: petBattlePublicKit(petBattleKit(pet)),
      stats: petBattleStats(petStageOfPet(pet, xp), build, petBattleKit(pet)),
    });
  });

  // Persist a training build for one of the caller's pets. Validates ownership,
  // that every allocation is a non-negative int in the allowlist, and that the
  // total spent fits the pet's XP/stage budget. Rejected builds are NOT clamped
  // — a bad payload leaves the stored build untouched.
  socket.on("petBattleSetBuild", async (payload) => {
    const p = players[socket.id];
    if (!p) return;
    if (!takeToken(petBattleBucket)) { socket.emit("petBattleFail", { message: "Slow down a moment." }); return; }
    const { pet, build } = (payload || {});
    if (typeof pet !== "string" || !Object.hasOwn(PETS, pet)) {
      socket.emit("petBattleFail", { message: "Unknown pet." }); return;
    }
    if (Array.isArray(p.cosmetics) && !p.cosmetics.includes(pet)) {
      socket.emit("petBattleFail", { message: "You don't own that pet." }); return;
    }
    const xp = ((p.petXp || {})[pet]) || 0;
    const budget = petBattleBudget(pet, xp);
    const clean = sanitizePetBuild(build, budget);
    if (!clean) { socket.emit("petBattleFail", { message: "Invalid training allocation." }); return; }
    // Persist: JSONB per-pet, keyed by pet id. Account players → DB; session
    // players → memory only.
    if (p.email) {
      try {
        await pool.query(
          `UPDATE jpo_players
              SET pet_builds = jsonb_set(coalesce(pet_builds, '{}'::jsonb), ARRAY[$2::text], $3::jsonb),
                  updated_at = now()
            WHERE email = $1`,
          [p.email, pet, JSON.stringify(clean)]);
      } catch (err) {
        console.error("petBattleSetBuild persist failed:", err);
        socket.emit("petBattleFail", { message: "Couldn't save your build — try again." });
        return;
      }
    }
    // Update the live authoritative copy only after durable persistence
    // succeeds; a failed save must not silently affect the next battle.
    p.petBuilds = p.petBuilds || {};
    p.petBuilds[pet] = clean;
    socket.emit("petBattleBuild", {
      pet, build: clean, budget,
      spent: PB_ATTRS.reduce((s, a) => s + (clean[a] || 0), 0),
      stage: petStageOfPet(pet, xp), attrs: PB_ATTRS,
      kit: petBattlePublicKit(petBattleKit(pet)),
      stats: petBattleStats(petStageOfPet(pet, xp), clean, petBattleKit(pet)),
    });
    console.log(`${p.name} set ${pet} battle build (spent ${PB_ATTRS.reduce((s, a) => s + (clean[a] || 0), 0)}/${budget})`);
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
      const { rows: delRows } = await pool.query(`DELETE FROM jpo_announcements WHERE id = $1 RETURNING name, text`, [numId]);
      if (delRows[0]) logAdmin(socket, "Announcement deleted", `${delRows[0].name}: "${String(delRows[0].text).slice(0, 120)}"`);
      io.emit("announcementsUpdate", await fetchAnnouncements());
    } catch (err) { console.error("deleteAnnouncement failed:", err); }
  });

  socket.on("buyCosmetic", async (payload) => {
    const { item } = payload || {};
    const p = players[socket.id], cost = salePrice(SHOP[item]);
    if (!p) return;
    // Rare wearables are shop-visible bait, never purchasable — gift-only.
    if (RARE_COSMETICS.has(item)) { socket.emit("shopError", "This one can't be bought — only the boss can gift it. 🎁"); return; }
    // Seasonal stock: authoritative gate (client hiding is cosmetic only).
    if (SEASONAL_ITEMS[item] && seasonNow() !== SEASONAL_ITEMS[item]) { socket.emit("shopError", "That's a seasonal item — it's out of season right now! 📅"); return; }
    if (!cost) return;
    if (!takeToken(buyBucket)) return;   // throttle rapid buy attempts
    // No spending while in an RPS challenge/match: this is what keeps the
    // accept-time wager check exact all the way to settlement (the coin tick
    // only ever ADDS coins).
    if (inAnyMatch(socket.id)) { socket.emit("shopError", "Finish your match first!"); return; }
    if (inActiveRound(socket.id)) { socket.emit("shopError", "The lights are out — no shopping until the round ends!"); return; }

    // Session-only players (no email): memory-only purchase.
    if (!p.email) {
      if (p.cosmetics.includes(item)) { socket.emit("shopError", "Already owned!"); return; }
      if (p.coins < cost) { socket.emit("shopError", "Not enough coins!"); return; }
      p.coins -= cost;
      p.cosmetics.push(item);
      p.slots = p.slots || emptySlots();
      // Buying auto-equips into the item's OWN slot (wings / outfit slot / legacy).
      if (WINGS_IDS.has(item)) p.wings = item;
      else if (WEAR_SLOT[item]) p.slots[WEAR_SLOT[item]] = item;
      else p.equipped = item;
      socket.emit("coinUpdate",  { coins: p.coins });
      socket.emit("shopSuccess", { item, equipped: p.equipped, wings: p.wings || "", slots: p.slots });
      io.emit("playerCosmeticUpdate", { id: socket.id, cosmetics: p.cosmetics, equipped: p.equipped, wings: p.wings || "", slots: p.slots });
      console.log(`${p.name} bought ${item} (session-only)`);
      return;
    }

    try {
      // One atomic statement guards both "enough coins" and "not already owned",
      // so a coin tick or a double-click can't produce an inconsistent balance.
      // Buying auto-equips the new item (players can switch afterwards for free).
      const isWings = WINGS_IDS.has(item);
      // Column the auto-equip lands in: wings / the item's outfit slot / legacy.
      const equipCol = isWings ? "equipped_wings" : (SLOT_COL[WEAR_SLOT[item]] || "equipped_cosmetic");
      const { rows } = await pool.query(
        `UPDATE jpo_players
            SET coins = coins - $2,
                cosmetics = array_append(cosmetics, $3),
                ${equipCol} = $3,
                updated_at = now()
          WHERE email = $1 AND coins >= $2 AND NOT ($3 = ANY(cosmetics))
          RETURNING coins, cosmetics, equipped_cosmetic, equipped_wings,
                    equipped_top, equipped_bottom, equipped_neckwear, equipped_held, equipped_feet`,
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
      p.wings = rows[0].equipped_wings || "";
      p.slots = { top: rows[0].equipped_top || "", bottom: rows[0].equipped_bottom || "", neckwear: rows[0].equipped_neckwear || "", held: rows[0].equipped_held || "", feet: rows[0].equipped_feet || "" };
      socket.emit("coinUpdate",  { coins: p.coins });
      socket.emit("shopSuccess", { item, equipped: p.equipped, wings: p.wings, slots: p.slots });
      io.emit("playerCosmeticUpdate", { id: socket.id, cosmetics: p.cosmetics, equipped: p.equipped, wings: p.wings, slots: p.slots });
      console.log(`${p.name} bought ${item}`);
    } catch (err) { console.error("buyCosmetic failed:", err); }
  });

  // ── Click-your-pet panel: feed a treat from anywhere ─────────────────────
  // Same throttle + wager/round blocks as buyFood, minus the counter
  // proximity — you carry treats for YOUR pet, not the cafeteria's.
  socket.on("feedPet", async () => {
    const p = players[socket.id];
    if (!p) return;
    if (!takeToken(buyBucket)) return;
    if (inAnyMatch(socket.id)) { socket.emit("foodError", { message: "Finish your match first!" }); return; }
    if (inActiveRound(socket.id)) { socket.emit("foodError", { message: "The lights are out — no snacking until the round ends!" }); return; }
    await feedPetTreat(io, socket, p);
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
    if (inAnyMatch(socket.id)) { socket.emit("foodError", { message: "Finish your match first!" }); return; }
    if (inActiveRound(socket.id)) { socket.emit("foodError", { message: "The lights are out — no snacking until the round ends!" }); return; }
    const obj = OBJECTS[station];
    const dx = (p.x ?? 0) - obj.x, dy = (p.y ?? 0) - obj.y;
    if (dx * dx + dy * dy > obj.r * obj.r) {
      socket.emit("foodError", { message: "Walk back to the counter to order." });
      return;
    }
    const menuItem = FOOD_MENUS[FOOD_STATIONS[station]].items.find((it) => it.id === item);
    if (!menuItem) return;

    // ── Pet Treat: same shared feed path as the click-your-pet panel ─────
    if (menuItem.id === "pet_treat") { await feedPetTreat(io, socket, p); return; }

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
    if (item !== "" && !Object.hasOwn(SHOP, item)) return;   // unknown cosmetic id (hasOwn: rare items are price 0 but still equipable by owners)
    // Wings, outfit slots and the legacy wearable slot are all separate. For
    // item === "" (take off) the client says which slot; a non-empty item's
    // slot follows from its id.
    const reqSlot = (payload || {}).slot;
    const slot = item !== "" ? (WINGS_IDS.has(item) ? "wings" : (WEAR_SLOT[item] || "wear"))
               : (reqSlot === "wings" || SLOT_KEYS.includes(reqSlot) ? reqSlot : "wear");
    const isWings = slot === "wings";
    const isOutfit = SLOT_KEYS.includes(slot);
    p.slots = p.slots || emptySlots();
    if (!takeToken(buyBucket)) return;               // shares the shop's spam throttle
    if ((isWings ? p.wings : isOutfit ? p.slots[slot] : p.equipped) === item) return;   // no-op

    if (!p.email) {
      if (item !== "" && !p.cosmetics.includes(item)) { socket.emit("shopError", "You don't own that!"); return; }
      if (isWings) p.wings = item; else if (isOutfit) p.slots[slot] = item; else p.equipped = item;
      socket.emit("equipUpdate", { equipped: p.equipped, wings: p.wings || "", slots: p.slots });
      io.emit("playerCosmeticUpdate", { id: socket.id, cosmetics: p.cosmetics, equipped: p.equipped, wings: p.wings || "", slots: p.slots });
      return;
    }

    try {
      const col = isWings ? "equipped_wings" : isOutfit ? SLOT_COL[slot] : "equipped_cosmetic";
      const { rows } = await pool.query(
        `UPDATE jpo_players
            SET ${col} = $2, updated_at = now()
          WHERE email = $1 AND ($2 = '' OR $2 = ANY(cosmetics))
          RETURNING equipped_cosmetic, equipped_wings,
                    equipped_top, equipped_bottom, equipped_neckwear, equipped_held, equipped_feet`,
        [p.email, item],
      );
      if (rows.length === 0) { socket.emit("shopError", "You don't own that!"); return; }
      p.equipped = rows[0].equipped_cosmetic || "";
      p.wings = rows[0].equipped_wings || "";
      p.slots = { top: rows[0].equipped_top || "", bottom: rows[0].equipped_bottom || "", neckwear: rows[0].equipped_neckwear || "", held: rows[0].equipped_held || "", feet: rows[0].equipped_feet || "" };
      socket.emit("equipUpdate", { equipped: p.equipped, wings: p.wings, slots: p.slots });
      io.emit("playerCosmeticUpdate", { id: socket.id, cosmetics: p.cosmetics, equipped: p.equipped, wings: p.wings, slots: p.slots });
    } catch (err) { console.error("equipCosmetic failed:", err); }
  });

  // ── Pets: buy a companion (auto-adopts it) ───────────────────────────────
  // Mirrors buyCosmetic exactly: same throttle, same mid-match block (coins
  // move), and the same one-statement atomicity — the coins guard, the
  // "not already owned" guard, the ownership append (into the shared
  // cosmetics array) and the auto-equip into equipped_pet all commit together.
  socket.on("buyPet", async (payload) => {
    const { item } = payload || {};
    const p = players[socket.id], cost = salePrice(PETS[item]);
    if (!p) return;
    // Rare pets are shop-visible bait, never purchasable — gift-only.
    if (RARE_PETS.has(item)) { socket.emit("shopError", "This one can't be bought — only the boss can gift it. 🎁"); return; }
    // Seasonal stock: authoritative gate (client hiding is cosmetic only).
    if (SEASONAL_PETS[item] && seasonNow() !== SEASONAL_PETS[item]) { socket.emit("shopError", "That pet is seasonal — it's out of season right now! 📅"); return; }
    if (!cost) return;
    if (!takeToken(buyBucket)) return;   // shares the shop's spam throttle
    if (inAnyMatch(socket.id)) { socket.emit("shopError", "Finish your match first!"); return; }
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
      io.emit("playerPetUpdate", { id: socket.id, pet: p.pet, petAcc: p.petAcc || "", petStage: petStageFor(p) });
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
      io.emit("playerPetUpdate", { id: socket.id, pet: p.pet, petAcc: p.petAcc || "", petStage: petStageFor(p) });
      console.log(`${p.name} adopted ${item}`);
    } catch (err) { console.error("buyPet failed:", err); }
  });

  // ── Pets: name your companion (per-pet, sticks across evolutions) ────────
  // Free, so not blocked mid-match. Name is sanitized + capped server-side;
  // stored per-pet in jpo_players.pet_names so each companion keeps its own.
  socket.on("namePet", async (payload) => {
    const p = players[socket.id];
    if (!p || !p.pet) return;
    if (!takeToken(buyBucket)) return;   // shares the shop's spam throttle
    const raw = String((payload || {}).petName ?? "");
    const petName = raw.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 16);
    const pet = p.pet;
    if (p.email) {
      try {
        await pool.query(
          `UPDATE jpo_players
              SET pet_names = jsonb_set(coalesce(pet_names, '{}'::jsonb), ARRAY[$2::text], to_jsonb($3::text)),
                  updated_at = now()
            WHERE email = $1`,
          [p.email, pet, petName],
        );
      } catch (err) { console.error("namePet failed:", err); return; }
    }
    p.petNames = p.petNames || {};
    p.petNames[pet] = petName;
    socket.emit("petNamed", { pet, petName });
    console.log(`${p.name} named ${pet} "${petName}"`);
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
    if (item !== "" && !Object.hasOwn(PETS, item)) return;   // unknown pet id (hasOwn: rare pets are price 0 but still equipable by owners)
    if (!takeToken(buyBucket)) return;               // shares the shop's spam throttle
    if ((p.pet || "") === item) return;              // no-op

    if (!p.email) {
      if (item !== "" && !p.cosmetics.includes(item)) { socket.emit("shopError", "You don't own that!"); return; }
      p.pet = item;
      socket.emit("petUpdate", { pet: p.pet, petAcc: p.petAcc || "" });
      io.emit("playerPetUpdate", { id: socket.id, pet: p.pet, petAcc: p.petAcc || "", petStage: petStageFor(p) });
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
      io.emit("playerPetUpdate", { id: socket.id, pet: p.pet, petAcc: p.petAcc || "", petStage: petStageFor(p) });
    } catch (err) { console.error("equipPet failed:", err); }
  });

  // ── Pet accessories: buy one (auto-puts it on) ───────────────────────────
  // Mirrors buyPet exactly: same throttle, same mid-match/mid-round blocks
  // (coins move), and the same one-statement atomicity — the coins guard, the
  // "not already owned" guard, the ownership append (shared cosmetics array)
  // and the auto-equip into equipped_pet_acc all commit together.
  socket.on("buyPetAcc", async (payload) => {
    const { item } = payload || {};
    const p = players[socket.id], cost = salePrice(PET_ACCESSORIES[item]);
    if (!p || !cost) return;
    if (!takeToken(buyBucket)) return;   // shares the shop's spam throttle
    if (inAnyMatch(socket.id)) { socket.emit("shopError", "Finish your match first!"); return; }
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
      io.emit("playerPetUpdate", { id: socket.id, pet: p.pet || "", petAcc: p.petAcc, petStage: petStageFor(p) });
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
      io.emit("playerPetUpdate", { id: socket.id, pet: p.pet || "", petAcc: p.petAcc, petStage: petStageFor(p) });
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
      io.emit("playerPetUpdate", { id: socket.id, pet: p.pet || "", petAcc: p.petAcc, petStage: petStageFor(p) });
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
      io.emit("playerPetUpdate", { id: socket.id, pet: p.pet || "", petAcc: p.petAcc, petStage: petStageFor(p) });
    } catch (err) { console.error("equipPetAcc failed:", err); }
  });

  // ── Coin gifting: send coins to another player ───────────────────────────
  // Same money rules as the shop: buy throttle, blocked mid-match for the
  // SENDER (spending would break the wager invariant; the receiver only
  // gains, which is always safe), blocked in an After Dark round. The move
  // itself reuses rpsSettle (receiver "wins" the amount from the sender), so
  // a partial transfer is impossible in every email/session combination.
  // Recipient hit ✕ on a lingering gift receipt — delete THEIR row only.
  socket.on("giftNoticeSeen", async (payload) => {
    const id = payload?.id;
    const p = players[socket.id];
    if (!p?.email || !Number.isInteger(id)) return;
    try {
      await pool.query(`DELETE FROM jpo_gift_notices WHERE id = $1 AND email = $2`, [id, p.email]);
    } catch (err) { console.error("gift notice dismiss failed:", err); }
  });

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
    if (inAnyMatch(socket.id)) { fail("Finish your match first!"); return; }
    if (inAnyMatch(targetId)) { fail(`${target.name} is mid-match — wait for it to finish.`); return; }
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
      // Lingering receipt: saved per-email so it survives refreshes/offline
      // periods and stays on the recipient's screen until they hit ✕.
      // Session-only players (no email) just get the live card.
      if (target.email) {
        try {
          const { rows: gn } = await pool.query(
            `INSERT INTO jpo_gift_notices (email, from_name, amount) VALUES ($1, $2, $3) RETURNING id, ts`,
            [target.email, p.name, moved]);
          pool.query(
            `DELETE FROM jpo_gift_notices WHERE email = $1 AND id NOT IN
               (SELECT id FROM jpo_gift_notices WHERE email = $1 ORDER BY id DESC LIMIT ${GIFT_NOTICE_MAX})`,
            [target.email]).catch(() => {});
          io.to(targetId).emit("giftReceived", { id: gn[0].id, fromName: p.name, amount: moved, ts: gn[0].ts });
        } catch (err) {
          console.error("gift notice save failed:", err);
          io.to(targetId).emit("giftReceived", { id: null, fromName: p.name, amount: moved });
        }
      } else {
        io.to(targetId).emit("giftReceived", { id: null, fromName: p.name, amount: moved });
      }
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
    if (inAnyMatch(socket.id) || inAnyMatch(targetId)) { fail("No trading mid-match!"); return; }
    if (inActiveRound(socket.id) || inActiveRound(targetId)) { fail("The lights are out — no trading until the round ends!"); return; }
    if (tradeBySocket.has(socket.id)) { fail("You already have a trade open."); return; }
    if (tradeBySocket.has(targetId)) { fail(`${target.name} is already in a trade.`); return; }
    if (typeof offerPet !== "string" || !PETS[offerPet]) { fail("Pick one of your pets to offer."); return; }
    if (typeof askPet !== "string" || !PETS[askPet]) { fail("Pick one of their pets to ask for."); return; }
    // Rare pets are gift-only from the boss — they never change hands
    // between players (trades here, store listings in storeList).
    if (RARE_PETS.has(offerPet) || RARE_PETS.has(askPet)) { fail("Rare pets can't be traded — they're personal gifts from the boss."); return; }
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
    // Settle-time backup for the offer-time rare check (an old pending trade
    // created before a pet was made rare must not slip through).
    if (RARE_PETS.has(t.offerPet) || RARE_PETS.has(t.askPet)) { abort("Rare pets can't be traded — they're personal gifts from the boss."); return; }
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
        // Evolution travels with each pet, both directions of the swap.
        const xpOfferTo = await transferPetXpTx(client, from.email, to.email, t.offerPet);
        const xpAskTo   = await transferPetXpTx(client, to.email, from.email, t.askPet);
        await client.query("COMMIT");
        ok = true; fromRow = r1.rows[0]; toRow = r2.rows[0];
        from.petXp = from.petXp || {}; to.petXp = to.petXp || {};
        delete from.petXp[t.offerPet]; from.petXp[t.askPet] = xpAskTo;
        delete to.petXp[t.askPet];     to.petXp[t.offerPet] = xpOfferTo;
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
      io.emit("playerPetUpdate", { id, pet: pl.pet, petAcc: pl.petAcc || "", petStage: petStageFor(pl) });
      io.emit("playerCosmeticUpdate", { id, cosmetics: pl.cosmetics, equipped: pl.equipped || "", wings: pl.wings || "", slots: pl.slots || emptySlots() });
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
    // Gift-only rares never change hands between players.
    if (RARE_IDS.has(item)) { storeFail("Rare items can't be listed — they're personal gifts from the boss."); return; }
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
    if (inAnyMatch(socket.id)) { storeFail("Finish your match first!"); return; }
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
    if (inAnyMatch(socket.id)) { storeFail("Finish your match first!"); return; }
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
           equipped_wings    = CASE WHEN equipped_wings    = $1 THEN '' ELSE equipped_wings    END,
           equipped_pet      = CASE WHEN equipped_pet      = $1 THEN '' ELSE equipped_pet      END,
           equipped_pet_acc  = CASE WHEN equipped_pet_acc  = $1 THEN '' ELSE equipped_pet_acc  END,
           equipped_top      = CASE WHEN equipped_top      = $1 THEN '' ELSE equipped_top      END,
           equipped_bottom   = CASE WHEN equipped_bottom   = $1 THEN '' ELSE equipped_bottom   END,
           equipped_neckwear = CASE WHEN equipped_neckwear = $1 THEN '' ELSE equipped_neckwear END,
           equipped_held     = CASE WHEN equipped_held     = $1 THEN '' ELSE equipped_held     END,
           equipped_feet     = CASE WHEN equipped_feet     = $1 THEN '' ELSE equipped_feet     END
         WHERE email = $3 AND $1 = ANY(cosmetics)
         RETURNING coins, cosmetics, equipped_cosmetic, equipped_wings, equipped_pet, equipped_pet_acc,
                   equipped_top, equipped_bottom, equipped_neckwear, equipped_held, equipped_feet`,
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
      // Pets sell WITH their evolution — move the feeding history to the buyer.
      let winnerPetXp = null;
      if (Object.prototype.hasOwnProperty.call(PETS, item) || RARE_PETS.has(item)) {
        winnerPetXp = await transferPetXpTx(client, p.email, win.bidder_email, item);
      }
      await client.query("COMMIT");
      done = { item, win, losers, sellerRow: sold[0], winnerPetXp };
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
      const hadPet = p.pet, hadCos = p.equipped, hadWings = p.wings, hadAcc = p.petAcc;
      const hadSlots = JSON.stringify(p.slots || emptySlots());
      p.equipped = done.sellerRow.equipped_cosmetic || "";
      p.wings = done.sellerRow.equipped_wings || "";
      p.pet = done.sellerRow.equipped_pet || "";
      p.petAcc = done.sellerRow.equipped_pet_acc || "";
      p.slots = {
        top:      done.sellerRow.equipped_top      || "",
        bottom:   done.sellerRow.equipped_bottom   || "",
        neckwear: done.sellerRow.equipped_neckwear || "",
        held:     done.sellerRow.equipped_held     || "",
        feet:     done.sellerRow.equipped_feet     || "",
      };
      if (done.winnerPetXp != null) { p.petXp = p.petXp || {}; delete p.petXp[done.item]; }
      socket.emit("coinUpdate", { coins: p.coins });
      if (hadCos !== p.equipped || hadWings !== p.wings || hadSlots !== JSON.stringify(p.slots)) io.emit("playerCosmeticUpdate", { id: socket.id, cosmetics: p.cosmetics, equipped: p.equipped, wings: p.wings, slots: p.slots });
      if (hadPet !== p.pet || hadAcc !== p.petAcc) io.emit("playerPetUpdate", { id: socket.id, item: p.pet, acc: p.petAcc, petStage: petStageFor(p) });
    }
    socket.emit("storeOk", { message: `Sold! ${label} went for ${done.win.amount.toLocaleString()} coins.` });
    // Winner: live sync or queued note.
    const winSock = socketIdByEmail(done.win.bidder_email);
    if (winSock && players[winSock]) {
      players[winSock].cosmetics = [...(players[winSock].cosmetics || []), done.item];
      if (done.winnerPetXp != null) {
        players[winSock].petXp = players[winSock].petXp || {};
        players[winSock].petXp[done.item] = done.winnerPetXp;
      }
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
    if (inAnyMatch(socket.id)) { socket.emit("shopError", "Finish your match first!"); return; }
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

  // ── Avatar makeover: hair colour and/or base character ───────────────────
  // First change per account is FREE, then AVATAR_PRICE each. Same money
  // rules as changeOutfit: atomic coins-guard SQL, blocked mid-match and
  // during a round, shares the buy-spam throttle. The name never changes —
  // only the look. Both hair + character in one purchase = one charge.
  socket.on("changeAvatar", async (payload) => {
    const { character, hairIdx } = payload || {};
    const p = players[socket.id];
    if (!p) return;
    if (!AVATAR_CHARS.includes(character)) return;
    if (!Number.isInteger(hairIdx) || hairIdx < 0 || hairIdx > HAIR_MAX) return;
    if (!takeToken(buyBucket)) return;
    if (inAnyMatch(socket.id)) { socket.emit("shopError", "Finish your match first!"); return; }
    if (inActiveRound(socket.id)) { socket.emit("shopError", "The lights are out — no makeovers until the round ends!"); return; }
    if (character === p.character && hairIdx === p.hairIdx) {
      socket.emit("shopError", "That's already your look!");
      return;
    }

    // Session-only players (no email): memory-only change. NO free first
    // change here — "first free" is a per-ACCOUNT perk, and a session-only
    // identity can be recreated endlessly to farm it. They always pay.
    if (!p.email) {
      const cost = AVATAR_PRICE;
      if ((p.coins || 0) < cost) { socket.emit("shopError", "Not enough coins!"); return; }
      p.coins -= cost;
      p.character = character;
      p.hairIdx = hairIdx;
      p.avatarChanges = (p.avatarChanges ?? 0) + 1;
      socket.emit("coinUpdate",    { coins: p.coins });
      socket.emit("avatarSuccess", { character, hairIdx, avatarChanges: p.avatarChanges });
      io.emit("playerOutfitUpdate", {
        id: socket.id, character, hairIdx,
        skinIdx: p.skinIdx, shirtIdx: p.shirtIdx, pantsIdx: p.pantsIdx,
      });
      console.log(`${p.name} changed avatar (session-only)`);
      return;
    }

    try {
      // One statement: free when avatar_changes = 0, otherwise charge —
      // and the coins guard uses the SAME row state, so no TOCTOU window.
      const { rows } = await pool.query(
        `UPDATE jpo_players
            SET coins = coins - (CASE WHEN avatar_changes = 0 THEN 0 ELSE $2 END),
                character = $3, hair_idx = $4,
                avatar_changes = avatar_changes + 1, updated_at = now()
          WHERE email = $1 AND coins >= (CASE WHEN avatar_changes = 0 THEN 0 ELSE $2 END)
          RETURNING coins, character, hair_idx, avatar_changes`,
        [p.email, AVATAR_PRICE, character, hairIdx],
      );
      if (rows.length === 0) { socket.emit("shopError", "Not enough coins!"); return; }
      p.coins         = rows[0].coins;
      p.character     = rows[0].character;
      p.hairIdx       = rows[0].hair_idx;
      p.avatarChanges = rows[0].avatar_changes;
      socket.emit("coinUpdate",    { coins: p.coins });
      socket.emit("avatarSuccess", { character: p.character, hairIdx: p.hairIdx, avatarChanges: p.avatarChanges });
      io.emit("playerOutfitUpdate", {
        id: socket.id, character: p.character, hairIdx: p.hairIdx,
        skinIdx: p.skinIdx, shirtIdx: p.shirtIdx, pantsIdx: p.pantsIdx,
      });
      console.log(`${p.name} changed avatar (${p.character}, hair ${p.hairIdx}, change #${p.avatarChanges})`);
    } catch (err) { console.error("changeAvatar failed:", err); }
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
    if (inAnyMatch(socket.id)) { socket.emit("shopError", "Finish your match first!"); return; }
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
    // Prop Hunt: the hider can't use items — confetti/fireworks/group treats
    // broadcast their exact x/y office-wide, which would out the hiding spot.
    if (propHunt && propHunt.hiderId === socket.id) {
      socket.emit("itemError", { message: "🙈 Not while you're hiding — furniture doesn't party!" });
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

    // Red Light Green Light: no coffee, no pizza, no speed while you're on the
    // field (owner's rule). Runs BEFORE the charge is spent.
    if (BOOST_ITEMS.has(item) && rlglActiveRunner(socket.id)) {
      socket.emit("itemError", { message: "🚦 The doll is watching — no coffee, no pizza, NO speed until the race is over!" });
      return;
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
      // …and RLGL runners can't be boosted from the sidelines either — a buddy
      // buying a pizza party next to the arena must not speed up a racer.
      const ids = nearbyIds(socket.id, GROUP_RADIUS).filter((rid) => !inTheDark(rid) && !rlglActiveRunner(rid));
      for (const rid of ids) {
        const q = players[rid];
        if (!q) continue;
        q.boostUntil = Math.max(q.boostUntil || 0, now + dur);
        io.emit("coffeeBoost", { id: rid, durationMs: dur, mult: COFFEE_MULT, emoji });
      }
      // Earnings buff: only when the treat actually reached someone besides
      // the buyer — a solo "round" in an empty corner stays speed-only, so
      // there is no way to buy your own coin multiplier. earnUntil only
      // EXTENDS (max) and is persisted so a refresh/restart can't eat a paid
      // 10–20 minute buff.
      if (ids.some((rid) => rid !== socket.id)) {
        const edur = item === "pizza_party" ? EARN_PIZZA_MS : EARN_COFFEE_MS;
        for (const rid of ids) {
          const q = players[rid];
          if (!q) continue;
          q.earnUntil = Math.max(q.earnUntil || 0, now + edur);
          io.to(rid).emit("earnBoost", { until: q.earnUntil, mult: EARN_MULT });
          if (q.email)
            pool.query(
              `UPDATE jpo_players SET earn_until = to_timestamp($2 / 1000.0), updated_at = now()
                WHERE email = $1 AND (earn_until IS NULL OR earn_until < to_timestamp($2 / 1000.0))`,
              [q.email, q.earnUntil]).catch((err) => console.error("earn boost save failed:", err));
        }
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
    // Prop Hunt: object effects (brew steam, cooler chatter) render at the
    // object next to the hider — a position tell. Furniture doesn't snack.
    if (propHunt && propHunt.hiderId === socket.id) {
      socket.emit("interactError", { message: "🙈 Not while you're hiding!" });
      return;
    }
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
      if (rlglActiveRunner(socket.id)) {
        socket.emit("interactError", { message: "🚦 No brews mid-race — the doll is watching!" });
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

    } else if (Object.hasOwn(CHORE_STATIONS, object)) {
      // Office chores: small repeatable payouts with a per-person, per-CHORE
      // cooldown (stations sharing a chore share it). Everything server-side:
      // proximity was checked above, the cooldown lives here, and the coins
      // move via the same atomic relative UPDATE as the daily bonus.
      const choreId = CHORE_STATIONS[object];
      const chore = CHORES[choreId];
      const key = (p.email || socket.id) + "|" + choreId;
      const readyAt = choreReadyAt.get(key) || 0;
      if (now < readyAt) {
        const mins = Math.ceil((readyAt - now) / 60_000);
        socket.emit("interactError", { message: `${chore.emoji} Already done — this chore resets in about ${mins} min.` });
        return;
      }
      pruneCooldowns(choreReadyAt, now);
      // Claim the cooldown BEFORE the async payout so a rapid double-press
      // can't double-pay; it is ROLLED BACK (deleted) if the DB credit fails,
      // so a failed payout never eats an hour — the player just retries.
      choreReadyAt.set(key, now + chore.cooldownMs);
      const announceChore = () => {
        socket.emit("choreDone", { chore: choreId, object, pay: chore.pay, line: chore.line, emoji: chore.emoji, nextInMs: chore.cooldownMs });
        // Everyone nearby sees the worker's bubble + a burst at the station —
        // but with the same After Dark isolation as gymFx/emotes: a lit
        // outsider's chore is a position-anchored signal that must not reach
        // alive participants in the dark.
        const bubble = { id: socket.id, kind: "chore", emoji: chore.emoji };
        const burst = { effect: "chore", x: obj.x, y: obj.y - 24, emoji: chore.emoji };
        if (round && round.state === "active" && !inTheDark(socket.id)) {
          for (const pid of Object.keys(players)) if (!inTheDark(pid)) {
            io.to(pid).emit("objectEffect", bubble);
            io.to(pid).emit("groupEffect", burst);
          }
        } else {
          io.emit("objectEffect", bubble);
          io.emit("groupEffect", burst);
        }
        console.log(`${p.name} did chore '${choreId}' at ${object} (+${chore.pay} coins)`);
      };
      if (p.email) {
        pool
          .query(`UPDATE jpo_players SET coins = coins + $2, updated_at = now() WHERE email = $1 RETURNING coins`, [p.email, chore.pay])
          .then(({ rows }) => {
            if (!rows[0]) throw new Error("no player row");
            // Only adopt the returned balance if this socket is still the live
            // session (a fast refresh swaps players[socket.id] out under us) —
            // the DB credit itself already landed either way.
            if (players[socket.id] === p) {
              p.coins = rows[0].coins;
              socket.emit("coinUpdate", { coins: p.coins });
            }
            announceChore();
          })
          .catch((err) => {
            console.error("chore payout failed:", err);
            // Undo the claim (only if it's still OUR claim) so the chore stays
            // retryable — no success events were sent.
            if (choreReadyAt.get(key) === now + chore.cooldownMs) choreReadyAt.delete(key);
            socket.emit("interactError", { message: "Hmm, that didn't count — try again in a moment." });
          });
      } else {
        // Session-only players earn in-memory, same policy as the coin tick.
        p.coins = (p.coins || 0) + chore.pay;
        socket.emit("coinUpdate", { coins: p.coins });
        announceChore();
      }

    } else if (object === "arcade" || object.startsWith("pool_table") || object === "pingpong_table") {
      // Two-player game stations: the arcade opens the full game picker; the
      // Game Room tables are dedicated — billiard tables start Billiards, the
      // ping pong table starts Ping Pong. All reuse startRpsChallenge, so
      // every duel cleanup seam applies automatically.
      const station = object === "arcade" ? "arcade" : object.startsWith("pool_table") ? "pool" : "pong";
      if (inAnyMatch(socket.id)) {
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
        if (oid === socket.id || inAnyMatch(oid) || inRound(oid)) continue;
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
    if (inAnyMatch(socket.id)) { socket.emit("roundError", { message: "Finish your match first!" }); return; }
    if (grandEventIsBlockingOfficeEvents()) { socket.emit("roundError", { message: "The Pet Wars Grand Event is running!" }); return; }
    if (propHunt) { socket.emit("roundError", { message: "Hide & Seek is running — wait for it to finish!" }); return; }
    if (deal)     { socket.emit("roundError", { message: "Deal or No Deal is running — wait for the show to end!" }); return; }
    if (rlgl)     { socket.emit("roundError", { message: "Red Light Green Light is running — wait for the doll to finish!" }); return; }
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
    if (inAnyMatch(socket.id)) { socket.emit("roundError", { message: "Finish your match first!" }); return; }
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
    petBattleForfeitForLeave(socket.id);   // active pet battle → forfeit (winner +2, leaver +0)
    await raceDuelForfeit(socket.id);   // duel race: survivor wins by walkover
    // The ROUND now gets the same grace as the player: an email-backed member
    // of the ACTIVE round is marked `gone` and their spot survives until the
    // grace timer below expires (which then applies the leave rules) or a
    // resume rebinds it (restorePlayer). Everyone else leaves immediately.
    if (!roundDeferLeave(socket.id)) roundHandleLeave(socket.id);
    rlglHandleLeave(socket.id);
    // Prop Hunt: the hider leaving ends the round (nothing left to find);
    // seekers just drop out, and an empty hunt ends early.
    if (propHunt) {
      if (propHunt.hiderId === socket.id) phFinish(false, null, "hider left");
      else {
        propHunt.seekers.delete(socket.id);
        if (propHunt.state === "hunting" && propHunt.seekers.size === 0) phFinish(false, null, "seekers left");
      }
    }
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
    owners.delete(socket.id);
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
  // Idempotency ledger for race bet payouts: one row per (race settlement, bettor).
  // The credit only happens when the INSERT wins, so retrying a payout
  // transaction after an ambiguous COMMIT can never double-credit.
  // Whisper log — OWNER's eyes only, read via the owner-gated F8 panel.
  // Records every whisper (text + images) by the owner's explicit decision;
  // players are NOT notified. Pruned to the newest ~5,000 rows on write.
  await pool.query(`CREATE TABLE IF NOT EXISTS jpo_whispers (
    id         BIGSERIAL PRIMARY KEY,
    sent_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    from_email TEXT NOT NULL,
    from_name  TEXT NOT NULL,
    to_email   TEXT NOT NULL,
    to_name    TEXT NOT NULL,
    message    TEXT,
    img        TEXT
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS jpo_race_settlements (
    settle_id  TEXT NOT NULL,
    email      TEXT NOT NULL,
    amount     INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (settle_id, email)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS jpo_buddy_caps (
    day text NOT NULL,
    key text NOT NULL,
    n int NOT NULL DEFAULT 0,
    PRIMARY KEY (day, key)
  )`);
  // Yesterday's cap rows are dead weight — sweep on boot.
  await pool.query(`DELETE FROM jpo_buddy_caps WHERE day < to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')`);
  await pool.query(`CREATE TABLE IF NOT EXISTS jpo_buddies (
    week text NOT NULL,
    email text NOT NULL,
    buddy_email text NOT NULL,
    quiz_answers jsonb,
    quiz_score int,
    PRIMARY KEY (week, email)
  )`);
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
  // ── Pet Battle (Aug 2026) settlement ledger ──────────────────────────────
  // Idempotency: one row per (match_id, email). The XP credit ONLY happens
  // when this INSERT wins its row, so a retry after an ambiguous COMMIT (lost
  // ack) can never double-award — exactly the pattern jpo_race_settlements
  // uses for bet payouts. `match_id` is a server-generated opaque uuid, so a
  // client can neither forge nor replay someone else's settlement.
  await pool.query(`CREATE TABLE IF NOT EXISTS jpo_pet_battles (
    match_id   TEXT NOT NULL,
    email      TEXT NOT NULL,
    pet        TEXT NOT NULL,
    xp         INTEGER NOT NULL,
    outcome    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (match_id, email)
  )`);
  // Persistent per-pet DAILY reward cap: n battle-XP awards granted today for
  // (email, pet). Beyond PET_BATTLE_DAILY_CAP the match still resolves and is
  // fun, but grants 0 XP — stops a pair from farming XP all day. Swept on boot.
  await pool.query(`CREATE TABLE IF NOT EXISTS jpo_pet_battle_caps (
    day   text NOT NULL,
    email text NOT NULL,
    pet   text NOT NULL,
    n     int NOT NULL DEFAULT 0,
    PRIMARY KEY (day, email, pet)
  )`);
  await pool.query(`DELETE FROM jpo_pet_battle_caps WHERE day < to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')`);
  // Same-opponent cooldown: last rewarded battle time between an ordered email
  // pair (a<b). A rematch inside PET_BATTLE_REMATCH_MS still plays but grants
  // 0 XP — stops two accounts trading wins in a tight loop for free XP.
  await pool.query(`CREATE TABLE IF NOT EXISTS jpo_pet_battle_pairs (
    email_a text NOT NULL,
    email_b text NOT NULL,
    last_at timestamptz NOT NULL DEFAULT now(),
    last_match_id text,
    PRIMARY KEY (email_a, email_b)
  )`);
  await pool.query(`ALTER TABLE jpo_pet_battle_pairs ADD COLUMN IF NOT EXISTS last_match_id text`);
  // ── Pet Wars Grand Event ────────────────────────────────────────────────
  // The event row owns the durable bracket snapshot. Entry and payout rows
  // are separate transactional ledgers: a process restart can replay any
  // state transition without double-debiting or double-crediting a player.
  await pool.query(`CREATE TABLE IF NOT EXISTS jpo_grand_events (
    id              text PRIMARY KEY,
    state           text NOT NULL,
    config          jsonb NOT NULL DEFAULT '{}'::jsonb,
    snapshot        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by      text NOT NULL DEFAULT '',
    champion_email  text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS jpo_grand_event_entries (
    event_id   text NOT NULL REFERENCES jpo_grand_events(id) ON DELETE CASCADE,
    email      text NOT NULL,
    entry_fee  integer NOT NULL CHECK (entry_fee > 0),
    state      text NOT NULL,
    entrant    jsonb NOT NULL DEFAULT '{}'::jsonb,
    joined_at  timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id,email)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS jpo_grand_event_payouts (
    event_id    text NOT NULL REFERENCES jpo_grand_events(id) ON DELETE CASCADE,
    payout_key  text NOT NULL,
    email       text NOT NULL,
    amount      integer NOT NULL CHECK (amount > 0),
    kind        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id,payout_key)
  )`);
} catch (err) {
  console.error("schema nudge (coach tables) failed:", err);
}

// Fail closed if an older ledger cannot be made semantically unique. The old
// primary key included email, so two replay winners could own the same match
// payout key. Refund keys are safely normalized first; any remaining duplicate
// is a real historical conflict that needs manual reconciliation, not a row we
// can silently delete while its credited coins remain in circulation.
{
  let cl;
  try {
    cl = await pool.connect();
    await cl.query("BEGIN");
    await cl.query(
      `UPDATE jpo_grand_event_payouts
          SET payout_key='entry-refund:' || email
        WHERE kind='refund' AND payout_key='entry-refund'`,
    );
    const conflicts = await cl.query(
      `SELECT event_id,payout_key,count(*)::int AS claims
         FROM jpo_grand_event_payouts
        GROUP BY event_id,payout_key
       HAVING count(*) > 1
        LIMIT 1`,
    );
    if (conflicts.rows[0]) {
      const row = conflicts.rows[0];
      throw new Error(
        `conflicting Grand Event payout claims for ${row.event_id}/${row.payout_key} (${row.claims} recipients)`,
      );
    }
    await cl.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS jpo_grand_event_payout_once
         ON jpo_grand_event_payouts(event_id,payout_key)`,
    );
    await cl.query("COMMIT");
  } catch (err) {
    try { await cl?.query("ROLLBACK"); } catch {}
    console.error("Grand Event payout ledger is unsafe; refusing to start:", err);
    throw err;
  } finally {
    cl?.release();
  }
}

try {
  await pool.query(`ALTER TABLE jpo_players ADD COLUMN IF NOT EXISTS dismissed boolean NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE jpo_players ADD COLUMN IF NOT EXISTS avatar_changes integer NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE jpo_players ADD COLUMN IF NOT EXISTS wins jsonb NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`ALTER TABLE jpo_players ADD COLUMN IF NOT EXISTS hobby text NOT NULL DEFAULT ''`);
  // Pet accessories (July 2026): the worn accessory slot ('' = bare pet).
  // Idempotent self-heal so prod gets the column on first boot after deploy.
  await pool.query(`ALTER TABLE jpo_players ADD COLUMN IF NOT EXISTS equipped_pet_acc text NOT NULL DEFAULT ''`);
  // Pet evolution: per-pet treat XP, keyed by pet id ({"pet_cat": 12, ...}).
  await pool.query(`ALTER TABLE jpo_players ADD COLUMN IF NOT EXISTS pet_xp jsonb NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`ALTER TABLE jpo_players ADD COLUMN IF NOT EXISTS pet_names jsonb NOT NULL DEFAULT '{}'::jsonb`);
  // Pet Battle training builds (Aug 2026): per-pet stat allocations, keyed by
  // pet id. Idempotent self-heal so prod gets the column on first boot.
  await pool.query(`ALTER TABLE jpo_players ADD COLUMN IF NOT EXISTS pet_builds jsonb NOT NULL DEFAULT '{}'::jsonb`);
  // Wings slot (Aug 2026): separate from equipped_cosmetic so wings + a
  // wearable can be worn together. One-time self-healing migration: anyone
  // whose old single slot holds wings gets them moved to the new slot.
  await pool.query(`ALTER TABLE jpo_players ADD COLUMN IF NOT EXISTS equipped_wings text NOT NULL DEFAULT ''`);
  // Outfit slots (Aug 2026): head stays in the legacy equipped_cosmetic
  // column; new body wearables live in per-slot columns so a hat + raincoat +
  // boots + umbrella can all be worn at once (see WEAR_SLOT / SLOT_COL).
  // Idempotent self-heal — prod gets these on first boot after publish.
  await pool.query(`ALTER TABLE jpo_players ADD COLUMN IF NOT EXISTS equipped_top text NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE jpo_players ADD COLUMN IF NOT EXISTS equipped_bottom text NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE jpo_players ADD COLUMN IF NOT EXISTS equipped_neckwear text NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE jpo_players ADD COLUMN IF NOT EXISTS equipped_held text NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE jpo_players ADD COLUMN IF NOT EXISTS equipped_feet text NOT NULL DEFAULT ''`);
  // Boots moved from the bottom slot to their own feet slot (Aug 2026) so a
  // future pants item and footwear never fight over one column. Idempotent.
  await pool.query(`UPDATE jpo_players SET equipped_feet = 'rainboots', equipped_bottom = '' WHERE equipped_bottom = 'rainboots'`);
  await pool.query(
    `UPDATE jpo_players SET equipped_wings = equipped_cosmetic, equipped_cosmetic = ''
      WHERE equipped_cosmetic = ANY($1) AND equipped_wings = ''`,
    [[...WINGS_IDS]],
  );
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
// Admin activity log: every F8 mutation with who/what/when.
try {
  await pool.query(`CREATE TABLE IF NOT EXISTS jpo_admin_log (
    id serial PRIMARY KEY,
    admin_name text NOT NULL,
    action text NOT NULL,
    detail text NOT NULL DEFAULT '',
    ts timestamptz NOT NULL DEFAULT now()
  )`);
} catch (err) {
  console.error("schema nudge (admin log) failed:", err);
}
try {
  // Lingering gift receipts — one row per undismissed "X sent you N coins".
  await pool.query(`CREATE TABLE IF NOT EXISTS jpo_gift_notices (
    id serial PRIMARY KEY,
    email text NOT NULL,
    from_name text NOT NULL,
    amount integer NOT NULL,
    ts timestamptz NOT NULL DEFAULT now()
  )`);
} catch (err) {
  console.error("schema nudge (gift notices) failed:", err);
}
try {
  // Shared-treat earnings buff expiry — persisted so refreshes/restarts
  // can't eat a paid 10–20 minute buff.
  await pool.query(`ALTER TABLE jpo_players ADD COLUMN IF NOT EXISTS earn_until timestamptz`);
} catch (err) {
  console.error("schema nudge (earn_until) failed:", err);
}
try {
  await pool.query(`CREATE TABLE IF NOT EXISTS jpo_shop_prices (
    item_id text PRIMARY KEY,
    price integer NOT NULL
  )`);
  // Self-heal: rare pets are gift-only with no price — purge any legacy
  // override rows (e.g. the old 55,000 unicorn) so panel/catalog stay honest.
  // Runs at boot so it also heals prod on the next publish (prod DB is
  // never edited by hand).
  // Owner price-change alerts: every price change by a NON-owner is recorded
  // here and stays unseen until the owner dismisses it in-game. Survives
  // restarts, so a change made while the owner is offline still screams at
  // him on his next login.
  await pool.query(`CREATE TABLE IF NOT EXISTS jpo_price_alerts (
    id serial PRIMARY KEY,
    item_id text NOT NULL,
    old_price integer,
    new_price integer NOT NULL,
    changed_by text NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT now(),
    seen boolean NOT NULL DEFAULT false
  )`);
  await pool.query(`DELETE FROM jpo_shop_prices WHERE item_id = ANY($1)`, [[...RARE_IDS]]);
  const { rows } = await pool.query(`SELECT item_id, price FROM jpo_shop_prices`);
  for (const r of rows) {
    const cat = catalogOf(r.item_id);
    if (cat && Number.isInteger(r.price) && r.price >= PRICE_MIN && r.price <= PRICE_MAX) {
      cat[r.item_id] = r.price;
      console.log(`price override: ${r.item_id} → ${r.price}`);
    }
  }
  // HR daily COD quiz: one row per (day,email). `solved` flips exactly once
  // (conditional UPDATE), so a restart or replayed answer can never double-pay.
  await pool.query(`CREATE TABLE IF NOT EXISTS jpo_cod_quiz (
    day text NOT NULL,
    email text NOT NULL,
    qid integer NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    solved boolean NOT NULL DEFAULT FALSE,
    paid integer NOT NULL DEFAULT 0,
    PRIMARY KEY (day, email)
  )`);
  // Flash sale survives restarts: single-row table, re-armed at boot if the
  // end time is still in the future (otherwise cleaned up).
  await pool.query(`CREATE TABLE IF NOT EXISTS jpo_flash_sale (
    id integer PRIMARY KEY CHECK (id = 1),
    percent integer NOT NULL,
    ends_at timestamptz NOT NULL
  )`);
  const saleRows = (await pool.query(`SELECT percent, ends_at FROM jpo_flash_sale WHERE id = 1`)).rows;
  if (saleRows.length) {
    const endsAt = new Date(saleRows[0].ends_at).getTime();
    const pct = saleRows[0].percent;
    if (endsAt > Date.now() && pct >= SALE_PCT_MIN && pct <= SALE_PCT_MAX) {
      _armSale(pct, endsAt);
      console.log(`flash sale resumed: ${pct}% off until ${new Date(endsAt).toISOString()}`);
    } else {
      await pool.query(`DELETE FROM jpo_flash_sale`);
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

try {
  await grandEventRestoreFromDb();
} catch (err) {
  // The rest of the office remains available if the tournament tables are
  // temporarily unreachable, but log loudly: no in-memory fallback may mint
  // or lose entry coins.
  console.error("Grand Event restore failed:", err);
}

const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
  console.log(`JPO Huddle server running on port ${port}`);
});
