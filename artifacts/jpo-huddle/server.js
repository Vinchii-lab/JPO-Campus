import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "jpo-admin";

const app        = express();
const httpServer = createServer(app);
const io         = new Server(httpServer);

app.use(express.static(path.join(__dirname, "public")));

const pending = {};   // socketId → { firstName, lastName, email, character, name, hairIdx, skinIdx, shirtIdx, pantsIdx }
const players = {};   // socketId → full player state
const admins  = new Set();

const SHOP = { crown: 30 };

function clampIdx(v, max) {
  return (Number.isInteger(v) && v >= 0 && v <= max) ? v : 0;
}

// Passive coin earning: +2 coins per minute per active player
setInterval(() => {
  for (const id in players) {
    players[id].coins = (players[id].coins || 0) + 2;
    io.to(id).emit("coinUpdate", { coins: players[id].coins });
  }
}, 60_000);

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  // ── Registration ─────────────────────────────────────────────────────
  socket.on("register", ({ firstName, lastName, email, character, hairIdx, skinIdx, shirtIdx, pantsIdx }) => {
    const fn   = (firstName || "").trim().slice(0, 20) || "Guest";
    const ln   = (lastName  || "").trim().slice(0, 20);
    const em   = (email     || "").trim().slice(0, 80);
    const char = ["adam","alex","amelia","bob"].includes(character) ? character : "adam";
    const name = ln ? `${fn} ${ln}` : fn;

    pending[socket.id] = {
      firstName: fn, lastName: ln, email: em, character: char, name,
      hairIdx:  clampIdx(hairIdx,  8),
      skinIdx:  clampIdx(skinIdx,  6),
      shirtIdx: clampIdx(shirtIdx, 8),
      pantsIdx: clampIdx(pantsIdx, 8),
    };
    socket.emit("registrationPending");
    _notifyAdmins();
    console.log(`Pending: ${name} <${em}>`);
  });

  // ── Admin auth ───────────────────────────────────────────────────────
  socket.on("adminAuth", ({ password }) => {
    if (password !== ADMIN_PASSWORD) { socket.emit("adminAuthFail"); return; }
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
      x: 1080, y: 840, flipX: false, anim: "idle",
      name:      reg.name,
      character: reg.character,
      hairIdx:   reg.hairIdx,
      skinIdx:   reg.skinIdx,
      shirtIdx:  reg.shirtIdx,
      pantsIdx:  reg.pantsIdx,
      coins: 50,
      cosmetics: [],
    };

    io.to(targetId).emit("approved", {
      name: reg.name, character: reg.character,
      hairIdx:  reg.hairIdx,  skinIdx:  reg.skinIdx,
      shirtIdx: reg.shirtIdx, pantsIdx: reg.pantsIdx,
      coins: 50,
    });
    io.to(targetId).emit("currentPlayers", players);

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

  // ── Game events ──────────────────────────────────────────────────────
  socket.on("playerMove", (data) => {
    if (!players[socket.id]) return;
    Object.assign(players[socket.id], { x: data.x, y: data.y, flipX: data.flipX, anim: data.anim });
    socket.broadcast.emit("playerMoved", { id: socket.id, ...players[socket.id] });
  });

  socket.on("chatMessage", ({ message }) => {
    if (!players[socket.id]) return;
    const text = (message || "").trim().slice(0, 120);
    if (!text) return;
    io.emit("chatMessage", { id: socket.id, name: players[socket.id].name, message: text });
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
  return Object.entries(players).map(([id, p]) => ({ id, name: p.name, coins: p.coins, cosmetics: p.cosmetics }));
}

const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
  console.log(`JPO Huddle server running on port ${port}`);
});
