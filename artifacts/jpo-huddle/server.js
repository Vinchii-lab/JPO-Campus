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

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("Player disconnected");
  });
});

const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
  console.log(`JPO Huddle server running on port ${port}`);
});
