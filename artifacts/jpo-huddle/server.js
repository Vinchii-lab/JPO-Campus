import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, "public")));

const players = {};

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("playerInit", ({ name, character }) => {
    const safeName = (name || "Guest").trim().slice(0, 24) || "Guest";
    players[socket.id] = {
      x: 1080, y: 840,
      flipX: false,
      anim: "idle",
      name: safeName,
      character,
    };
    socket.emit("currentPlayers", players);
    socket.broadcast.emit("playerJoined", { id: socket.id, ...players[socket.id] });
    console.log(`${safeName} (${character}) joined`);
  });

  socket.on("playerMove", (data) => {
    if (!players[socket.id]) return;
    players[socket.id].x     = data.x;
    players[socket.id].y     = data.y;
    players[socket.id].flipX = data.flipX;
    players[socket.id].anim  = data.anim;
    socket.broadcast.emit("playerMoved", { id: socket.id, ...players[socket.id] });
  });

  socket.on("disconnect", () => {
    if (!players[socket.id]) return;
    console.log(`${players[socket.id].name} left`);
    delete players[socket.id];
    io.emit("playerLeft", socket.id);
  });
});

const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
  console.log(`JPO Huddle server running on port ${port}`);
});
