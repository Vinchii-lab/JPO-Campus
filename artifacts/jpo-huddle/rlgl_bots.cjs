// RLGL test bots — fake coworkers who hang around the office and play
// Red Light Green Light whenever someone starts it (F8 → Events).
// Run via the "RLGL Test Bots" workflow. They log in as *@test.local accounts.
const { io } = require("socket.io-client");
const URL = "http://localhost:" + (process.env.JPO_PORT || 20158);
const PW = "rlglbotpw123";

// Personalities:
//  jitter    — ms of reaction delay after RED LIGHT (grace is 700ms, so the
//              sloppy ones sometimes stop too late and DIE)
//  twitch    — chance per tick of nervously moving during red (death wish)
//  speed     — px/s while running (server walk speed is 195)
//  shover    — hunts the nearest runner (including YOU) and pushes them
const BOTS = [
  { name: "Jepoy Bot",   email: "botjepoy@test.local",   jitter: [500, 900], twitch: 0.012, speed: 165, shover: false },
  { name: "Marites Bot", email: "botmarites@test.local", jitter: [150, 400], twitch: 0,     speed: 150, shover: true  },
  { name: "Dodong Bot",  email: "botdodong@test.local",  jitter: [100, 300], twitch: 0.002, speed: 180, shover: false },
  { name: "Inday Bot",   email: "botinday@test.local",   jitter: [200, 500], twitch: 0.004, speed: 130, shover: false },
];

const TICK = 120;
const rnd = (a, b) => a + Math.random() * (b - a);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function mkBot(cfg) {
  const s = io(URL, { transports: ["websocket"], reconnection: true, reconnectionDelay: 2000 });
  const b = { ...cfg, s, x: 0, y: 0, alive: false, fin: false, light: "green", redAt: 0,
              stopAt: 0, arena: null, bounds: null, finishY: 0, others: {}, myId: null, lastPush: 0, wobble: 0 };

  s.on("buildStamp", () => s.emit("clientBuild"));
  s.on("connect", () => s.emit("login", { email: cfg.email, password: PW }));
  s.on("approved", () => { b.myId = s.id; log(cfg.name, "in the office"); });
  s.on("loginFail", (d) => log(cfg.name, "login failed:", JSON.stringify(d)));

  s.on("rlglLobby", () => setTimeout(() => s.emit("rlglJoin"), rnd(400, 2500)));
  s.on("rlglTeleport", (d) => { b.x = d.x; b.y = d.y; });
  s.on("playerMoved", (d) => { if (d && d.id && d.id !== b.myId) b.others[d.id] = { x: d.x, y: d.y, name: d.name }; });
  s.on("playerLeft", (id) => delete b.others[id]);
  s.on("rlglBegin", (d) => {
    b.arena = d.arena; b.bounds = d.bounds || d.arena; b.finishY = d.finishY;
    b.roster = {};
    for (const p of d.players || []) b.roster[p.id] = p.alive && !p.finished;
    b.alive = !!b.roster[b.myId]; b.fin = false; b.light = d.light || "green"; b.stopAt = 0;
    log(cfg.name, "attempt", d.attempt, b.alive ? "RUNNING" : "(spectating)");
  });
  s.on("rlglLight", (d) => {
    b.light = d.light;
    if (d.light === "red") { b.redAt = Date.now(); b.stopAt = Date.now() + rnd(b.jitter[0], b.jitter[1]); }
  });
  s.on("rlglOut", (d) => { if (b.roster) b.roster[d.id] = false; if (d.id === b.myId) { b.alive = false; log(cfg.name, "OUT:", d.cause); } });
  s.on("rlglFinished", (d) => { if (b.roster) b.roster[d.id] = false; if (d.id === b.myId) { b.fin = true; log(cfg.name, "FINISHED! 🏁"); } });
  s.on("rlglPushed", (d) => { if (d.id === b.myId) { b.x = d.x; b.y = d.y; } });
  s.on("rlglRound", () => { b.alive = false; b.fin = false; });   // wait for next rlglBegin
  s.on("rlglReplay", () => { b.alive = false; b.fin = false; });
  s.on("rlglEnd", () => { b.alive = false; b.fin = false; });
  s.on("rlglCancelled", () => { b.alive = false; b.fin = false; });

  setInterval(() => {
    if (!b.alive || b.fin || !b.arena) return;
    const now = Date.now();
    const step = (b.speed * TICK) / 1000;
    // Vertical lawn track: forward = +y (downhill), wobble = x, clamped to
    // the phase's legal strip so bots never step off the narrow path.
    const move = (fwd, side) => {
      b.y = Math.min(b.finishY + 30, b.y + fwd);
      b.x = Math.max(b.bounds.x0 + 25, Math.min(b.bounds.x1 - 25, b.x + side));
      s.emit("playerMove", { x: b.x, y: b.y, dir: "down", anim: "run" });
    };
    if (b.light === "green") {
      b.wobble += rnd(-0.4, 0.4);
      b.wobble = Math.max(-0.5, Math.min(0.5, b.wobble));
      // Marites hunts: drift toward the nearest live runner, shove when close.
      if (b.shover && now - b.lastPush > 5200) {
        let best = null, bd = Infinity;
        for (const id in b.others) {
          if (!b.roster || !b.roster[id]) continue;
          const o = b.others[id], dd = (o.x - b.x) ** 2 + (o.y - b.y) ** 2;
          if (dd < bd) { bd = dd; best = { id, ...o }; }
        }
        if (best && bd <= 65 * 65) { b.lastPush = now; s.emit("rlglPush", { targetId: best.id }); log(cfg.name, "SHOVES", best.name || best.id); return; }
        if (best && bd < 400 * 400) {
          const len = Math.sqrt(bd) || 1;
          move(((best.y - b.y) / len) * step, ((best.x - b.x) / len) * step);
          return;
        }
      }
      move(step, b.wobble * step);
    } else {
      // RED: keep "running" until this bot's reaction time elapses…
      if (now < b.stopAt) { move(step, 0); return; }
      // …then freeze, apart from the occasional fatal nervous twitch.
      if (b.twitch && Math.random() < b.twitch && now - b.redAt > 1000) { move(step * 0.8, 0); log(cfg.name, "twitched on red 😬"); }
    }
  }, TICK);
  return b;
}

BOTS.forEach((c, i) => setTimeout(() => mkBot(c), i * 700));
log("RLGL bots connecting to", URL);
