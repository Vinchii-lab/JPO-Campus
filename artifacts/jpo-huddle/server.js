import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import path from "path";
import { readFileSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";  // no insecure default: admin features stay disabled until this env/secret is set
const BUILD_STAMP = Date.now();

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

const pending = {};   // socketId → { firstName, lastName, email, character, name, hairIdx, skinIdx, shirtIdx, pantsIdx }
const players = {};   // socketId → full player state
const admins  = new Set();

const announcements = [];   // newest-first: { id, name, text, ts, board } — board = which individual board cluster it was posted to
let announcementSeq = 0;
const announcers = new Set();   // emails an admin has designated as allowed to post announcements

const SHOP = { crown: 30 };

function clampIdx(v, max) {
  return (Number.isInteger(v) && v >= 0 && v <= max) ? v : 0;
}

// Max valid shirt/trouser colour index. MUST equal client CLOTH_COLORS.length - 1 in public/index.html.
const CLOTH_MAX = 22;

// Passive coin earning: +2 coins per minute per active player
setInterval(() => {
  for (const id in players) {
    players[id].coins = (players[id].coins || 0) + 2;
    io.to(id).emit("coinUpdate", { coins: players[id].coins });
  }
}, 60_000);

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  // Send the current announcement board to every new connection.
  socket.emit("announcements", announcements);

  // ── Registration ─────────────────────────────────────────────────────
  socket.on("register", ({ firstName, lastName, email, character, hairIdx, skinIdx, shirtIdx, pantsIdx, clothesIdx }) => {
    const fn   = (firstName || "").trim().slice(0, 20) || "Guest";
    const ln   = (lastName  || "").trim().slice(0, 20);
    const em   = (email     || "").trim().slice(0, 80);
    const char = ["adam","alex","amelia","bob"].includes(character) ? character : "adam";
    const name = ln ? `${fn} ${ln}` : fn;

    pending[socket.id] = {
      firstName: fn, lastName: ln, email: em, character: char, name,
      hairIdx:  clampIdx(hairIdx, 8),
      skinIdx:  clampIdx(skinIdx, 6),
      // Legacy clients send a single clothesIdx for both — fall back to it when split fields are absent.
      shirtIdx: clampIdx(shirtIdx ?? clothesIdx, CLOTH_MAX),
      pantsIdx: clampIdx(pantsIdx ?? clothesIdx, CLOTH_MAX),
    };
    socket.emit("registrationPending");
    _notifyAdmins();
    console.log(`Pending: ${name} <${em}>`);
  });

  // ── Admin auth ───────────────────────────────────────────────────────
  socket.on("adminAuth", ({ password }) => {
    if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) { socket.emit("adminAuthFail"); return; }
    admins.add(socket.id);
    socket.emit("adminAuthOk");
    socket.emit("pendingList", _pendingList());
    socket.emit("playerList",  _playerList());
  });

  socket.on("approvePlayer", (targetId) => {
    if (!admins.has(socket.id)) return;
    const reg = pending[targetId];
    if (!reg) return;
    delete pending[targetId];

    players[targetId] = {
      x: 1080, y: 840, dir: "down", anim: "idle",
      name:       reg.name,
      email:      reg.email,
      character:  reg.character,
      hairIdx:  reg.hairIdx,
      skinIdx:  reg.skinIdx,
      shirtIdx: reg.shirtIdx,
      pantsIdx: reg.pantsIdx,
      coins: 50,
      cosmetics: [],
    };

    io.to(targetId).emit("approved", {
      name: reg.name, character: reg.character,
      hairIdx: reg.hairIdx, skinIdx: reg.skinIdx, shirtIdx: reg.shirtIdx, pantsIdx: reg.pantsIdx,
      coins: 50,
    });
    io.to(targetId).emit("currentPlayers", players);
    io.to(targetId).emit("announcerStatus", { canPost: !!reg.email && announcers.has(reg.email) });

    for (const pid in players) {
      if (pid !== targetId) {
        io.to(pid).emit("playerJoined", { id: targetId, ...players[targetId] });
      }
    }

    _notifyAdmins();
    console.log(`Approved: ${reg.name}`);
  });

  socket.on("rejectPlayer", (targetId) => {
    if (!admins.has(socket.id)) return;
    const reg = pending[targetId];
    if (reg) delete pending[targetId];
    io.to(targetId).emit("rejected");
    _notifyAdmins();
    console.log(`Rejected: ${reg?.name}`);
  });

  socket.on("kickPlayer", (targetId) => {
    if (!admins.has(socket.id)) return;
    const p = players[targetId];
    if (!p) return;
    delete players[targetId];
    io.to(targetId).emit("kicked");
    socket.broadcast.emit("playerLeft", { id: targetId });
    _notifyAdmins();
    console.log(`Kicked: ${p.name}`);
  });

  // Admin designates (or revokes) a player as an announcer — keyed by email so it
  // survives that person reconnecting during this server session.
  socket.on("setAnnouncer", ({ targetId, canPost }) => {
    if (!admins.has(socket.id)) return;
    const p = players[targetId];
    if (!p || !p.email) return;
    if (canPost) announcers.add(p.email); else announcers.delete(p.email);
    io.to(targetId).emit("announcerStatus", { canPost: !!canPost });
    _notifyAdmins();
    console.log(`Announcer ${canPost ? "granted" : "revoked"}: ${p.name}`);
  });

  // ── Game events ──────────────────────────────────────────────────────
  socket.on("playerMove", (data) => {
    if (!players[socket.id]) return;
    Object.assign(players[socket.id], { x: data.x, y: data.y, dir: data.dir, anim: data.anim });
    socket.broadcast.emit("playerMoved", { id: socket.id, ...players[socket.id] });
  });

  socket.on("chatMessage", ({ message }) => {
    if (!players[socket.id]) return;
    const text = (message || "").trim().slice(0, 120);
    if (!text) return;
    io.emit("chatMessage", { id: socket.id, name: players[socket.id].name, message: text });
  });

  // ── Announcements (admin-only posting, broadcast to everyone) ─────────
  socket.on("postAnnouncement", ({ text, board }) => {
    const p = players[socket.id];
    const canPost = admins.has(socket.id) || !!(p && p.email && announcers.has(p.email));
    if (!canPost) return;
    const clean = (text || "").trim().slice(0, 280);
    if (!clean) return;
    // Which individual board this belongs to (the client posts from the board it's standing at).
    const boardId = (board || "").toString().trim().slice(0, 40) || "office";
    const name = p?.name || "Admin";
    announcements.unshift({ id: `a${++announcementSeq}`, name, text: clean, ts: Date.now(), board: boardId });
    if (announcements.length > 50) announcements.length = 50;
    io.emit("announcementsUpdate", announcements);
    console.log(`Announcement by ${name} [${boardId}]: ${clean.slice(0, 40)}`);
  });

  socket.on("deleteAnnouncement", ({ id }) => {
    if (!admins.has(socket.id)) return;
    const idx = announcements.findIndex((a) => a.id === id);
    if (idx !== -1) {
      announcements.splice(idx, 1);
      io.emit("announcementsUpdate", announcements);
    }
  });

  socket.on("buyCosmetic", ({ item }) => {
    const p = players[socket.id], cost = SHOP[item];
    if (!p || !cost) return;
    if (p.cosmetics.includes(item)) { socket.emit("shopError", "Already owned!"); return; }
    if (p.coins < cost) { socket.emit("shopError", "Not enough coins!"); return; }
    p.coins -= cost;
    p.cosmetics.push(item);
    socket.emit("coinUpdate",  { coins: p.coins });
    socket.emit("shopSuccess", { item });
    io.emit("playerCosmeticUpdate", { id: socket.id, cosmetics: p.cosmetics });
    console.log(`${p.name} bought ${item}`);
  });

  // ── Disconnect ───────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    if (pending[socket.id]) {
      console.log(`Pending disconnected: ${pending[socket.id].name}`);
      delete pending[socket.id];
    }
    if (players[socket.id]) {
      console.log(`${players[socket.id].name} left`);
      delete players[socket.id];
      io.emit("playerLeft", socket.id);
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
    email: p.email || "", isAnnouncer: !!(p.email && announcers.has(p.email)),
  }));
}

const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
  console.log(`JPO Huddle server running on port ${port}`);
});
