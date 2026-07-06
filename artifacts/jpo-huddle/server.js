import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import path from "path";
import { readFileSync } from "fs";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";  // no insecure default: admin features stay disabled until this env/secret is set
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

const SHOP = { crown: 30 };

function clampIdx(v, max) {
  return (Number.isInteger(v) && v >= 0 && v <= max) ? v : 0;
}

// Max valid shirt/trouser colour index. MUST equal client CLOTH_COLORS.length - 1 in public/index.html.
const CLOTH_MAX = 22;

// ── DB helpers ───────────────────────────────────────────────────────────────

// Map a jpo_players row (snake_case columns) to the in-memory / client-facing
// player state shape (camelCase).
function rowToPlayerState(row) {
  return {
    x: row.x, y: row.y, dir: row.dir, anim: "idle",
    name:      row.name,
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
       (email, first_name, last_name, name, character, hair_idx, skin_idx, shirt_idx, pants_idx)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (email) DO UPDATE SET
       first_name = EXCLUDED.first_name,
       last_name  = EXCLUDED.last_name,
       name       = EXCLUDED.name,
       character  = EXCLUDED.character,
       hair_idx   = EXCLUDED.hair_idx,
       skin_idx   = EXCLUDED.skin_idx,
       shirt_idx  = EXCLUDED.shirt_idx,
       pants_idx  = EXCLUDED.pants_idx,
       updated_at = now()
     RETURNING *`,
    [reg.email, reg.firstName, reg.lastName, reg.name, reg.character,
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

// Put a socket into the office from a durable jpo_players row: cache it live and
// send the client everything it needs to render. Used both when an admin
// approves someone and when an already-approved email reconnects. The identity
// gate that decides *who* gets restored lives in the register handler — the
// reconnection-token task will swap the email check there for a token check.
async function restorePlayer(socket, row) {
  const state = rowToPlayerState(row);
  players[socket.id] = state;

  socket.emit("approved", {
    name:      state.name,
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
              SET coins = coins + 2, x = $2, y = $3, dir = $4, updated_at = now()
            WHERE email = $1
            RETURNING coins`,
          [p.email, Math.round(p.x ?? 1080), Math.round(p.y ?? 840), p.dir || "down"],
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

  // Send the current announcement board to every new connection.
  fetchAnnouncements()
    .then((a) => socket.emit("announcements", a))
    .catch((err) => console.error("announcements load failed:", err));

  // ── Registration ─────────────────────────────────────────────────────
  socket.on("register", async (payload) => {
    try {
      const { firstName, lastName, email, character, hairIdx, skinIdx, shirtIdx, pantsIdx, clothesIdx } = payload || {};
      const fn   = (firstName || "").trim().slice(0, 20) || "Guest";
      const ln   = (lastName  || "").trim().slice(0, 20);
      const em   = (email     || "").trim().slice(0, 80).toLowerCase();
      const char = ["adam","alex","amelia","bob"].includes(character) ? character : "adam";
      const name = ln ? `${fn} ${ln}` : fn;

      const reg = {
        firstName: fn, lastName: ln, email: em, character: char, name,
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

      // One live session per email.
      dropLiveByEmail(em, socket.id);

      const row = await upsertPlayerProfile(reg);

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
      socket.emit("registrationPending");
    }
  });

  // ── Admin auth ───────────────────────────────────────────────────────
  socket.on("adminAuth", ({ password }) => {
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
          name: reg.name, email: "", character: reg.character,
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
  socket.on("setAnnouncer", async ({ targetId, canPost }) => {
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

  // ── Game events ──────────────────────────────────────────────────────
  socket.on("playerMove", (data) => {
    const me = players[socket.id];
    if (!me || !data) return;
    // Validate coords: they're written to integer columns on the coin tick /
    // disconnect, so a non-finite or absurd value would throw there every time.
    const x = Number(data.x), y = Number(data.y);
    if (Number.isFinite(x)) me.x = Math.max(-100000, Math.min(100000, x));
    if (Number.isFinite(y)) me.y = Math.max(-100000, Math.min(100000, y));
    if (typeof data.dir === "string") me.dir = data.dir;
    me.anim = data.anim;
    socket.broadcast.emit("playerMoved", { id: socket.id, ...me });
  });

  socket.on("chatMessage", ({ message }) => {
    if (!players[socket.id]) return;
    const text = (message || "").trim().slice(0, 120);
    if (!text) return;
    io.emit("chatMessage", { id: socket.id, name: players[socket.id].name, message: text });
  });

  // ── Announcements (admin / designated announcers post, broadcast to all) ──
  socket.on("postAnnouncement", async ({ text, board }) => {
    const p = players[socket.id];
    const canPost = admins.has(socket.id) || !!(p && p.isAnnouncer);
    if (!canPost) return;
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

  socket.on("deleteAnnouncement", async ({ id }) => {
    if (!admins.has(socket.id)) return;
    const numId = parseInt(id, 10);
    if (!Number.isInteger(numId)) return;
    try {
      await pool.query(`DELETE FROM jpo_announcements WHERE id = $1`, [numId]);
      io.emit("announcementsUpdate", await fetchAnnouncements());
    } catch (err) { console.error("deleteAnnouncement failed:", err); }
  });

  socket.on("buyCosmetic", async ({ item }) => {
    const p = players[socket.id], cost = SHOP[item];
    if (!p || !cost) return;

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
      console.log(`${p.name} left`);
      delete players[socket.id];
      io.emit("playerLeft", socket.id);
      // Flush final position so they resume near where they left off.
      if (p.email) {
        try {
          await pool.query(
            `UPDATE jpo_players SET x = $2, y = $3, dir = $4, updated_at = now() WHERE email = $1`,
            [p.email, Math.round(p.x ?? 1080), Math.round(p.y ?? 840), p.dir || "down"],
          );
        } catch (err) { console.error("disconnect flush failed:", err); }
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
  return Object.entries(pending).map(([id, p]) => ({ id, name: p.name, email: p.email, character: p.character }));
}

function _playerList() {
  return Object.entries(players).map(([id, p]) => ({
    id, name: p.name, coins: p.coins, cosmetics: p.cosmetics,
    email: p.email || "", isAnnouncer: !!p.isAnnouncer,
  }));
}

const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
  console.log(`JPO Huddle server running on port ${port}`);
});
