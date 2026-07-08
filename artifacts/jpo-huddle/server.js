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

const SHOP = { crown: 30 };

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
const { WORLD_W, WORLD_H } = (() => {
  try {
    const tmj = JSON.parse(readFileSync(path.join(__dirname, "public", "assets", "Office.tmj"), "utf8"));
    const w = tmj.width * tmj.tilewidth * RENDER_SCALE;
    const h = tmj.height * tmj.tileheight * RENDER_SCALE;
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { WORLD_W: w, WORLD_H: h };
  } catch (err) {
    console.error("map bounds load failed, using fallback:", err);
  }
  return { WORLD_W: 3024, WORLD_H: 1728 };  // 63×36 tiles · 16px · scale 3
})();

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
    isAnnouncer: row.is_announcer,
  };
}

// Upsert a person's profile on registration, keyed by email. Existing rows keep
// their coins / cosmetics / approved / announcer status — only the editable
// profile fields (name, character, appearance) are refreshed.
async function upsertPlayerProfile(reg) {
  const { rows } = await pool.query(
    `INSERT INTO jpo_players
       (email, first_name, last_name, name, nickname, character, hair_idx, skin_idx, shirt_idx, pants_idx)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
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
       updated_at = now()
     RETURNING *`,
    [reg.email, reg.firstName, reg.lastName, reg.name, reg.nickname, reg.character,
     reg.hairIdx, reg.skinIdx, reg.shirtIdx, reg.pantsIdx],
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
}

// Passive coin earning (+2/min per active player). We also flush each
// email-backed player's position in the same tick, so movement never triggers a
// per-move DB write. Coins are incremented atomically in SQL and read back, so
// concurrent purchases can't lose or double-count.
setInterval(async () => {
  for (const id in players) {
    const p = players[id];
    if (p.email) {
      try {
        const { rows } = await pool.query(
          `UPDATE jpo_players
              SET coins = coins + 2, x = $2, y = $3, dir = $4, anim = $5, updated_at = now()
            WHERE email = $1
            RETURNING coins`,
          [p.email, Math.round(p.x ?? 1080), Math.round(p.y ?? 840), p.dir || "down", p.anim === "sit" ? "sit" : "idle"],
        );
        if (rows[0]) p.coins = rows[0].coins;
      } catch (err) {
        console.error("coin/position tick failed:", err);
        p.coins = (p.coins || 0) + 2;
      }
    } else {
      p.coins = (p.coins || 0) + 2;
    }
    io.to(id).emit("coinUpdate", { coins: p.coins });
  }
}, 60_000);

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  // Per-connection rate-limit state — closed over by the handlers below and
  // GC'd with the socket on disconnect (no global map to clean up).
  const chatBucket  = makeBucket(5, 700);   // ~1.4 msgs/s sustained, burst of 5
  const buyBucket   = makeBucket(3, 500);   // guards rapid buy-spam / double-clicks
  const postBucket  = makeBucket(3, 1000);  // guards announcement spam
  const emoteBucket = makeBucket(4, 900);   // ~1 emote/s sustained, burst of 4
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
      const { firstName, lastName, nickname, email, password, character, hairIdx, skinIdx, shirtIdx, pantsIdx, clothesIdx } = payload || {};
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
          coins: 50, cosmetics: [], isAnnouncer: false,
        };
        players[targetId] = state;
        io.to(targetId).emit("approved", {
          name: state.name, character: state.character,
          hairIdx: state.hairIdx, skinIdx: state.skinIdx, shirtIdx: state.shirtIdx, pantsIdx: state.pantsIdx,
          coins: state.coins, cosmetics: state.cosmetics,
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
    const now = Date.now();
    if (now - lastMoveAt < MOVE_MIN_INTERVAL_MS) return;

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
      const maxDist = MOVE_SPEED * elapsed * MOVE_SPEED_TOLERANCE + MOVE_JITTER_PX + snapBonus;
      const dx = x - me.x, dy = y - me.y;
      if (dx * dx + dy * dy > maxDist * maxDist) return;   // teleport / speed hack (silently dropped)
    }

    me.x = x; me.y = y;
    if (typeof data.dir === "string") me.dir = data.dir;
    me.anim = data.anim;
    wasSitting = sitting;
    lastMoveAt = now;
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

    // Session-only players (no email): memory-only purchase.
    if (!p.email) {
      if (p.cosmetics.includes(item)) { socket.emit("shopError", "Already owned!"); return; }
      if (p.coins < cost) { socket.emit("shopError", "Not enough coins!"); return; }
      p.coins -= cost;
      p.cosmetics.push(item);
      socket.emit("coinUpdate",  { coins: p.coins });
      socket.emit("shopSuccess", { item });
      io.emit("playerCosmeticUpdate", { id: socket.id, cosmetics: p.cosmetics });
      console.log(`${p.name} bought ${item} (session-only)`);
      return;
    }

    try {
      // One atomic statement guards both "enough coins" and "not already owned",
      // so a coin tick or a double-click can't produce an inconsistent balance.
      const { rows } = await pool.query(
        `UPDATE jpo_players
            SET coins = coins - $2,
                cosmetics = array_append(cosmetics, $3),
                updated_at = now()
          WHERE email = $1 AND coins >= $2 AND NOT ($3 = ANY(cosmetics))
          RETURNING coins, cosmetics`,
        [p.email, cost, item],
      );
      if (rows.length === 0) {
        if (p.cosmetics.includes(item)) socket.emit("shopError", "Already owned!");
        else socket.emit("shopError", "Not enough coins!");
        return;
      }
      p.coins = rows[0].coins;
      p.cosmetics = rows[0].cosmetics || [];
      socket.emit("coinUpdate",  { coins: p.coins });
      socket.emit("shopSuccess", { item });
      io.emit("playerCosmeticUpdate", { id: socket.id, cosmetics: p.cosmetics });
      console.log(`${p.name} bought ${item}`);
    } catch (err) { console.error("buyCosmetic failed:", err); }
  });

  // ── Disconnect ───────────────────────────────────────────────────────
  socket.on("disconnect", async () => {
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
    email: p.email || "", isAnnouncer: !!p.isAnnouncer,
  }));
}

const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
  console.log(`JPO Huddle server running on port ${port}`);
});
